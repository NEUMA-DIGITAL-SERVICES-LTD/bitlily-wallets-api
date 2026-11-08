import { ipAllowed, isCidrEntry, normalizeAllowlistEntry } from './ip-match';

describe('normalizeAllowlistEntry', () => {
  it('canonicalizes a bare IPv4 to a /32 host route', () => {
    expect(normalizeAllowlistEntry('203.0.113.10')).toBe('203.0.113.10/32');
  });

  it('canonicalizes a bare IPv6 to a /128 host route', () => {
    expect(normalizeAllowlistEntry('2001:db8::1')).toBe('2001:db8::1/128');
  });

  it('passes CIDRs through unchanged', () => {
    expect(normalizeAllowlistEntry('203.0.113.0/24')).toBe('203.0.113.0/24');
    expect(normalizeAllowlistEntry('2001:db8::/32')).toBe('2001:db8::/32');
  });

  it('returns null for unparseable entries', () => {
    for (const bad of ['not-an-ip', '999.1.2.3', '10.0.0.0/33', '', '  ']) {
      expect(normalizeAllowlistEntry(bad)).toBeNull();
    }
  });
});

describe('isCidrEntry', () => {
  it('still rejects bare IPs — normalization happens upstream', () => {
    expect(isCidrEntry('203.0.113.10')).toBe(false);
    expect(isCidrEntry('203.0.113.10/32')).toBe(true);
  });
});

describe('ipAllowed', () => {
  it('matches a bare-IP entry against exactly that host', () => {
    expect(ipAllowed('203.0.113.10', ['203.0.113.10'])).toBe(true);
    expect(ipAllowed('203.0.113.11', ['203.0.113.10'])).toBe(false);
  });

  it('still matches CIDR ranges', () => {
    expect(ipAllowed('203.0.113.77', ['203.0.113.0/24'])).toBe(true);
    expect(ipAllowed('203.0.114.1', ['203.0.113.0/24'])).toBe(false);
  });

  it('never matches across address families', () => {
    expect(ipAllowed('2001:db8::1', ['203.0.113.0/24'])).toBe(false);
    expect(ipAllowed('203.0.113.1', ['2001:db8::/32'])).toBe(false);
  });

  it('treats unparseable entries as non-matching', () => {
    expect(ipAllowed('203.0.113.10', ['not-an-ip'])).toBe(false);
  });

  it('empty/absent lists are unrestricted', () => {
    expect(ipAllowed('203.0.113.10', [])).toBe(true);
    expect(ipAllowed('203.0.113.10', undefined)).toBe(true);
  });
});
