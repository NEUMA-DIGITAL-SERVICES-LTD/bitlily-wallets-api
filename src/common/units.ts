/**
 * Exact decimal ↔ base-unit conversion for on-chain amounts. parseFloat
 * arithmetic is not money-safe: 0.1 - 0.000021 = 0.099979000000000012 in
 * IEEE-754 (12 wei of phantom dust), and Number → String goes exponential
 * below 1e-6. Both break serialized transactions — value+gas can exceed
 * the real balance by a few wei and broadcast fails with
 * "insufficient funds" (seen live on BSC testnet).
 */

export function toUnits(decimal: string, decimals: number): bigint {
  const s = String(decimal).trim();
  if (/e/i.test(s)) {
    // Expand exponential notation before splitting — BigInt can't parse it.
    const [mantissa, expStr] = s.split(/e/i);
    const exp = parseInt(expStr, 10);
    const [w = '0', f = ''] = mantissa.split('.');
    const digits = w + f;
    const point = w.length + exp;
    const normalized =
      point <= 0
        ? `0.${'0'.repeat(-point)}${digits}`
        : point >= digits.length
          ? digits + '0'.repeat(point - digits.length)
          : `${digits.slice(0, point)}.${digits.slice(point)}`;
    return toUnits(normalized, decimals);
  }
  const neg = s.startsWith('-');
  const [whole = '0', frac = ''] = (neg ? s.slice(1) : s).split('.');
  const units = BigInt(whole + frac.padEnd(decimals, '0').slice(0, decimals));
  return neg ? -units : units;
}

export function fromUnits(units: bigint, decimals: number): string {
  const neg = units < 0n;
  const v = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  const out = frac ? `${whole}.${frac}` : whole.toString();
  return neg ? `-${out}` : out;
}
