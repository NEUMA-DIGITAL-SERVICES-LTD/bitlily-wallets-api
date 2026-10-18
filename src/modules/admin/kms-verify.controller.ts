import { Controller, Get, NotFoundException, Param, Query, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Transaction } from '../../database/entities/transaction.entity';
import { Public } from '../../common/api-key.guard';

/**
 * KMS four-eye verification — Tatum KMS can be configured to call an
 * external URL before signing each pending transaction; only a 2xx means
 * "sign it". We return 200 iff the request id matches a pending outbound
 * transaction WE created (raw.kmsRequestId), so the daemon can never be
 * tricked into signing a transfer our service didn't originate.
 *
 * Public by design — KMS has no API key. Set KMS_VERIFY_TOKEN and embed it
 * in the daemon's --externalUrl path so the endpoint can't be probed for
 * pending-withdrawal existence. Also rate-limit at the edge in prod.
 */
@ApiExcludeController()
@Controller('api/v1/kms')
export class KmsVerifyController {
  constructor(
    @InjectRepository(Transaction)
    private readonly txs: Repository<Transaction>,
    private readonly config: ConfigService,
  ) {}

  /**
   * KMS builds the check URL by string-concatenating `{externalUrl}/{txId}` —
   * a query param in the daemon's --externalUrl would end up BEFORE the txid
   * and break matching. So the shared token travels as a path segment:
   * externalUrl = {base}/api/v1/kms/verify/{KMS_VERIFY_TOKEN}
   *            → KMS calls {base}/api/v1/kms/verify/{KMS_VERIFY_TOKEN}/{txId}
   * A tokenless verify/{txId} route stays for dev when KMS_VERIFY_TOKEN unset.
   */
  @Get(['verify/:requestId', 'verify/:token/:requestId'])
  @Public()
  async verify(
    @Param('requestId') requestId: string,
    @Param('token') pathToken?: string,
    @Query('token') queryToken?: string,
  ) {
    const expected =
      process.env.KMS_VERIFY_TOKEN ?? this.config.get<string>('kmsVerifyToken');
    if (expected) {
      const supplied = pathToken ?? queryToken;
      if (supplied !== expected) throw new UnauthorizedException();
    }
    const rows = await this.txs.find({
      where: { direction: 'outbound', status: 'pending' },
      take: 200,
      order: { createdAt: 'DESC' },
    });
    const match = rows.find(
      (t) => (t.raw as any)?.kmsRequestId === requestId || t.id === requestId,
    );
    if (!match) throw new NotFoundException('unknown signing request');
    return { ok: true };
  }
}
