import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { timingSafeEqual } from 'crypto';
import { ApiClient } from '../database/entities/api-client.entity';
import { ApiClientConfig } from '../config/configuration';
import { isCidrEntry } from './ip-match';

export interface ResolvedClient {
  appId: string;
  scopes: string[];
  /** CIDRs this key may be used from. Undefined/empty = unrestricted. */
  allowedIps?: string[];
  /**
   * false = withdrawals skip the ledger-balance gate (client backend is
   * the balance authority — fiat on-ramps). Debits still post.
   */
  enforceBalance: boolean;
}

export interface WebhookRoute {
  url: string;
  secret: string;
}

const CACHE_MS = 30_000;

/**
 * Tenant registry — the single place that answers "who does this key belong
 * to" and "where do this app's webhooks go". Sources, in order:
 *   1. env API_CLIENTS (ops-seeded, authoritative for its slugs)
 *   2. api_clients table (runtime-registered via /admin/clients, 30s cache)
 *   3. SERVICE_API_KEYS → the 'default' tenant (back-compat)
 */
@Injectable()
export class ClientsService {
  private cache: { at: number; rows: ApiClient[] } | null = null;

  constructor(
    @InjectRepository(ApiClient) private readonly repo: Repository<ApiClient>,
    private readonly config: ConfigService,
  ) {}

  async resolve(key: string): Promise<ResolvedClient | null> {
    if (!key) return null;
    const eq = (candidate: string) =>
      candidate.length === key.length &&
      timingSafeEqual(Buffer.from(key), Buffer.from(candidate));

    for (const c of this.config.get<ApiClientConfig[]>('service.clients') ?? []) {
      if (eq(c.apiKey)) {
        return {
          appId: c.slug,
          scopes: ['wallet'],
          allowedIps: c.allowedIps,
          enforceBalance: c.enforceBalance !== false,
        };
      }
    }
    for (const c of await this.dbClients()) {
      if (c.active && eq(c.apiKey)) {
        return {
          appId: c.slug,
          scopes: c.scopes?.length ? c.scopes : ['wallet'],
          allowedIps: c.allowedIps ?? undefined,
          enforceBalance: c.enforceBalance !== false,
        };
      }
    }
    for (const k of this.config.get<string[]>('service.apiKeys') ?? []) {
      if (eq(k)) {
        return { appId: 'default', scopes: ['wallet'], enforceBalance: true };
      }
    }
    return null;
  }

  /** Webhook route for a tenant — DB client wins over env, then global. */
  async routeFor(appId: string | null | undefined): Promise<WebhookRoute> {
    const db = (await this.dbClients()).find((c) => c.slug === appId && c.active);
    const env = (this.config.get<ApiClientConfig[]>('service.clients') ?? [])
      .find((c) => c.slug === appId);
    return {
      url: db?.webhookUrl ?? env?.webhookUrl ?? this.config.get('webhook.mainAppUrl') ?? '',
      secret: db?.webhookSecret ?? env?.webhookSecret ?? this.config.get('webhook.signingSecret') ?? '',
    };
  }

  /** Combined view for /admin/clients — env entries marked as such. */
  async list() {
    const env = (this.config.get<ApiClientConfig[]>('service.clients') ?? []).map((c) => ({
      slug: c.slug,
      name: c.name ?? null,
      source: 'env',
      keyTail: `…${c.apiKey.slice(-4)}`,
      scopes: ['wallet'],
      webhookConfigured: !!c.webhookUrl,
      allowedIps: c.allowedIps ?? null,
      enforceBalance: c.enforceBalance !== false,
      active: true,
    }));
    const db = (await this.dbClients(true)).map((c) => ({
      slug: c.slug,
      name: c.name,
      source: 'db',
      keyTail: `…${c.apiKey.slice(-4)}`,
      scopes: c.scopes,
      webhookConfigured: !!c.webhookUrl,
      allowedIps: c.allowedIps,
      enforceBalance: c.enforceBalance !== false,
      active: c.active,
    }));
    const envSlugs = new Set(env.map((e) => e.slug));
    return [...env, ...db.filter((d) => !envSlugs.has(d.slug))];
  }

  async create(input: {
    slug: string;
    name?: string;
    webhookUrl?: string;
    scopes?: string[];
    allowedIps?: string[];
    enforceBalance?: boolean;
  }): Promise<ApiClient> {
    this.assertValidIps(input.allowedIps);
    const apiKey = `ck_${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const webhookSecret = `whsec_${crypto.randomUUID().replaceAll('-', '')}`;
    const row = await this.repo.save(
      this.repo.create({ ...input, apiKey, webhookSecret }),
    );
    this.cache = null;
    return row;
  }

  async update(slug: string, patch: Partial<ApiClient>, rotate = false) {
    const row = await this.repo.findOne({ where: { slug } });
    if (!row) return null;
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.webhookUrl !== undefined) row.webhookUrl = patch.webhookUrl;
    if (patch.active !== undefined) row.active = patch.active;
    if (patch.scopes !== undefined) row.scopes = patch.scopes;
    if (patch.allowedIps !== undefined) {
      this.assertValidIps(patch.allowedIps);
      row.allowedIps = patch.allowedIps;
    }
    if (patch.enforceBalance !== undefined) {
      row.enforceBalance = patch.enforceBalance;
    }
    if (rotate) {
      row.apiKey = `ck_${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
      row.webhookSecret = `whsec_${crypto.randomUUID().replaceAll('-', '')}`;
    }
    this.cache = null;
    return this.repo.save(row);
  }

  /**
   * Validate entries at write time — Swagger/JSON callers can send anything
   * (observed: literal "string" placeholders). An unparseable entry stored
   * would fail-closed at the guard and lock the client out of every IP.
   */
  private assertValidIps(cidrs: string[] | null | undefined): void {
    for (const e of cidrs ?? []) {
      // CIDR notation required — a single host needs its explicit /32 or
      // /128 suffix. Bare IPs are rejected so 'host vs range' is always
      // stated, never implied.
      if (!isCidrEntry(e)) {
        throw new BadRequestException(
          `allowedIps entry '${e}' is not a valid CIDR — a single host needs its explicit suffix (e.g. "203.0.113.10/32" or "2001:db8::1/128")`,
        );
      }
    }
  }

  private async dbClients(fresh = false): Promise<ApiClient[]> {
    if (!fresh && this.cache && Date.now() - this.cache.at < CACHE_MS) {
      return this.cache.rows;
    }
    const rows = await this.repo.find();
    this.cache = { at: Date.now(), rows };
    return rows;
  }
}
