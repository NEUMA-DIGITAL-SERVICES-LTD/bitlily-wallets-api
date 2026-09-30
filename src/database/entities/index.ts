export { Wallet } from './wallet.entity';
export { WalletAccount } from './wallet-account.entity';
export { DepositAddress } from './deposit-address.entity';
export { Transaction } from './transaction.entity';
export { LedgerEntry } from './ledger-entry.entity';
export { WebhookEvent } from './webhook-event.entity';

import { Wallet } from './wallet.entity';
import { WalletAccount } from './wallet-account.entity';
import { DepositAddress } from './deposit-address.entity';
import { Transaction } from './transaction.entity';
import { LedgerEntry } from './ledger-entry.entity';
import { WebhookEvent } from './webhook-event.entity';

export const ALL_ENTITIES = [
  Wallet,
  WalletAccount,
  DepositAddress,
  Transaction,
  LedgerEntry,
  WebhookEvent,
];
