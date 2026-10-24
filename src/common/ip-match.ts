import * as ipaddr from 'ipaddr.js';

/**
 * IP allowlist matching for tenant/admin keys.
 *
 * Entries are CIDRs ONLY ('203.0.113.10/32', '2001:db8::/128'). A bare IP
 * never matches — the explicit prefix forces the author to say 'one host'
 * vs 'a range' instead of letting a typo'd host silently widen/narrow.
 * Mixed v4/v6 is handled — a v4 request can never match a v6 rule.
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
/**
 * Strict CIDR check for allowlist entries — used at config load (env) and at
 * write time (tenant allowedIps) so a malformed entry fails LOUDLY there
 * instead of silently never matching at request time.
 */
export function isCidrEntry(e: string): boolean {
  try {
    const [range, bits] = String(e).trim().split('/');
    if (bits === undefined) return false;
    const a = ipaddr.parse(range);
    const n = parseInt(bits, 10);
    const max = a.kind() === 'ipv4' ? 32 : 128;
    return Number.isInteger(n) && n >= 0 && n <= max;
  } catch {
    return false;
  }
}

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
      if (bits === undefined) return false; // bare IP — CIDR notation required
      const n = parseInt(bits, 10);
      return addr.kind() === 'ipv4'
        ? (addr as ipaddr.IPv4).match(r as ipaddr.IPv4, n)
        : (addr as ipaddr.IPv6).match(r as ipaddr.IPv6, n);
    } catch {
      return false;
    }
  });
}
