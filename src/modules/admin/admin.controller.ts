import { Body, Controller, Get, Param, Patch, Post, Query, BadRequestException, NotFoundException, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiExcludeEndpoint,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/error-response.dto';
import { TransactionViewDto } from '../transactions/transactions.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IsArray, IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { CustodyAccount } from '../../database/entities/custody-account.entity';
import { AddressPool } from '../../database/entities/address-pool.entity';
import { TransactionsService } from '../transactions/transactions.service';
import { AdminKeyGuard } from '../../common/admin-key.guard';
import { Public } from '../../common/api-key.guard';
import { ClientsService } from '../../common/clients.service';
import { addressPayload } from '../../common/address-payload';
import { Inject } from '@nestjs/common';
import { BLOCKCHAIN_PROVIDER, BlockchainProvider } from '../../providers/provider.interface';
import { WalletsService } from '../wallets/wallets.service';
import { Wallet } from '../../database/entities/wallet.entity';
import { WatchAddressDto } from '../wallets/wallets.dto';

class CreateClientDto {
  @ApiProperty({ description: 'Tenant slug — stamped on wallets.app_id' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-z0-9-]+$/, { message: 'slug must be lowercase letters, digits, hyphens' })
  slug: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ description: 'Where this app receives webhook events' })
  @IsString()
  @IsOptional()
  webhookUrl?: string;

  @ApiPropertyOptional({
    description: '["wallet"] = full tenant access; ["read"] = shared endpoints only',
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  scopes?: string[];

  @ApiPropertyOptional({
    description:
      'CIDRs/IPs this key may be used from, e.g. ["203.0.113.0/24"]. ' +
      'Omit/empty = unrestricted. A leaked key is dead outside this list.',
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  allowedIps?: string[];

  @ApiPropertyOptional({
    description:
      'false = this client\'s backend owns balance checks (fiat-funded ' +
      'withdrawals, off-chain credits). Debits still post; negative ' +
      'wallet balances become the app\'s liability toward custody. ' +
      'Default true — the service gates withdrawals on ledger balance.',
  })
  @IsBoolean()
  @IsOptional()
  enforceBalance?: boolean;
}

class UpdateClientDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  webhookUrl?: string;

  @ApiPropertyOptional()
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  scopes?: string[];

  @ApiPropertyOptional({
    description:
      'CIDRs/IPs this key may be used from. [] clears the restriction. ' +
      'Omitted = leave unchanged.',
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  allowedIps?: string[];

  @ApiPropertyOptional({ description: 'false suspends the key without deleting history' })
  @IsBoolean()
  @IsOptional()
  active?: boolean;

  @ApiPropertyOptional({
    description:
      'false = client backend owns balance checks (fiat on-ramps). ' +
      'Omitted = leave unchanged.',
  })
  @IsBoolean()
  @IsOptional()
  enforceBalance?: boolean;

  @ApiPropertyOptional({
    description: 'true regenerates apiKey + webhookSecret — return them once, old key dies',
  })
  @IsBoolean()
  @IsOptional()
  rotate?: boolean;
}

class CreditDepositDto {
  @ApiProperty({ description: 'Tenant slug owning the destination wallet' })
  @IsString()
  @IsNotEmpty()
  appId: string;

  @ApiProperty({ description: 'The tenant-side user id to credit' })
  @IsString()
  @IsNotEmpty()
  externalUserId: string;
}

// ---- response DTOs (wire shapes; entities never leave the service) ----

export class CustodyViewDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'SOL' }) chain: string;
  @ApiPropertyOptional({ nullable: true }) xpub?: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'Base/shared address for account-model chains' }) baseAddress?: string | null;
  @ApiProperty({ description: 'KMS signatureId of the enrolled wallet — an identifier, not key material' }) secretRef: string;
  @ApiPropertyOptional({ nullable: true }) treasuryAddress?: string | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

export class PoolImportResultDto {
  @ApiProperty() chain: string;
  @ApiProperty({ description: 'Entries received in this request' }) received: number;
  @ApiProperty({ description: 'Newly inserted rows — duplicates are skipped' }) imported: number;
}

export class PoolStatsDto {
  @ApiProperty() chain: string;
  @ApiProperty({ description: 'Unassigned addresses available for new wallets' }) free: number;
  @ApiProperty() assigned: number;
}

export class ClientListItemDto {
  @ApiProperty() slug: string;
  @ApiPropertyOptional({ nullable: true }) name?: string | null;
  @ApiProperty({ enum: ['env', 'db'], description: 'env = defined in CLIENTS JSON (API-immutable); db = PATCHable' }) source: string;
  @ApiProperty({ description: 'Last 4 chars of the API key — the full key is never listed' }) keyTail: string;
  @ApiProperty({ type: [String] }) scopes: string[];
  @ApiProperty() webhookConfigured: boolean;
  @ApiPropertyOptional({ nullable: true, type: [String] }) allowedIps?: string[] | null;
  @ApiProperty() enforceBalance: boolean;
  @ApiProperty() active: boolean;
}

export class ClientCredentialsDto {
  @ApiProperty() slug: string;
  @ApiPropertyOptional({ nullable: true }) name?: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'Present ONLY on create or after rotate:true — never re-emitted otherwise' }) apiKey?: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'Same lifecycle as apiKey' }) webhookSecret?: string | null;
  @ApiProperty({ type: [String] }) scopes: string[];
  @ApiPropertyOptional({ nullable: true, type: [String] }) allowedIps?: string[] | null;
  @ApiProperty() enforceBalance: boolean;
  @ApiPropertyOptional() active?: boolean;
}

export class UnattributedDepositViewDto {
  @ApiProperty() id: string;
  @ApiProperty() chain: string;
  @ApiProperty() asset: string;
  @ApiProperty() txid: string;
  @ApiProperty() address: string;
  @ApiProperty() amount: string;
  @ApiProperty() status: string;
  @ApiProperty() confirmations: number;
  @ApiPropertyOptional({ nullable: true }) blockNumber?: number | null;
  @ApiPropertyOptional({ nullable: true, description: 'Memo carried by the deposit, if any' }) memo?: string | null;
  @ApiPropertyOptional({ nullable: true }) detectedVia?: string | null;
  @ApiProperty() createdAt: Date;
}

export class WatchedAddressViewDto {
  @ApiProperty() address: string;
  @ApiProperty() chain: string;
  @ApiProperty() asset: string;
  @ApiProperty({ enum: ['active', 'expired'] }) status: string;
  @ApiPropertyOptional({ nullable: true }) expiresAt?: Date | null;
}

class PoolEntryDto {
  @ApiProperty({
    description:
      'KMS signatureId owning this address — for SOL, one private-key ' +
      'wallet per address (output of `generatemanagedwallet SOL`)',
  })
  @IsString()
  @IsNotEmpty()
  signatureId: string;

  @ApiPropertyOptional({ description: 'Derivation index — mnemonic-type pool entries only; null for SOL' })
  @IsInt()
  @IsOptional()
  derivationIndex?: number;

  @ApiProperty({ description: 'The deposit address itself' })
  @IsString()
  @IsNotEmpty()
  address: string;
}

class ImportPoolDto {
  @ApiProperty({ description: 'Chain code — currently SOL' })
  @IsString()
  @IsNotEmpty()
  chain: string;

  @ApiProperty({
    type: [PoolEntryDto],
    description:
      'Pre-minted {signatureId, address} pairs generated on the KMS host ' +
      '(scripts/sol-pool-seed.js — one `generatemanagedwallet` per entry; ' +
      'key material never leaves KMS). Duplicates skipped — re-running ' +
      'a seed is safe.',
  })
  @IsArray()
  entries: PoolEntryDto[];
}

class EnrollCustodyDto {
  @ApiProperty({ description: 'Chain code, e.g. BTC, ETH, SOL' })
  @IsString()
  @IsNotEmpty()
  chain: string;

  @ApiPropertyOptional({ description: 'xpub from tatum-kms generatemanagedwallet' })
  @IsString()
  @IsOptional()
  xpub?: string;

  @ApiPropertyOptional({ description: 'Base address for account-model chains (SOL)' })
  @IsString()
  @IsOptional()
  baseAddress?: string;

  @ApiProperty({ description: 'KMS signatureId returned by generatemanagedwallet' })
  @IsString()
  @IsNotEmpty()
  signatureId: string;

  @ApiProperty({
    description:
      'Pair proof — output of `tatum-kms getaddress {signatureId} 0` on ' +
      'the KMS host. Verified against the index-0 address derived from ' +
      'the submitted xpub/baseAddress: a signatureId belonging to a ' +
      'different wallet is REFUSED, because it would silently sign ' +
      'deposits it cannot spend (enroll looks fine, withdrawals break).',
  })
  @IsString()
  @IsNotEmpty()
  kmsAddress: string;

  @ApiPropertyOptional({
    description: 'Sweep destination — defaults to the custody wallet index-0 address',
  })
  @IsString()
  @IsOptional()
  treasuryAddress?: string;

  @ApiPropertyOptional({
    description:
      'REQUIRED to replace an existing signatureId — without it, a ' +
      're-enroll updates non-key fields only (protects against silent key ' +
      'rotation: a mismatched signatureId signs the wrong wallet).',
  })
  @IsBoolean()
  @IsOptional()
  rotate?: boolean;
}

/**
 * Custody enrollment — ops-only endpoints registering the KMS master wallet
 * per chain. Flow: operator runs `tatum-kms generatemanagedwallet {chain}`
 * on the KMS host (mnemonic never leaves KMS), then posts the returned
 * xpub + signatureId here. Wallet creation under TATUM_USE_KMS fails
 * without a row.
 */
@ApiTags('admin')
// Dev-facing ops: tenant self-service, withdrawal approvals, deposit
// recovery. Infra-only routes (custody, address-pool) carry
// @ApiExcludeEndpoint — hidden from the client-facing spec.
@ApiSecurity({ 'x-admin-key': [] })
@Public()
@UseGuards(AdminKeyGuard)
@Controller('api/v1/admin')
export class AdminController {
  constructor(
    @InjectRepository(CustodyAccount)
    private readonly custody: Repository<CustodyAccount>,
    @InjectRepository(AddressPool)
    private readonly pool: Repository<AddressPool>,
    private readonly transactions: TransactionsService,
    private readonly config: ConfigService,
    private readonly clients: ClientsService,
    @Inject(BLOCKCHAIN_PROVIDER) private readonly provider: BlockchainProvider,
    private readonly walletOps: WalletsService,
    @InjectRepository(Wallet)
    private readonly wallets: Repository<Wallet>,
  ) {}

  @Post('wallets/:id/watch')
  @ApiOperation({
    summary:
      'OPS recovery — re-watch an address for an asset on any tenant wallet. ' +
      'Used for late payments to expired addresses and wrong-asset sends. ' +
      'Moved out of the client surface: this is operator tooling.',
  })
  @ApiOkResponse({ type: WatchedAddressViewDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto, description: 'Address is not on this wallet / wrong chain' })
  async watchWalletAddress(@Param('id') id: string, @Body() dto: WatchAddressDto): Promise<WatchedAddressViewDto> {
    const wallet = await this.wallets.findOne({ where: { id } });
    if (!wallet) throw new NotFoundException(`Wallet ${id} not found`);
    const d = await this.walletOps.watchAddress(
      id, wallet.appId, dto.address, dto.asset, dto.expiresInMinutes,
    );
    return { address: d.address, chain: d.chain, asset: d.asset, status: d.status, expiresAt: d.expiresAt };
  }

  // Bootstrap ceremony — ops runs it once per chain on the KMS host, not
  // something the integrating dev calls. Hidden from the client-facing docs.
  @Post('custody')
  @ApiExcludeEndpoint()
  @ApiOperation({
    summary:
      'Bootstrap-only: enroll a KMS-managed wallet for a chain — once per ' +
      'chain (revisit only on key rotation or adding a chain), then every ' +
      'POST /wallets derives from it. One of `xpub` (HD chains) or ' +
      '`baseAddress` (account-model chains like SOL) is required — both ' +
      'absent → 400. `kmsAddress` is the pair proof: output of `tatum-kms ' +
      'getaddress {signatureId} 0`, verified against the submitted ' +
      'xpub/baseAddress — a signatureId from a different wallet is refused.',
  })
  @ApiOkResponse({ type: CustodyViewDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto, description: 'Missing xpub+baseAddress, pair-proof mismatch, or signatureId conflict without rotate' })
  async enroll(@Body() dto: EnrollCustodyDto) {
    if (!dto.xpub && !dto.baseAddress) {
      throw new BadRequestException('xpub or baseAddress required');
    }
    const chain = dto.chain.toUpperCase();

    // Pair proof: the signatureId must derive the SAME index-0 address as
    // the enrolled xpub/baseAddress. Without this, a mismatched pair
    // enrolls cleanly — deposits keep deriving from xpub A while
    // withdrawals sign with wallet B's keys, so every send fails at
    // broadcast and deposited funds are stranded. Verification is a
    // payload-hash compare, so KMS's mainnet-serialized `getaddress`
    // output (bc1…/L…) still matches our testnet-derived address.
    const expected = dto.xpub
      ? await this.provider.generateDepositAddress(
          { chain: chain as any, xpub: dto.xpub },
          0,
        )
      : dto.baseAddress!;
    const given = addressPayload(chain, dto.kmsAddress);
    const want = addressPayload(chain, expected);
    if (!given || !want || given !== want) {
      throw new BadRequestException(
        `Custody pair proof failed for ${chain}: ` +
        `signatureId ${dto.signatureId} derives "${dto.kmsAddress}" ` +
        `(getaddress index 0) but the submitted ${dto.xpub ? 'xpub' : 'baseAddress'} ` +
        `derives "${expected}". They belong to different wallets — refusing ` +
        `to enroll. Run 'tatum-kms getaddress ${dto.signatureId} 0' on the ` +
        `KMS host and pass its output as kmsAddress.`,
      );
    }

    const existing = await this.custody.findOne({ where: { chain } });
    if (existing) {
      if (existing.secretRef !== dto.signatureId && !dto.rotate) {
        throw new BadRequestException(
          `${chain} custody already enrolled with a different signatureId — ` +
          `pass rotate:true to replace it. Silent rotation would sign all ` +
          `future deposits with the WRONG wallet's keys.`,
        );
      }
      existing.xpub = dto.xpub ?? existing.xpub;
      existing.baseAddress = dto.baseAddress ?? existing.baseAddress;
      existing.secretRef = dto.signatureId;
      existing.treasuryAddress = dto.treasuryAddress ?? existing.treasuryAddress;
      return this.custody.save(existing);
    }
    return this.custody.save(
      this.custody.create({
        chain,
        xpub: dto.xpub ?? null,
        baseAddress: dto.baseAddress ?? null,
        secretRef: dto.signatureId,
        treasuryAddress: dto.treasuryAddress ?? null,
      }),
    );
  }

  @Get('custody')
  @ApiExcludeEndpoint()
  @ApiOperation({ summary: 'List enrolled custody wallets per chain' })
  @ApiOkResponse({ type: [CustodyViewDto] })
  list() {
    return this.custody.find();
  }

  /**
   * Bulk-import pre-derived custody addresses into the pool. Derivation
   * MUST happen on the KMS host (getaddress is CLI-only, key material
   * never leaves it) — this endpoint only records the results.
   */
  @Post('address-pool')
  @ApiExcludeEndpoint() // infra-only — pool seeding happens on the KMS host
  @ApiOperation({
    summary:
      'Import pre-minted deposit addresses (SOL: ed25519 has no xpub — ' +
      'scripts/sol-pool-seed.js mints one KMS keypair per address on the ' +
      'KMS host). Idempotent per address.',
  })
  @ApiCreatedResponse({ type: PoolImportResultDto })
  async importPool(@Body() dto: ImportPoolDto) {
    const chain = dto.chain.toUpperCase();
    let imported = 0;
    for (const e of dto.entries ?? []) {
      const r = await this.pool
        .createQueryBuilder()
        .insert()
        .values({
          chain,
          signatureId: e.signatureId,
          derivationIndex: e.derivationIndex ?? null,
          address: e.address,
        })
        .orIgnore()
        .execute();
      if (r.identifiers?.length) imported++;
    }
    return { chain, received: dto.entries?.length ?? 0, imported };
  }

  @Get('address-pool/stats')
  @ApiExcludeEndpoint() // infra-only
  @ApiOperation({
    summary:
      'Pool health per chain — free vs assigned counts. Low `free` = run ' +
      'the pool seed script before SOL_UNIQUE_DEPOSITS wallet provisioning ' +
      'starts failing 503 (no memo fallback by design).',
  })
  @ApiOkResponse({ type: [PoolStatsDto] })
  async poolStats() {
    const rows: { chain: string; free: string; assigned: string }[] =
      await this.pool.query(
        `SELECT chain,
                COUNT(*) FILTER (WHERE wallet_account_id IS NULL) AS free,
                COUNT(*) FILTER (WHERE wallet_account_id IS NOT NULL) AS assigned
         FROM address_pool GROUP BY chain ORDER BY chain`,
      );
    return rows.map((r) => ({
      chain: r.chain,
      free: Number(r.free),
      assigned: Number(r.assigned),
    }));
  }

  @Get('clients')
  @ApiOperation({
    summary:
      'List registered API clients (tenants) — slug, name, webhook URL ' +
      'presence. Keys never leave this endpoint.',
  })
  @ApiOkResponse({ type: [ClientListItemDto] })
  listClients() {
    return this.clients.list();
  }

  @Post('clients')
  @ApiOperation({
    summary:
      'Register a new API client (tenant). Returns apiKey + webhookSecret ' +
      'ONCE — they are not retrievable afterwards.',
  })
  @ApiCreatedResponse({ type: ClientCredentialsDto })
  async createClient(@Body() dto: CreateClientDto) {
    const row = await this.clients.create(dto);
    return {
      slug: row.slug,
      name: row.name,
      apiKey: row.apiKey,
      webhookSecret: row.webhookSecret,
      scopes: row.scopes,
      allowedIps: row.allowedIps,
      enforceBalance: row.enforceBalance,
    };
  }

  @Patch('clients/:slug')
  @ApiOperation({
    summary:
      'Update a client — webhookUrl, scopes, active, or rotate:true to ' +
      'regenerate credentials (old key dies immediately)',
  })
  @ApiOkResponse({ type: ClientCredentialsDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'Unknown slug — env-defined clients are API-immutable by design' })
  async updateClient(@Param('slug') slug: string, @Body() dto: UpdateClientDto) {
    const row = await this.clients.update(slug, dto, dto.rotate === true);
    if (!row) throw new NotFoundException(`Client ${slug} not found`);
    // Credentials surface only when just-minted — re-emitting stored
    // secrets on every PATCH would void the "returned once" contract.
    const minted = dto.rotate === true;
    return {
      slug: row.slug,
      name: row.name,
      apiKey: minted ? row.apiKey : null,
      webhookSecret: minted ? row.webhookSecret : null,
      scopes: row.scopes,
      allowedIps: row.allowedIps,
      enforceBalance: row.enforceBalance,
      active: row.active,
    };
  }

  @Post('withdrawals/:id/approve')
  @ApiOperation({
    summary: 'Approve a parked requires_approval withdrawal — broadcasts it',
  })
  @ApiOkResponse({ type: TransactionViewDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'Unknown or non-parked withdrawal' })
  approve(@Param('id') id: string) {
    return this.transactions.approveWithdrawal(id).then((tx) => this.transactions.toView(tx));
  }

  @Post('withdrawals/:id/reject')
  @ApiOperation({
    summary: 'Reject a parked withdrawal — reverses the ledger debit',
  })
  @ApiOkResponse({ type: TransactionViewDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'Unknown or non-parked withdrawal' })
  reject(@Param('id') id: string) {
    return this.transactions.rejectWithdrawal(id).then((tx) => this.transactions.toView(tx));
  }

  @Get('deposits/unattributed')
  @ApiOperation({
    summary:
      'OPS review queue — verified on-chain deposits to shared custody ' +
      'addresses (SOL) whose memo resolved no wallet. These are real ' +
      'funds awaiting manual attribution; they credit no one until ' +
      'POST /deposits/:id/credit runs.',
  })
  @ApiQuery({ name: 'chain', required: false, description: 'Narrow to one chain (e.g. SOL)' })
  @ApiOkResponse({ type: [UnattributedDepositViewDto] })
  listUnattributed(@Query('chain') chain?: string) {
    return this.transactions.listUnattributedDeposits(chain);
  }

  @Post('deposits/:id/credit')
  @ApiOperation({
    summary:
      'Manually credit an unattributed shared-address deposit to a ' +
      'specific wallet. Explicit target (appId + externalUserId), ' +
      'idempotent — an already-attributed deposit returns 409 rather ' +
      'than double-crediting.',
  })
  @ApiCreatedResponse({ type: TransactionViewDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'Unknown deposit id or no wallet for (appId, externalUserId)' })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'Deposit already attributed' })
  creditDeposit(@Param('id') id: string, @Body() dto: CreditDepositDto) {
    return this.transactions.creditUnattributedDeposit(
      id, dto.appId, dto.externalUserId,
    ).then((tx) => this.transactions.toView(tx));
  }
}
