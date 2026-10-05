// Check a transaction before Key 1 signs it.
//
// The Botwallet server builds every Solana transaction the agent co-signs.
// Before computing the partial signature, decode the message and make sure it
// does only what the agent asked for. Anything else is refused, so a
// compromised or impersonated server can't use Key 1 to move more money, or a
// different token, than the agent agreed to.
//
// checkTransferMessage applies the rules of the Agent CLI's txcheck package
// (packages/cli-go/solana/txcheck), which apps/sign applies too, and all three
// run the same test vectors (tests/fixtures/txcheck-vectors.json):
//   1. Legacy message, every length in its shortest form, no account listed
//      twice, no bytes after the instructions.
//   2. Exactly two signers: Botwallet's fee payer first, then the wallet,
//      which may be a read-only signer.
//   3. Only these instructions:
//      - Associated Token Account Create or CreateIdempotent of a USDC
//        account, paid by the fee payer, for an owner other than the wallet,
//        and paid into by one of the transfers. At most two.
//      - Token program Transfer authorized by the wallet, with neither the
//        source nor the destination being the wallet's own address.
//      No compute budget, no TransferChecked, no other program: the server
//      builds none of them.
//   4. One or two transfers. The first is the payment: into the recipient's
//      associated USDC account, for an amount in the agreed range. The second,
//      if any, is the fee: from the same token account as the payment, for at
//      most the quoted fee. The Token program refuses a transfer between
//      accounts of different tokens, so the payment's USDC destination makes
//      its source a USDC account, and the fee shares that source. The source
//      itself is not pinned: servers before Oct 2026 paid from the first USDC
//      account Solana listed for the wallet.
// transferExpectation turns what the agent agreed to (ExpectedTransfer, from
// utils/signing-check.ts) into the range and fee cap checked here: the x402
// rounding allowances, as in the CLI, and a fee ceiling.

import {
  parseLegacyMessage, associatedTokenAddress, bytesEqual, decodeAddress, readU64LE, usdcMintFor,
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID,
  type LegacyMessage,
} from './message.js';

export type MismatchCode = 'TRANSACTION_MISMATCH' | 'WALLET_MISMATCH';

/** Key 1 refused to sign. `message` says why. Nothing was signed or sent. */
export class TransactionCheckError extends Error {
  readonly code: MismatchCode;

  constructor(reason: string, code: MismatchCode = 'TRANSACTION_MISMATCH') {
    super(reason);
    this.name = 'TransactionCheckError';
    this.code = code;
  }
}

function mismatch(reason: string): never {
  throw new TransactionCheckError(reason);
}

export type TransferKind = 'payment' | 'withdrawal' | 'x402';

/** What the agent agreed to send. Amounts are in USDC base units (6 decimals). */
export interface ExpectedTransfer {
  kind: TransferKind;
  /** Network the server says it runs on ('mainnet-beta' or 'devnet'); picks the pinned USDC mint. */
  network: string;
  /** What the recipient gets. */
  amount: bigint;
  /**
   * When true, `amount` is the exact amount rounded up to a whole cent (x402
   * prices as the server reports them), so the payment may be up to 0.009999
   * USDC less.
   */
  amountRoundedUpToCent?: boolean;
  /** The recipient's wallet address. */
  recipient: string;
  /**
   * The fee the agent was quoted. The fee transfer may not be more than this
   * (for x402, this plus X402_FEE_ROUNDING) or the ceiling. No quote, no fee.
   */
  quotedFee?: bigint;
}

/** What checkTransferMessage holds a message to. Amounts are in USDC base units. */
export interface TransferExpectation {
  /** Network name; picks the pinned USDC mint. */
  network: string;
  /** The recipient's wallet address: the payment goes into its associated USDC account. */
  recipient: string;
  /** The payment's amount range. minAmount is above zero. */
  minAmount: bigint;
  maxAmount: bigint;
  /** The largest fee transfer. */
  maxFee: bigint;
}

// Botwallet's published fees are 1% (at least $0.01) on payments and paid API
// calls and 3% on withdrawals, plus $0.25 when the recipient's USDC account has
// to be set up. The ceiling is well above that, so a fee change on the server
// doesn't stop payments, but a server can't take much more than it quoted.
const FEE_CEILING_BPS: Record<TransferKind, bigint> = { payment: 500n, x402: 500n, withdrawal: 1000n };
const FEE_ALLOWANCE = 500_000n; // $0.50: room for the minimum fee and account setup

// Paid API prices are reported in whole cents, rounded up from the API's price
// in base units, which is what the merchant gets.
const X402_PRICE_ROUNDING = 9_999n;

// Paid API fees are quoted in whole cents. Servers before Oct 2026 built the fee
// transfer from the API's exact price in base units (rounded up), up to half a
// cent more than the quote: $1.49 at 1% is quoted as $0.01, and the transfer was
// $0.0149. Key 1 allows one cent over the quote, as the CLI does.
const X402_FEE_ROUNDING = 10_000n;

/** The largest fee Key 1 signs for, whatever the server quotes. */
export function feeCeiling(kind: TransferKind, amount: bigint): bigint {
  return (amount * FEE_CEILING_BPS[kind] + 9_999n) / 10_000n + FEE_ALLOWANCE;
}

/**
 * A USD amount as the API takes or reports it (rounded to cents, like the
 * server's dollarsToCents) in USDC base units. Null for anything that isn't a
 * positive amount.
 */
export function usdToBaseUnits(usd: unknown): bigint | null {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return null;
  return BigInt(Math.round(usd * 100)) * 10_000n;
}

/** The range and fee cap `expected` allows, as the CLI works them out for the same figures. */
export function transferExpectation(expected: ExpectedTransfer): TransferExpectation {
  const maxAmount = expected.amount;
  let minAmount = maxAmount;
  if (expected.amountRoundedUpToCent) {
    minAmount = maxAmount >= X402_PRICE_ROUNDING ? maxAmount - X402_PRICE_ROUNDING : 0n;
  }
  let maxFee = 0n;
  if (expected.quotedFee !== undefined) {
    const quoted = expected.quotedFee + (expected.kind === 'x402' ? X402_FEE_ROUNDING : 0n);
    const ceiling = feeCeiling(expected.kind, maxAmount);
    maxFee = quoted < ceiling ? quoted : ceiling;
  }
  return { network: expected.network, recipient: expected.recipient, minAmount, maxAmount, maxFee };
}

interface Transfer {
  source: Uint8Array;
  destination: Uint8Array;
  amount: bigint;
}

/**
 * Throws TransactionCheckError unless `message` moves only `expected` out of
 * `wallet`. `wallet` is the group key the signature is made for.
 */
export function verifyTransferMessage(message: Uint8Array, wallet: Uint8Array, expected: ExpectedTransfer): void {
  checkTransferMessage(message, wallet, transferExpectation(expected));
}

/**
 * Throws TransactionCheckError unless `message` is a payment `exp` describes,
 * from `wallet`, by the rules at the top of this file.
 */
export function checkTransferMessage(message: Uint8Array, wallet: Uint8Array, exp: TransferExpectation): void {
  const mint = decodeAddress(usdcMintFor(exp.network) ?? mismatch(`unknown network "${exp.network}"`))!;
  const recipient = decodeAddress(exp.recipient) ?? mismatch('recipient is not a Solana address');
  if (exp.maxAmount <= 0n) mismatch('amount is zero');
  if (exp.minAmount <= 0n || exp.minAmount > exp.maxAmount || exp.maxFee < 0n) mismatch('agreed amounts are not valid');

  let msg: LegacyMessage;
  try {
    msg = parseLegacyMessage(message);
  } catch (e) {
    mismatch(`unreadable transaction: ${(e as Error).message}`);
  }

  const keys = msg.accountKeys;
  // Botwallet's fee payer signs first; the wallet is the only other signer. The
  // wallet may be a read-only signer (as other Solana libraries build it); the
  // fee payer can't be.
  if (msg.numRequiredSignatures !== 2 || msg.numReadonlySigned > 1) mismatch('expected two signers');
  if (new Set(keys.map(k => k.join(','))).size !== keys.length) mismatch('an account is listed twice');
  if (!bytesEqual(keys[1], wallet)) mismatch('the wallet is not the second signer');

  const tokenProgram = decodeAddress(TOKEN_PROGRAM_ID)!;
  const ataProgram = decodeAddress(ASSOCIATED_TOKEN_PROGRAM_ID)!;
  const systemProgram = decodeAddress(SYSTEM_PROGRAM_ID)!;

  const transfers: Transfer[] = [];
  const created: Uint8Array[] = [];

  for (const ix of msg.instructions) {
    const program = keys[ix.programIndex];
    const accounts = ix.accounts.map(i => keys[i]);

    if (bytesEqual(program, ataProgram)) {
      // Create (empty or 0) or CreateIdempotent (1) of a USDC account, paid by the
      // fee payer: [payer, account, owner, mint, system program, token program]
      if (ix.data.length > 1 || (ix.data.length === 1 && ix.data[0] > 1)) mismatch('account instruction other than create');
      if (accounts.length !== 6) mismatch('account setup with unexpected accounts');
      if (ix.accounts[0] !== 0) mismatch('account setup not paid by the fee payer');
      const [, account, owner, accountMint, system, token] = accounts;
      if (!bytesEqual(accountMint, mint)) mismatch('account setup for another token');
      if (!bytesEqual(system, systemProgram) || !bytesEqual(token, tokenProgram)) {
        mismatch('account setup with unexpected programs');
      }
      if (bytesEqual(owner, wallet)) mismatch('account setup for the wallet');
      if (!bytesEqual(account, associatedTokenAddress(owner, mint))) mismatch('account setup for an unexpected address');
      created.push(account);
      if (created.length > 2) mismatch('more than two accounts set up');
    } else if (bytesEqual(program, tokenProgram)) {
      // Only a plain Transfer (3): [source, destination, authority] + u64 amount
      if (ix.data.length !== 9 || ix.data[0] !== 3 || accounts.length !== 3) {
        mismatch('token instruction other than a transfer');
      }
      const [source, destination, authority] = accounts;
      if (!bytesEqual(authority, wallet)) mismatch('transfer not authorized by the wallet');
      if (bytesEqual(source, wallet) || bytesEqual(destination, wallet)) mismatch('wallet used as a token account');
      transfers.push({ source, destination, amount: readU64LE(ix.data, 1) });
    } else {
      mismatch('instruction for an unexpected program');
    }
  }

  if (transfers.length === 0) mismatch('no transfer');
  if (transfers.length > 2) mismatch('unexpected extra transfer');

  // The first transfer is the payment: the amount, into the recipient's own USDC account
  const [payment, fee] = transfers;
  if (!bytesEqual(payment.destination, associatedTokenAddress(recipient, mint))) {
    mismatch("the payment does not go to the recipient's USDC account");
  }
  if (payment.amount < exp.minAmount || payment.amount > exp.maxAmount) mismatch('amount differs from the agreed amount');

  // The only other movement allowed is the fee, from the same account
  if (fee) {
    if (!bytesEqual(fee.source, payment.source)) mismatch('fee paid from a different account');
    if (fee.amount > exp.maxFee) mismatch('fee is higher than quoted');
  }

  if (created.some(c => !transfers.some(t => bytesEqual(t.destination, c)))) mismatch('unexpected account setup');
}
