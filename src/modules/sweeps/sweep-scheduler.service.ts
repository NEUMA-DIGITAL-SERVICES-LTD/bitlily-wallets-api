import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import { DepositAddress } from '../../database/entities/deposit-address.entity';
import { CustodyAccount } from '../../database/entities/custody-account.entity';
import { SweepService } from './sweep.service';
import { NotifierService } from '../notifications/notifier.service';
import { errMsg } from '../../common/errors';

/** Consecutive failures before an address pages ops via sweep.failed. */
const FAIL_ALERT_THRESHOLD = 3;

/**
 * Automatic fund consolidation. Deposits land on per-user/per-order
 * addresses; if nobody sweeps them, the treasury starves and withdrawals
 * fail at broadcast (the ledger debit reverses — no funds lost, but the
 * client sees broken sends). This keeps the pot funded without ops
 * babysitting.
 *
 * Candidate rule: `creditedAmount > 0`. The deposit poller rebaselines
 * creditedAmount to the post-sweep balance, so the field is effectively
 * "confirmed, not yet swept" — and it picks re-deposits back up
 * automatically. Zero extra chain reads for selection.
 *
 * Safety rules:
 *  - Sequential + capped per cycle — KMS serializes signing, but same-
 *    sender sends (EVM gas pumps from treasury) still want serialization.
 *  - Treasury/base custody addresses are NEVER candidates — sweeping the
 *    pot into itself burns fees; on SOL it would try to move every user's
 *    shared deposits once per watch row.
 *  - Amount capped at creditedAmount — only confirmed value moves; a
 *    deposit still confirming is out of scope for the spend.
 *  - BadRequestException = expected skip (in-flight, dust, zero balance);
 *    anything else counts toward the sweep.failed ops alert.
 */
@Injectable()
export class SweepSchedulerService {
  private readonly logger = new Logger(SweepSchedulerService.name);
  private readonly failures = new Map<string, number>();
  private running = false;

  constructor(
    @InjectRepository(DepositAddress)
    private readonly addresses: Repository<DepositAddress>,
    @InjectRepository(CustodyAccount)
    private readonly custody: Repository<CustodyAccount>,
    private readonly sweeps: SweepService,
    private readonly config: ConfigService,
    private readonly notifier: NotifierService,
  ) {}

  @Cron('*/15 * * * *')
  async run(): Promise<void> {
    if (this.config.get('sweep.autoEnabled') !== true) return;
    if (this.config.get('tatum.useKms') !== true) return;
    if (this.running) return; // a slow cycle must not stack sends on itself
    this.running = true;
    try {
      await this.sweepCandidates();
    } catch (e) {
      this.logger.error(`Auto-sweep cycle failed: ${errMsg(e)}`);
    } finally {
      this.running = false;
    }
  }

  private async sweepCandidates(): Promise<void> {
    const min = this.config.get<Record<string, string>>('sweep.minBalance') ?? {};
    const cap = this.config.get<number>('sweep.maxPerCycle') ?? 20;

    const custodyRows = await this.custody.find();
    const selfSweep = new Set<string>();
    for (const c of custodyRows) {
      for (const a of [c.treasuryAddress, c.baseAddress]) {
        if (a) selfSweep.add(a);
      }
    }

    const candidates = await this.addresses.find({
      where: { creditedAmount: MoreThan('0') },
      order: { chain: 'ASC', createdAt: 'ASC' },
      // Over-fetch: skip/threshold filters trim before the cap counts.
      take: cap * 4,
    });

    let swept = 0;
    for (const dep of candidates) {
      if (swept >= cap) break;
      if (selfSweep.has(dep.address)) continue;
      const floor = parseFloat(min[dep.asset] ?? '0');
      if (parseFloat(dep.creditedAmount) < floor) continue;

      try {
        await this.sweeps.sweepAddress(dep.id, { maxAmount: dep.creditedAmount });
        this.failures.delete(dep.id);
        swept++;
      } catch (e) {
        if (e instanceof BadRequestException) continue; // expected skip
        const n = (this.failures.get(dep.id) ?? 0) + 1;
        this.failures.set(dep.id, n);
        this.logger.warn(
          `Auto-sweep ${dep.address} ${dep.asset} failed (${n}/${FAIL_ALERT_THRESHOLD}): ${errMsg(e)}`,
        );
        if (n >= FAIL_ALERT_THRESHOLD) {
          this.failures.delete(dep.id);
          try {
            await this.notifier.notifyEvent('sweep.failed', {
              depositAddressId: dep.id,
              address: dep.address,
              asset: dep.asset,
              chain: dep.chain,
              error: errMsg(e),
            });
          } catch (ne) {
            this.logger.warn(`sweep.failed notify failed: ${errMsg(ne)}`);
          }
        }
      }
    }
    if (swept > 0) this.logger.log(`Auto-sweep cycle: ${swept} address(es) consolidated`);
  }
}
