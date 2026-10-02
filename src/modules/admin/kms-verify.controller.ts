import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
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
 * Public by design — KMS has no API key; configure the daemon's external
 * checks URL to {base}/api/v1/kms/verify. Rate-limit at the edge in prod.
 */
@ApiTags('kms')
@Controller('api/v1/kms')
export class KmsVerifyController {
  constructor(
    @InjectRepository(Transaction)
    private readonly txs: Repository<Transaction>,
  ) {}

  @Get('verify/:requestId')
  @Public()
  async verify(@Param('requestId') requestId: string) {
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
