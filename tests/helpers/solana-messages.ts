// Solana messages for tests, built the way the Botwallet server builds them.
//
// buildServerTransfer is a port of buildPaymentTransaction in
// supabase/functions/bot/solana-helpers.ts without the RPC calls: same account
// order, header, instruction order and data. serverX402Fees is the fee math of
// handleX402Prepare in supabase/functions/bot/handlers/x402.ts. compileMessage
// builds any other legacy message, for the transactions a server must not be
// able to get signed.

import { sha256 } from '@noble/hashes/sha2';
import { base58 } from '@scure/base';
import {
  associatedTokenAddress,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
} from '../../src/solana/message.js';

export const USDC_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDC_DEVNET = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr';

/** A made-up but well-formed address for a test role. */
export function testAddress(label: string): string {
  return base58.encode(sha256(new TextEncoder().encode(`botwallet-test/${label}`)));
}

export function ata(owner: string, mint: string = USDC_MAINNET): string {
  return base58.encode(associatedTokenAddress(base58.decode(owner), base58.decode(mint)));
}

function compactU16(value: number): number[] {
  if (value < 128) return [value];
  if (value < 16384) return [(value & 0x7f) | 0x80, value >> 7];
  return [(value & 0x7f) | 0x80, ((value >> 7) & 0x7f) | 0x80, value >> 14];
}

function u64le(value: bigint): number[] {
  const out: number[] = [];
  for (let i = 0; i < 8; i++) out.push(Number((value >> BigInt(8 * i)) & 0xffn));
  return out;
}

/** SPL Token Transfer data (instruction 3), as createTransferInstruction writes it. */
export function transferData(amount: bigint): Uint8Array {
  return Uint8Array.from([3, ...u64le(amount)]);
}

/** SPL Token TransferChecked data (instruction 12). */
export function transferCheckedData(amount: bigint, decimals = 6): Uint8Array {
  return Uint8Array.from([12, ...u64le(amount), decimals]);
}

export interface TestInstruction {
  program: string;
  accounts: string[];
  data: Uint8Array;
}

export interface CompileOptions {
  /** Header values; defaults to two writable signers. */
  header?: [number, number, number];
  blockhash?: string;
}

/**
 * Serialize a legacy message. `keys` is the account list in order (signers
 * first); instructions refer to keys by address.
 */
export function compileMessage(keys: string[], instructions: TestInstruction[], options: CompileOptions = {}): Uint8Array {
  const index = (key: string) => {
    const i = keys.indexOf(key);
    if (i < 0) throw new Error(`account ${key} is not in the key list`);
    return i;
  };
  const bytes: number[] = [...(options.header ?? [2, 0, 0])];
  bytes.push(...compactU16(keys.length));
  for (const key of keys) bytes.push(...base58.decode(key));
  bytes.push(...base58.decode(options.blockhash ?? testAddress('blockhash')));
  bytes.push(...compactU16(instructions.length));
  for (const ix of instructions) {
    bytes.push(index(ix.program));
    bytes.push(...compactU16(ix.accounts.length));
    for (const a of ix.accounts) bytes.push(index(a));
    bytes.push(...compactU16(ix.data.length));
    bytes.push(...ix.data);
  }
  return Uint8Array.from(bytes);
}

export interface ServerTransferParams {
  feePayer: string;
  wallet: string;
  /** The wallet's USDC account; the server's own lookup returns the associated one. */
  fromTokenAccount?: string;
  toWallet: string;
  /** The recipient's USDC account; defaults to the associated one. */
  toTokenAccount?: string;
  toAccountExists?: boolean;
  feeCollection: string;
  feeCollectionAccountExists?: boolean;
  mint?: string;
  amount: bigint;
  fee: bigint;
}

/** The message buildPaymentTransaction builds for a payment, withdrawal or x402 call. */
export function buildServerTransfer(p: ServerTransferParams): Uint8Array {
  const mint = p.mint ?? USDC_MAINNET;
  const fromToken = p.fromTokenAccount ?? ata(p.wallet, mint);
  const toToken = p.toTokenAccount ?? ata(p.toWallet, mint);
  const feeAta = ata(p.feeCollection, mint);
  const needsRecipientAta = p.toAccountExists === false;
  const needsFeeCollectionAta = p.feeCollectionAccountExists === false;

  const keys: string[] = [];
  const add = (key: string) => {
    if (!keys.includes(key)) keys.push(key);
    return key;
  };

  add(p.feePayer);
  add(p.wallet);
  add(fromToken);
  add(toToken);
  add(feeAta);
  if (needsRecipientAta || needsFeeCollectionAta) {
    if (needsRecipientAta) add(p.toWallet);
    if (needsFeeCollectionAta) add(p.feeCollection);
    add(mint);
    add(SYSTEM_PROGRAM_ID);
    add(ASSOCIATED_TOKEN_PROGRAM_ID);
  }
  add(TOKEN_PROGRAM_ID);

  const writableUnsigned = new Set([fromToken, toToken, feeAta]);
  writableUnsigned.delete(p.feePayer);
  writableUnsigned.delete(p.wallet);
  const numReadonlyUnsigned = keys.length - 2 - writableUnsigned.size;

  const instructions: TestInstruction[] = [];
  if (needsRecipientAta) {
    instructions.push({
      program: ASSOCIATED_TOKEN_PROGRAM_ID,
      accounts: [p.feePayer, toToken, p.toWallet, mint, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID],
      data: Uint8Array.from([1]),
    });
  }
  if (needsFeeCollectionAta) {
    instructions.push({
      program: ASSOCIATED_TOKEN_PROGRAM_ID,
      accounts: [p.feePayer, feeAta, p.feeCollection, mint, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID],
      data: Uint8Array.from([1]),
    });
  }
  instructions.push({ program: TOKEN_PROGRAM_ID, accounts: [fromToken, toToken, p.wallet], data: transferData(p.amount) });
  instructions.push({ program: TOKEN_PROGRAM_ID, accounts: [fromToken, feeAta, p.wallet], data: transferData(p.fee) });

  return compileMessage(keys, instructions, { header: [2, 0, numReadonlyUnsigned] });
}

export interface X402Fees {
  /** amount_usdc in base units: the price rounded up to a whole cent. */
  reportedPrice: bigint;
  /** fee_usdc in base units, as x402_prepare and x402_confirm report it (whole cents). */
  quoted: bigint;
  /** The fee transfer x402_confirm built before Oct 2026 (metadata.fee_base_units); it now sends `quoted`. */
  transfer: bigint;
}

/**
 * The fees x402_prepare works out for an API price in base units: the quote
 * comes from calculatePlatformFee on the price in cents. Servers before Oct
 * 2026 built the fee transfer from Math.ceil(base units * fee rate), with no
 * minimum and no account setup fee.
 */
export function serverX402Fees(
  price: bigint,
  feeBps: number,
  opts: { minFeeCents?: number; recipientNeedsAccount?: boolean } = {},
): X402Fees {
  const amountBaseUnits = Number(price);
  const amountCents = Math.ceil(amountBaseUnits / 10_000);
  const platformFee = Math.max(Math.round(amountCents * feeBps / 10000), opts.minFeeCents ?? 1);
  const ataFee = opts.recipientNeedsAccount ? 25 : 0;
  const feeRate = feeBps / 10000;
  return {
    reportedPrice: BigInt(amountCents) * 10_000n,
    quoted: BigInt(platformFee + ataFee) * 10_000n,
    transfer: BigInt(Math.ceil(amountBaseUnits * feeRate)),
  };
}
