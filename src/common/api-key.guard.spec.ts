import { UnauthorizedException } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';

/**
 * Tenant boundary: the API key isn't just auth — it's identity. The guard
 * must resolve a key to the owning app slug or reject; a key that maps to
 * nothing must never reach a wallet.
 */
describe('ApiKeyGuard tenancy', () => {
  const config: any = {
    get: (k: string) =>
      k === 'service.clients'
        ? [{ slug: 'acme', apiKey: 'acme-key-1234', webhookUrl: 'https://acme.example/hook' }]
        : k === 'service.apiKeys'
          ? ['legacy-key-1']
          : undefined,
  };
  const reflector: any = { getAllAndOverride: () => false };
  const guard = new ApiKeyGuard(config, reflector);

  const ctxFor = (key?: string) => {
    const req: any = { headers: key ? { 'x-api-key': key } : {} };
    return { req, ctx: { switchToHttp: () => ({ getRequest: () => req }), getHandler: () => null, getClass: () => null } as any };
  };

  it('resolves an API_CLIENTS key to its slug', () => {
    const { req, ctx } = ctxFor('acme-key-1234');
    expect(guard.canActivate(ctx)).toBe(true);
    expect(req.appId).toBe('acme');
  });

  it('maps legacy SERVICE_API_KEYS to the default tenant', () => {
    const { req, ctx } = ctxFor('legacy-key-1');
    expect(guard.canActivate(ctx)).toBe(true);
    expect(req.appId).toBe('default');
  });

  it('rejects unknown keys and never attaches an appId', () => {
    const { req, ctx } = ctxFor('wrong-key');
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    expect(req.appId).toBeUndefined();
  });

  it('rejects a missing header', () => {
    const { ctx } = ctxFor(undefined);
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });
});
