import { createHash } from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import { AdminKeyGuard } from './admin-key.guard';

const sha256hex = (s: string) =>
  createHash('sha256').update(s).digest('hex');

const ctxOf = (key?: string, ip = '10.0.0.8') =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({
        headers: key === undefined ? {} : { 'x-admin-key': key },
        ip,
      }),
    }),
  }) as any;

const makeGuard = (cfg: Record<string, any>) =>
  new AdminKeyGuard({ get: (k: string) => cfg[k] } as any);

describe('AdminKeyGuard', () => {
  describe('hashed keys (ADMIN_API_KEY_HASHES)', () => {
    const guard = () =>
      makeGuard({
        'service.adminApiKeys': [],
        'service.adminApiKeyHashes': [sha256hex('s3cret-admin-key')],
        'service.adminAllowedIps': [],
      });

    it('accepts the raw key whose sha256 hex is configured', () => {
      expect(guard().canActivate(ctxOf('s3cret-admin-key'))).toBe(true);
    });

    it('rejects a wrong key', () => {
      expect(() => guard().canActivate(ctxOf('wrong'))).toThrow(
        UnauthorizedException,
      );
    });

    it('rejects the hex digest itself — it is not the key', () => {
      expect(() =>
        guard().canActivate(ctxOf(sha256hex('s3cret-admin-key'))),
      ).toThrow(UnauthorizedException);
    });

    it('rejects a missing header', () => {
      expect(() => guard().canActivate(ctxOf())).toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('raw keys (ADMIN_API_KEYS — back-compat)', () => {
    const guard = () =>
      makeGuard({
        'service.adminApiKeys': ['plain-admin-key'],
        'service.adminApiKeyHashes': [],
        'service.adminAllowedIps': [],
      });

    it('still accepts the configured raw key', () => {
      expect(guard().canActivate(ctxOf('plain-admin-key'))).toBe(true);
    });

    it('rejects a wrong key', () => {
      expect(() => guard().canActivate(ctxOf('nope'))).toThrow(
        UnauthorizedException,
      );
    });
  });

  it('union: either list grants access', () => {
    const guard = makeGuard({
      'service.adminApiKeys': ['raw-one'],
      'service.adminApiKeyHashes': [sha256hex('hashed-two')],
      'service.adminAllowedIps': [],
    });
    expect(guard.canActivate(ctxOf('raw-one'))).toBe(true);
    expect(guard.canActivate(ctxOf('hashed-two'))).toBe(true);
    expect(() => guard.canActivate(ctxOf('neither'))).toThrow(
      UnauthorizedException,
    );
  });

  it('malformed hash entries can never match — and warn once', () => {
    const cfg = {
      'service.adminApiKeys': [],
      'service.adminApiKeyHashes': ['not-hex', sha256hex('real-key')],
      'service.adminAllowedIps': [],
    };
    const config = { get: (k: string) => cfg[k] } as any;
    const guard = new AdminKeyGuard(config);
    const warn = jest
      .spyOn((guard as any).logger, 'warn')
      .mockImplementation(() => undefined);
    expect(() => guard.canActivate(ctxOf('not-hex'))).toThrow(
      UnauthorizedException,
    );
    expect(guard.canActivate(ctxOf('real-key'))).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('IP gate still applies after a valid hashed key', () => {
    const guard = makeGuard({
      'service.adminApiKeys': [],
      'service.adminApiKeyHashes': [sha256hex('k')],
      'service.adminAllowedIps': ['203.0.113.0/24'],
    });
    expect(() => guard.canActivate(ctxOf('k', '10.0.0.8'))).toThrow(
      UnauthorizedException,
    );
    expect(guard.canActivate(ctxOf('k', '203.0.113.9'))).toBe(true);
  });

  it('fail-closed in production when neither var is set', () => {
    const guard = makeGuard({
      'service.adminApiKeys': [],
      'service.adminApiKeyHashes': [],
      'tatum.useKms': true,
    });
    expect(() => guard.canActivate(ctxOf('anything'))).toThrow(
      'ADMIN_API_KEYS / ADMIN_API_KEY_HASHES not configured',
    );
  });

  it('dev with nothing configured warns once and allows', () => {
    const prev = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      const cfg = {
        'service.adminApiKeys': [],
        'service.adminApiKeyHashes': [],
        'tatum.useKms': false,
      };
      const guard = new AdminKeyGuard({ get: (k: string) => cfg[k] } as any);
      const warn = jest
        .spyOn((guard as any).logger, 'warn')
        .mockImplementation(() => undefined);
      expect(guard.canActivate(ctxOf('x'))).toBe(true);
      expect(guard.canActivate(ctxOf('x'))).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      if (prev !== undefined) process.env.NODE_ENV = prev;
    }
  });
});
