import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { Repository } from 'typeorm';
import { Transaction } from '../../database/entities/transaction.entity';
import { getAsset } from '../../config/assets';
import {
  BLOCKCHAIN_PROVIDER,
  BlockchainProvider,
} from '../../providers/provider.interface';
import { NotifierService } from '../notifications/notifier.service';
import { errMsg } from '../../common/errors';

/**
 * Outbound transaction status sweeper.
 *
 * sendTransaction records status='pending' at broadcast time; nothing on the
 * happy path advances it. Without this job every payout would report
 * "pending" forever — a support-ticket generator for Bitlily's ops team.
 * Each tick re-fetches pending outbound txids, derives confirmations from
 * the chain tip, and marks confirmed once the threshold is met.
 *
 * Transactions broadcast but never visible on-chain (dropped, replaced)
 * are marked 'failed' after FAIL_AFTER_MS — conservative because provider
 * propagation can lag.
 */
const FAIL_AFTER_MS = 60 * 60 * 1000;

@Injectable()
export class OutboundStatusService {
  private readonly logger = new Logger(OutboundStatusService.name);
  private running = false;

  constructor(
    @InjectRepository(Transaction)
    private readonly txs: Repository<Transaction>,
    @Inject(BLOCKCHAIN_PROVIDER) private readonly provider: BlockchainProvider,
    private readonly notifier: NotifierService,
    private readonly config: ConfigService,
  ) {}

  @Cron('*/2 * * * *')
  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const pending = await this.txs.find({
        where: { direction: 'outbound', status: 'pending' },
        order: { createdAt: 'ASC' },
        take: 100,
      });
      for (const tx of pending) await this.refresh(tx);
    } finally {
      this.running = false;
    }
  }

  private async refresh(tx: Transaction): Promise<void> {
    // Synthetic txids are never on-chain. poll:* are inbound detections;
    // pending:* are outbound rows created before the real txid is known —
    // one that stays pending:* means the process died between debit and
    // broadcast; the row exists for ops reconciliation, not chain lookup.
    if (!tx.txid || tx.txid.startsWith('poll:') || tx.txid.startsWith('pending:')) return;
    const asset = getAsset(tx.asset);
    try {
      const chainTx = await this.provider.getTransaction(
        tx.txid,
        tx.chain as any,
        asset,
      );
      if (!chainTx) {
        if (Date.now() - tx.createdAt.getTime() > FAIL_AFTER_MS) {
          tx.status = 'failed';
          await this.txs.save(tx);
          await this.notifier.notify('withdrawal.failed', tx);
          this.logger.warn(`tx ${tx.id} (${tx.txid}) never appeared on-chain — failed`);
        }
        return;
      }
      // Providers may only report "mined" (confirmations=1) — always refine
      // from the chain tip when a blockNumber is known, same as the
      // webhook path.
      if (chainTx.blockNumber != null) {
        try {
          const head = await this.provider.getLatestBlock(tx.chain as any);
          if (head > 0) {
            chainTx.confirmations = Math.max(0, head - chainTx.blockNumber + 1);
          }
        } catch { /* keep provider-reported value */ }
      }
      tx.confirmations = chainTx.confirmations;
      tx.blockNumber = chainTx.blockNumber;
      tx.fee = chainTx.fee ?? tx.fee;
      const required = this.requiredConfirmations(tx.chain);
      tx.requiredConfirmations = required;
      if (chainTx.confirmations >= required && tx.status !== 'confirmed') {
        tx.status = 'confirmed';
        await this.txs.save(tx);
        await this.notifier.notify('withdrawal.confirmed', tx);
        this.logger.log(`tx ${tx.id} confirmed (${chainTx.confirmations} confs)`);
        return;
      }
      await this.txs.save(tx);
    } catch (e) {
      this.logger.warn(`Outbound refresh failed for tx ${tx.id}: ${errMsg(e)}`);
    }
  }

  private requiredConfirmations(chain: string): number {
    const map = this.config.get<Record<string, number>>('confirmations') ?? {};
    return map[chain] ?? 1;
  }
}
