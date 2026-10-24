import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';

export class CreateWalletDto {
  @ApiProperty({ description: 'The user ID in the main Bitlily application' })
  @IsString()
  @IsNotEmpty()
  externalUserId: string;

  @ApiPropertyOptional({
    description:
      'Assets to provision PERMANENT deposit addresses for, e.g. ' +
      '["TRX","USDT_TRON"]. Idempotent per chain — first call derives, ' +
      'later calls return the same address; same-chain assets share one ' +
      'address. OMIT to provision every supported chain at once — the ' +
      'response always carries the wallet\'s full permanent address set.',
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  ensure?: string[];
}

export class WalletQueryDto {
  @ApiPropertyOptional({
    description:
      'Comma-separated sections to fold into the response: ' +
      'balances, addresses, transactions. Default: balances,addresses.',
    default: 'balances,addresses',
  })
  @IsString()
  @IsOptional()
  include?: string;

  @ApiPropertyOptional({ description: 'Transactions page size (when include=transactions)', default: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  txLimit?: number;

  @ApiPropertyOptional({ description: 'Transactions page number, 1-based (when include=transactions)', default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  txPage?: number;

  @ApiPropertyOptional({
    description:
      'Scope the WHOLE view to one chain, e.g. TRON — addresses, ' +
      'balances, and transactions all filter to that chain.',
  })
  @IsString()
  @IsOptional()
  chain?: string;

  @ApiPropertyOptional({
    description:
      'Restrict the transactions section to one asset code, e.g. ' +
      'USDT_TRON. Only applies when include contains transactions. ' +
      'Must agree with chain — a cross-chain pair is a 400.',
  })
  @IsString()
  @IsOptional()
  asset?: string;

  @ApiPropertyOptional({
    description:
      'Look up a transaction by YOUR reference (order/payout id) — the ' +
      'check-before-retry path after a 409 or a timed-out send. Only ' +
      'applies when include contains transactions.',
  })
  @IsString()
  @IsOptional()
  reference?: string;
}

export class GenerateAddressDto {
  @ApiProperty({ description: 'Asset code, e.g. BTC, USDT_TRON' })
  @IsString()
  @IsNotEmpty()
  asset: string;

  @ApiPropertyOptional({
    description:
      'Client reference (order/invoice ID) for Selly-style per-payment addresses',
  })
  @IsString()
  @IsOptional()
  reference?: string;

  @ApiPropertyOptional({
    description:
      'Minutes until this address expires (stops deposit polling). Omit → service default (DEPOSIT_ADDRESS_TTL_MINUTES).',
    default: 60,
  })
  @IsInt()
  @Min(1)
  @Max(10080)
  @IsOptional()
  expiresInMinutes?: number;

  @ApiPropertyOptional({
    description:
      'Exchange-style deposit address: get-or-create the wallet\'s single ' +
      'permanent address for this chain — first call derives it, every ' +
      'later call returns the same address. For top-up UX; for per-order ' +
      'addresses, omit and use expiresInMinutes/reference instead.',
  })
  @IsBoolean()
  @IsOptional()
  persistent?: boolean;
}

export class WatchAddressDto {
  @ApiProperty({ description: 'The deposit address to (re)watch' })
  @IsString()
  @IsNotEmpty()
  address: string;

  @ApiProperty({ description: 'Asset code to watch for, e.g. BTC, USDC_ETH' })
  @IsString()
  @IsNotEmpty()
  asset: string;

  @ApiPropertyOptional({
    description:
      'Minutes until the watch expires again. Omit → permanent ' +
      '(recommended — a recovery watch that expires re-hides the deposit ' +
      'it was created to catch).',
  })
  @IsInt()
  @Min(1)
  @Max(10080)
  @IsOptional()
  expiresInMinutes?: number;
}

/** One permanent deposit-address row in a wallet response. */
export class DepositAddressViewDto {
  @ApiProperty({ example: 'tb1qhy06eu2z3fwjd92j9v5wndx0y80qhpxnyxcfn8' })
  address: string;

  @ApiProperty({ example: 'BTC' })
  chain: string;

  @ApiProperty({
    type: [String],
    example: ['BTC'],
    description: 'Asset codes that settle to this address on this chain.',
  })
  assets: string[];

  @ApiPropertyOptional({ nullable: true, example: null })
  expiresAt?: string | null;

  @ApiPropertyOptional({
    example: 'bl-jw5pxfcb',
    description:
      'Shared-custody attribution memo — present on shared addresses ' +
      '(SOL/USDC_SOL). Deposits MUST carry this value as a Solana Memo ' +
      'program instruction or they cannot be attributed to this wallet.',
  })
  memo?: string;

  @ApiPropertyOptional({
    example: true,
    description:
      'true = deposits to `address` credit this wallet ONLY when the ' +
      'transaction carries `memo`. Absent = unique address, no memo needed.',
  })
  memoRequired?: boolean;
}

export class BalanceViewDto {
  @ApiProperty({ example: 'SOL' })
  asset: string;

  @ApiProperty({
    example: '0.001500000000000000',
    description: 'Confirmed balance as a decimal string (ledger truth).',
  })
  balance: string;
}

export class WalletViewDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ description: 'Your tenant slug (the X-API-Key owner)' })
  appId: string;

  @ApiProperty({ description: 'Your user id — the key you created the wallet with' })
  externalUserId: string;

  @ApiProperty()
  createdAt: string;

  @ApiProperty()
  updatedAt: string;

  @ApiPropertyOptional({ type: [DepositAddressViewDto] })
  addresses?: DepositAddressViewDto[];

  @ApiPropertyOptional({ type: [BalanceViewDto] })
  balances?: BalanceViewDto[];
}


