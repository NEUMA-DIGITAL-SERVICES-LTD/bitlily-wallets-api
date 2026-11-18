import { UnauthorizedException, NotFoundException } from '@nestjs/common';
import { KmsVerifyController } from './kms-verify.controller';

/**
 * The four-eye gate: the KMS daemon concatenates {externalUrl}/{txId} and
 * only a 2xx means "sign it". A token containing URL-unsafe characters
 * (base64 secrets carry '/' and '+') arrives as multiple path segments —
 * seen live killing every sweep until this route split the tail at the
 * LAST segment instead of assuming a single :token segment.
 */
describe('KmsVerifyController', () => {
  const pendingTx = {
    id: 'tx-1',
    direction: 'outbound',
    status: 'pending',
    raw: { kmsRequestId: 'req-abc' },
  };
  const SLASH_TOKEN = 'gCgGlwjkAfHjUF+rqNbHnZJXEdh0BMJspwVE++/pc0Vm8j5L7IY';

  let controller: KmsVerifyController;
  let txs: any;

  beforeEach(() => {
    txs = { find: jest.fn().mockResolvedValue([pendingTx]) };
    process.env.KMS_VERIFY_TOKEN = SLASH_TOKEN;
    controller = new KmsVerifyController(
      txs,
      { get: jest.fn().mockReturnValue(SLASH_TOKEN) } as any,
    );
  });

  afterEach(() => {
    delete process.env.KMS_VERIFY_TOKEN;
  });

  it('approves a plain /verify/:requestId call when the id matches a pending tx', async () => {
    delete process.env.KMS_VERIFY_TOKEN;
    controller = new KmsVerifyController(
      txs,
      { get: jest.fn().mockReturnValue(undefined) } as any,
    );
    await expect(
      controller.verify({ requestId: 'req-abc' } as any),
    ).resolves.toEqual({ ok: true });
  });

  it('approves /verify/:token/:requestId — single-segment token', async () => {
    process.env.KMS_VERIFY_TOKEN = 'tok';
    controller = new KmsVerifyController(
      txs,
      { get: jest.fn().mockReturnValue('tok') } as any,
    );
    await expect(
      controller.verify({ 0: 'tok/req-abc' } as any),
    ).resolves.toEqual({ ok: true });
  });

  it('approves a token containing slashes — last segment is the requestId', async () => {
    await expect(
      controller.verify({ 0: `${SLASH_TOKEN}/req-abc` } as any),
    ).resolves.toEqual({ ok: true });
  });

  it('401s a wrong token even when the requestId is real', async () => {
    await expect(
      controller.verify({ 0: 'wrong-tok/req-abc' } as any),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('404s an unknown request id — never sign what we did not originate', async () => {
    await expect(
      controller.verify({ 0: `${SLASH_TOKEN}/req-unknown` } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
