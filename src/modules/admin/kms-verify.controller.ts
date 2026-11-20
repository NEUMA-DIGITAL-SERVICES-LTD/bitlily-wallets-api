import { Controller, Get, NotFoundException, Query, Req, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
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
  @Get(['verify/:requestId', 'verify/*'])
  @Public()
  async verify(@Req() req: Request, @Query('token') queryToken?: string) {
    // The daemon string-concats externalUrl + '/' + txId — a token with
    // '/' or other URL-unsafe chars arrives as MULTIPLE path segments.
    // Parse req.path rather than route params: wildcard capture keys
    // differ across Nest/Express versions (params['0'] vs splat), and a
    // missed key silently becomes supplied=undefined → 401 for a CORRECT
    // token (seen live). Split rule: LAST segment = requestId, the rest = token.
    const idx = req.path.indexOf('/verify/');
    const tail = idx >= 0 ? req.path.slice(idx + '/verify/'.length) : '';
    const parts = tail.split('/').filter(Boolean);
    const requestId = parts.length
      ? decodeURIComponent(parts.pop()!)
      : undefined;
    const pathToken = parts.length
      ? parts.map(decodeURIComponent).join('/')
      : undefined;
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
