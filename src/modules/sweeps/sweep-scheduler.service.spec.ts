import { BadRequestException } from '@nestjs/common';
import { SweepSchedulerService } from './sweep-scheduler.service';

/**
 * The auto-sweep scheduler is the treasury's supply line. These tests pin
 * the candidate rules (confirmed-credited only, never custody self-sends),
 * the safety cap, the per-cycle bound, and the failure → ops-alert path —
 * a broken scheduler starves withdrawals silently, which is why the rules
 * matter more than the cron.
 */
describe('SweepSchedulerService', () => {
  const dep = (over: Partial<any> = {}) => ({
    id: 'dep-1',
    address: 'T-addr',
    chain: 'TRON',
    asset: 'TRX',
    creditedAmount: '100',
    createdAt: new Date(),
    ...over,
  });

  let service: SweepSchedulerService;
  let addresses: any;
  let custody: any;
  let txs: any;
  let sweeps: any;
  let notifier: any;
  let config: any;

  const configOn = {
    'sweep.autoEnabled': true,
    'tatum.useKms': true,
    'sweep.minBalance': {},
    'sweep.maxPerCycle': 20,
  };

  beforeEach(() => {
    addresses = { find: jest.fn().mockResolvedValue([]), update: jest.fn() };
    custody = { find: jest.fn().mockResolvedValue([]) };
    txs = { find: jest.fn().mockResolvedValue([]) };
    sweeps = {
      sweepAddress: jest.fn().mockResolvedValue({ txids: ['t1'], amount: '95' }),
    };
    notifier = { notifyEvent: jest.fn() };
    config = { get: jest.fn((k: string) => (configOn as any)[k]) };
    service = new SweepSchedulerService(
      addresses,
      custody,
      txs,
      sweeps,
      config,
      notifier,
    );
  });

  it('does nothing when auto-sweep is disabled', async () => {
    config.get.mockImplementation((k: string) =>
      k === 'sweep.autoEnabled' ? false : (configOn as any)[k]);
    await service.run();
    expect(addresses.find).not.toHaveBeenCalled();
  });

  it('does nothing without KMS — dev mode can never sign sweeps', async () => {
    config.get.mockImplementation((k: string) =>
      k === 'tatum.useKms' ? false : (configOn as any)[k]);
    await service.run();
    expect(addresses.find).not.toHaveBeenCalled();
  });

  it('sweeps credited addresses, capped at the credited amount', async () => {
    addresses.find.mockResolvedValue([dep()]);
    await service.run();
    expect(sweeps.sweepAddress).toHaveBeenCalledWith('dep-1', { maxAmount: '100' });
  });

  it('optimistically decrements creditedAmount by the sent amount', async () => {
    const d = dep({ creditedAmount: '100' });
    addresses.find.mockResolvedValue([d]);
    await service.run();
    expect(addresses.update).toHaveBeenCalledWith('dep-1', { creditedAmount: '5.000000' });
  });

  it('leaves the watermark alone when only a gas pump went out', async () => {
    sweeps.sweepAddress.mockResolvedValue({ txids: [], pendingKms: ['k1'] });
    addresses.find.mockResolvedValue([dep()]);
    await service.run();
    expect(addresses.update).not.toHaveBeenCalled();
  });

  it('skips rows whose sweep or gas-pump is already in flight', async () => {
    txs.find.mockResolvedValue([
      { reference: 'sweep:dep-1' },
      { reference: 'gas-pump:dep-3' },
    ]);
    addresses.find.mockResolvedValue([
      dep({ id: 'dep-1' }),
      dep({ id: 'dep-2', address: 'T-2' }),
      dep({ id: 'dep-3', address: 'T-3' }),
    ]);
    await service.run();
    expect(sweeps.sweepAddress).toHaveBeenCalledTimes(1);
    expect(sweeps.sweepAddress).toHaveBeenCalledWith('dep-2', { maxAmount: '100' });
  });

  it('never sweeps a custody treasury/base address into itself', async () => {
    custody.find.mockResolvedValue([
      { chain: 'SOL', treasuryAddress: 'sol-treasury', baseAddress: 'sol-base' },
    ]);
    addresses.find.mockResolvedValue([
      dep({ id: 'd1', address: 'sol-treasury', chain: 'SOL', asset: 'SOL' }),
      dep({ id: 'd2', address: 'sol-base', chain: 'SOL', asset: 'USDC_SOL' }),
      dep({ id: 'd3', address: 'T-user', chain: 'TRON', asset: 'TRX' }),
    ]);
    await service.run();
    expect(sweeps.sweepAddress).toHaveBeenCalledTimes(1);
    expect(sweeps.sweepAddress).toHaveBeenCalledWith('d3', { maxAmount: '100' });
  });

  it('skips balances below the per-asset floor', async () => {
    config.get.mockImplementation((k: string) =>
      k === 'sweep.minBalance' ? { TRX: '500' } : (configOn as any)[k]);
    addresses.find.mockResolvedValue([dep({ creditedAmount: '100' })]);
    await service.run();
    expect(sweeps.sweepAddress).not.toHaveBeenCalled();
  });

  it('caps sweeps per cycle — the overflow waits for the next run', async () => {
    config.get.mockImplementation((k: string) =>
      k === 'sweep.maxPerCycle' ? 2 : (configOn as any)[k]);
    addresses.find.mockResolvedValue(
      [1, 2, 3].map((i) => dep({ id: `d${i}`, address: `T-${i}` })),
    );
    await service.run();
    expect(sweeps.sweepAddress).toHaveBeenCalledTimes(2);
  });

  it('treats BadRequest as an expected skip, not a failure', async () => {
    sweeps.sweepAddress.mockRejectedValue(
      new BadRequestException('Sweep already in flight for T-addr'),
    );
    addresses.find.mockResolvedValue([dep()]);
    await service.run();
    await service.run();
    await service.run();
    expect(notifier.notifyEvent).not.toHaveBeenCalled();
  });

  it('alerts ops after repeated real failures, then resets', async () => {
    sweeps.sweepAddress.mockRejectedValue(new Error('provider exploded'));
    addresses.find.mockResolvedValue([dep()]);
    await service.run();
    await service.run();
    expect(notifier.notifyEvent).not.toHaveBeenCalled();
    await service.run();
    expect(notifier.notifyEvent).toHaveBeenCalledWith(
      'sweep.failed',
      expect.objectContaining({ address: 'T-addr', asset: 'TRX' }),
    );
    // Counter resets after alerting — next failure starts the count again.
    await service.run();
    expect(notifier.notifyEvent).toHaveBeenCalledTimes(1);
  });

  it('a successful sweep clears the failure counter', async () => {
    addresses.find.mockResolvedValue([dep()]);
    sweeps.sweepAddress.mockRejectedValueOnce(new Error('x'));
    await service.run();
    sweeps.sweepAddress.mockResolvedValue({ txids: [] });
    await service.run();
    sweeps.sweepAddress.mockRejectedValue(new Error('x'));
    await service.run();
    await service.run();
    expect(notifier.notifyEvent).not.toHaveBeenCalled();
  });

  it('does not overlap cycles while one is still running', async () => {
    let release: () => void;
    sweeps.sweepAddress.mockImplementation(
      () => new Promise((r) => { release = () => r({ txids: [] }); }),
    );
    addresses.find.mockResolvedValue([dep()]);
    const first = service.run();
    await new Promise((r) => setImmediate(r));
    await service.run(); // re-entrant call must no-op
    release!();
    await first;
    expect(sweeps.sweepAddress).toHaveBeenCalledTimes(1);
  });
});
