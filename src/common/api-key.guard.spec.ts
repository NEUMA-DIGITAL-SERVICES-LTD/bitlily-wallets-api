import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';

/**
 * Tenant boundary: the API key isn't just auth — it's identity. The guard
 * must resolve a key to the owning app slug or reject; a key that maps to
 * nothing must never reach a wallet. Scope checks keep read-only keys off
 * money-moving routes.
 */
describe('ApiKeyGuard tenancy', () => {
  const clients: any = {
    resolve: async (key: string) =>
      key === 'acme-key-1234'
        ? { appId: 'acme', scopes: ['wallet'] }
        : key === 'read-key'
          ? { appId: 'readonly-feed', scopes: ['read'] }
          : key === 'legacy-key-1'
            ? { appId: 'default', scopes: ['wallet'] }
            : null,
  };
  const config: any = { get: () => undefined };
  const reflector: any = {
    getAllAndOverride: (key: string) =>
      key === 'requiredScope' ? reflector.requiredScope : undefined,
    requiredScope: undefined as string | undefined,
  };
  const guard = new ApiKeyGuard(config, reflector, clients);

  const ctxFor = (key?: string) => {
    const req: any = { headers: key ? { 'x-api-key': key } : {} };
    return { req, ctx: { switchToHttp: () => ({ getRequest: () => req }), getHandler: () => null, getClass: () => null } as any };
  };

  it('resolves a tenant key to its slug', async () => {
    const { req, ctx } = ctxFor('acme-key-1234');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.appId).toBe('acme');
  });

  it('maps legacy keys to the default tenant', async () => {
    const { req, ctx } = ctxFor('legacy-key-1');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.appId).toBe('default');
  });

  it('rejects unknown keys and never attaches an appId', async () => {
    const { req, ctx } = ctxFor('wrong-key');
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    expect(req.appId).toBeUndefined();
  });

  it('rejects a missing header', async () => {
    const { ctx } = ctxFor(undefined);
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('a read-scoped key passes general routes but is 403d on wallet routes', async () => {
    reflector.requiredScope = undefined;
    const general = ctxFor('read-key');
    await expect(guard.canActivate(general.ctx)).resolves.toBe(true);

    reflector.requiredScope = 'wallet';
    const wallet = ctxFor('read-key');
    await expect(guard.canActivate(wallet.ctx)).rejects.toThrow(ForbiddenException);
  });
});
