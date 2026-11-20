// Error results for payments, withdrawals and paid API calls. Each says
// whether money may have moved, and carries the ids that find the transfer
// again.

import type { ToolResult } from '../types.js';
import type { TransactionCheckError } from '../solana/index.js';
import { errorPayload, errorResult } from '../utils/tool-result.js';
import { errorMessage } from '../utils/errors.js';

/** Ids that let the agent find a payment, withdrawal or paid API call again. */
export interface TransferRef {
  transaction_id?: string;
  withdrawal_id?: string;
  fetch_id?: string;
  idempotency_key?: string;
}

/**
 * The request may or may not have gone through, or money may have moved.
 * Tells the agent how to find out instead of trying again blindly.
 */
export function outcomeUnknownError(
  message: string,
  howToFix: string,
  ref: TransferRef,
  extra: Record<string, unknown> = {},
): ToolResult {
  return errorResult({
    error: true,
    code: 'OUTCOME_UNKNOWN',
    status: 'unknown',
    message,
    ...ref,
    how_to_fix: howToFix,
    ...extra,
  });
}

/**
 * Another request of this process is signing the same transfer right now
 * (signing-lock.ts). That request decides how it ends.
 */
export function alreadySigningError(
  what: string,
  howToFix: string,
  ref: TransferRef,
  extra: Record<string, unknown> = {},
): ToolResult {
  return outcomeUnknownError(`This ${what} is already being signed by another request.`, howToFix, ref, extra);
}

/**
 * A payment, withdrawal or paid API call stopped before any money moved.
 * Keeps the error's code and message and adds the ids. `howToFix`, when
 * given, replaces the error's own hint.
 */
export function notSentError(error: unknown, ref: TransferRef, howToFix?: string): ToolResult {
  return errorResult({
    ...errorPayload(error),
    sent: false,
    ...ref,
    ...(howToFix ? { how_to_fix: howToFix } : {}),
  });
}

/**
 * Keeps the error's code and message and adds the ids, our own next step and
 * `extra`, without saying whether anything was sent: for answers that don't
 * tell (a transfer Botwallet lists as failed may still have gone through on
 * older servers), or where the server's hint names a CLI command.
 */
export function transferError(
  error: unknown,
  ref: TransferRef,
  howToFix: string,
  extra: Record<string, unknown> = {},
): ToolResult {
  return errorResult({
    ...errorPayload(error),
    ...ref,
    how_to_fix: howToFix,
    ...extra,
  });
}

/**
 * config.json is there but can't be read, so it isn't known which wallet
 * address Key 1 belongs to. Nothing was prepared or sent; `retry` says how to
 * finish the transfer once the file is fixed.
 */
export function unreadableConfigError(error: unknown, ref: TransferRef, retry: string): ToolResult {
  return errorResult({
    error: true,
    code: 'CONFIG_ERROR',
    message: `Key 1 did not sign: config.json, which records this wallet's address, could not be read ` +
      `(${errorMessage(error)}). Nothing was sent.`,
    sent: false,
    ...ref,
    how_to_fix: 'Ask your human to fix or restore ~/.botwallet/config.json; do not delete it, it lists the wallets ' +
      `and their Key 1 files. ${retry}`,
  });
}

/** Key 1 refused to sign because the transaction isn't what the agent asked for. */
export function signingRefusedError(error: TransactionCheckError, ref: TransferRef, what: string): ToolResult {
  const howToFix = error.code === 'WALLET_MISMATCH'
    ? 'The API key and Key 1 in use may belong to different wallets. Check botwallet_wallet_list and the ' +
      'BOTWALLET_API_KEY / BOTWALLET_WALLET settings of this MCP server. If they look right, report this to support@botwallet.co.'
    : `The transaction Botwallet prepared does not match the ${what} you asked for. Do not try this ${what} again; ` +
      'tell your owner and report it to support@botwallet.co.';
  return errorResult({
    error: true,
    code: error.code,
    message: `Key 1 did not sign this ${what}: ${error.message}. Nothing was sent.`,
    sent: false,
    ...ref,
    how_to_fix: howToFix,
  });
}

/**
 * Return a structured error when the owner's guard rails blocked a payment.
 * Surfaces the server's own reason and fix instead of a generic message.
 * `what` names the action for the fallback message, e.g. "payment".
 */
export function guardRailBlockedError(result: Record<string, unknown>, what: string): ToolResult {
  const reason = typeof result.rejection_reason === 'string' ? result.rejection_reason : undefined;
  // A replayed request (same idempotency key) carries a "duplicate request"
  // message instead of the block reason, so don't use it as the explanation.
  const serverMessage = typeof result.message === 'string' && !result.idempotent ? result.message : undefined;
  const serverFix = typeof result.how_to_fix === 'string' ? result.how_to_fix : undefined;

  return errorResult({
    error: true,
    code: 'BLOCKED_BY_GUARD_RAIL',
    message: serverMessage || `This ${what} was blocked by your wallet's guard rails${reason ? ` (${reason})` : ''}.`,
    how_to_fix: serverFix || 'Ask your wallet owner to update the Guard Rails settings on their dashboard.',
    details: {
      status: result.status,
      rejection_reason: result.rejection_reason,
      guard_rail: result.guard_rail,
      transaction_id: result.transaction_id,
      fetch_id: result.fetch_id,
    },
  });
}
