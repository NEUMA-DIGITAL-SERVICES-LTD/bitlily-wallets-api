import { parseErc20Transfers } from './evm-logs';

const TRANSFER =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const USDT_ETH = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const RECIPIENT = '0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be';

const log = (over: Partial<any> = {}) => ({
  address: USDT_ETH,
  topics: [
    TRANSFER,
    '0x00000000000000000000000028c6c06298d514db089934071355e5743bf21d60',
    `0x000000000000000000000000${RECIPIENT.slice(2)}`,
  ],
  // 500 USDT at 6 decimals
  data: '0x000000000000000000000000000000000000000000000000000000001dcd6500',
  ...over,
});

describe('parseErc20Transfers', () => {
  it('extracts recipient + human-unit amount at token decimals', () => {
    const out = parseErc20Transfers([log()], 6);
    expect(out).toEqual([
      { to: RECIPIENT, amount: '500', contract: USDT_ETH },
    ]);
  });

  it('handles fractional amounts without float error', () => {
    // 1.234567 USDC (1234567 units) — must not come back 1.2345670000000001
    const l = log({
      data: '0x' + (1234567).toString(16).padStart(64, '0'),
    });
    expect(parseErc20Transfers([l], 6)[0].amount).toBe('1.234567');
  });

  it('ignores non-Transfer logs and malformed entries', () => {
    const nonTransfer = log({ topics: ['0xdeadbeef'] });
    const noTopics = log({ topics: [] });
    expect(parseErc20Transfers([nonTransfer, noTopics], 6)).toEqual([]);
    expect(parseErc20Transfers(undefined, 6)).toEqual([]);
  });
});
