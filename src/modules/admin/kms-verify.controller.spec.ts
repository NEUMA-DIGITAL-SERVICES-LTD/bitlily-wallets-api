import { UnauthorizedException, NotFoundException } from '@nestjs/common';
import { KmsVerifyController } from './kms-verify.controller';

/**
 * The four-eye gate: the KMS daemon concatenates {externalUrl}/{txId} and
 * only a 2xx means "sign it". A token containing URL-unsafe characters
 * (base64 secrets carry '/' and '+') arrives as multiple path segments —
 * seen live killing every sweep until this route split the tail at the
 * LAST segment. Tests pass a req-shaped {path} exactly as Express hands it
 * over — mocking route params is what masked the original bug.
 */
describe('KmsVerifyController', () => {
  const pendingTx = {
    id: 'tx-1',
    direction: 'outbound',
    status: 'pending',
    raw: { kmsRequestId: 'req-abc' },
  };
  const SLASH_TOKEN = 'gCgGlwjkAfHjUF+rqNbHnZJXEdh0BMJspwVE++/pc0Vm8j5L7IY';
  const BASE = '/api/v1/kms/verify';

  let controller: KmsVerifyController;
  let txs: any;

  const make = (expected?: string) =>
    new KmsVerifyController(
      txs,
      { get: jest.fn().mockReturnValue(expected) } as any,
    );

  beforeEach(() => {
    txs = { find: jest.fn().mockResolvedValue([pendingTx]) };
    delete process.env.KMS_VERIFY_TOKEN;
    controller = make(SLASH_TOKEN);
  });

  it('approves a plain /verify/:requestId call — no token configured', async () => {
    controller = make(undefined);
    await expect(
      controller.verify({ path: `${BASE}/req-abc` } as any),
    ).resolves.toEqual({ ok: true });
  });

  it('approves a single-segment token', async () => {
    controller = make('tok');
    await expect(
      controller.verify({ path: `${BASE}/tok/req-abc` } as any),
    ).resolves.toEqual({ ok: true });
  });

  it('approves a token containing slashes — last segment is the requestId', async () => {
    await expect(
      controller.verify({ path: `${BASE}/${SLASH_TOKEN}/req-abc` } as any),
    ).resolves.toEqual({ ok: true });
  });

  it('decodes percent-encoded token segments', async () => {
    controller = make('a/b+c');
    await expect(
      controller.verify({ path: `${BASE}/a%2Fb%2Bc/req-abc` } as any),
    ).resolves.toEqual({ ok: true });
  });

  it('401s a wrong token even when the requestId is real', async () => {
    await expect(
      controller.verify({ path: `${BASE}/wrong-tok/req-abc` } as any),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('401s when the wildcard tail cannot be read — never silently approves', async () => {
    await expect(
      controller.verify({ path: '/api/v1/kms' } as any),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('404s an unknown request id — never sign what we did not originate', async () => {
    await expect(
      controller.verify({ path: `${BASE}/${SLASH_TOKEN}/req-unknown` } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
