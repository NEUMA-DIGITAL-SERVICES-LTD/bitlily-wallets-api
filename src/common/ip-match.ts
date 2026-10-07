import * as ipaddr from 'ipaddr.js';

/**
 * IP allowlist matching for tenant/admin keys.
 *
 * Entries are exact IPs ('203.0.113.10', '2001:db8::1') or CIDRs
 * ('203.0.113.0/24', '2001:db8::/32'). Mixed v4/v6 is handled —
 * a v4 request can never match a v6 rule and vice versa.
 *
 * Fail-closed: a list is set but the request IP or any entry can't be
 * parsed → that entry doesn't match; unparseable request IP → denied.
 * An empty/absent list means unrestricted (checked by callers).
 *
 * IMPORTANT: this is only as honest as req.ip. Behind a proxy, Express
 * must be told which hop to trust (TRUST_PROXY_HOPS) or clients can
 * spoof X-Forwarded-For past the allowlist. With trust proxy unset,
 * req.ip is the socket peer — honest but only usable when clients
 * connect directly.
 */
export function ipAllowed(
  reqIp: string | undefined,
  cidrs: readonly string[] | null | undefined,
): boolean {
  if (!cidrs?.length) return true;
  if (!reqIp) return false;
  // Express may report IPv6-mapped IPv4 peers ('::ffff:1.2.3.4') —
  // normalize so v4 allowlists match them.
  const norm = reqIp.startsWith('::ffff:') ? reqIp.slice(7) : reqIp;
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(norm);
  } catch {
    return false;
  }
  return cidrs.some((entry) => {
    try {
      const [range, bits] = String(entry).trim().split('/');
      if (!range) return false;
      const r = ipaddr.parse(range);
      if (addr.kind() !== r.kind()) return false;
      if (bits === undefined) {
        return addr.toNormalizedString() === r.toNormalizedString();
      }
      const n = parseInt(bits, 10);
      return addr.kind() === 'ipv4'
        ? (addr as ipaddr.IPv4).match(r as ipaddr.IPv4, n)
        : (addr as ipaddr.IPv6).match(r as ipaddr.IPv6, n);
    } catch {
      return false;
    }
  });
}
