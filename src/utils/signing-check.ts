// What Key 1 may sign for one transaction: the agent's own figures from the
// tool that started the transfer (utils/agreed-transfers.ts), with the
// server's confirm response filling in what the agent didn't say.

import { getWallet } from '../config/index.js';
import { TransactionCheckError, usdToBaseUnits, type ExpectedTransfer, type TransferKind } from '../solana/index.js';
import type { AgreedTransfer } from './agreed-transfers.js';

/** The wallet address Key 1 belongs to, from config.json, when it is recorded there. */
export function localWalletAddress(walletName: string): string | undefined {
  try {
    return getWallet(walletName)?.public_key || undefined;
  } catch {
    // No readable config.json (env-only setup): the message is checked against the group key
    return undefined;
  }
}

/**
 * The transfer Key 1 may sign, from what the agent agreed to (when this
 * session started the transfer) and the server's confirm response. The
 * agent's own figures win; the server's fill in what the agent didn't say.
 */
export function expectedTransfer(
  kind: TransferKind,
  confirm: Record<string, unknown>,
  agreed?: AgreedTransfer,
): ExpectedTransfer {
  const network = typeof confirm.network === 'string' ? confirm.network : '';
  if (!network) throw new TransactionCheckError('the server did not say which network the transaction is for');

  const amount = agreed?.amount ?? usdToBaseUnits(confirm.amount_usdc);
  if (amount === null || amount <= 0n) throw new TransactionCheckError('the server did not say how much is being sent');

  const declaredRecipient = [confirm.to_address, confirm.pay_to].find(
    (v): v is string => typeof v === 'string' && v !== '',
  );
  const recipient = agreed?.recipient ?? declaredRecipient;
  if (!recipient) throw new TransactionCheckError('the server did not say who receives this transfer');
  // No quote at all means no fee may be charged, as in the CLI
  const quotedFees = [agreed?.quotedFee, usdToBaseUnits(confirm.fee_usdc)]
    .filter((f): f is bigint => typeof f === 'bigint');

  return {
    kind,
    network,
    amount,
    // x402 amounts are reported in cents, rounded up from the exact base units
    amountRoundedUpToCent: agreed ? !!agreed.amountRoundedUpToCent : kind === 'x402',
    recipient,
    quotedFee: quotedFees.length > 0 ? quotedFees.reduce((a, b) => (a < b ? a : b)) : undefined,
  };
}
