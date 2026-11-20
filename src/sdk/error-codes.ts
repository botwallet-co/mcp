// What an API error means for the tool that got it. The API sends many more
// codes; the tools pass those on to the agent as they are. Codes that matter
// to one call only stay beside it (NOT_SUBMITTED_CODES in frost/signing.ts,
// dkgCompleteRefused in tools/wallet.ts).

import { BotWalletError } from './errors.js';

/** True when `error` is a BotWalletError with this code. */
export function hasCode(error: unknown, code: string): error is BotWalletError {
  return error instanceof BotWalletError && error.code === code;
}

/**
 * True when no answer came back from the server (timeout, lost connection,
 * unreadable reply), so it isn't known whether the request was carried out.
 */
export function isNoAnswer(error: unknown): boolean {
  return error instanceof BotWalletError && (error.code === 'TIMEOUT' || error.code === 'NETWORK_ERROR');
}

/** The owner has frozen the wallet (WALLET_SUSPENDED). */
export function isFrozenWallet(error: unknown): boolean {
  return hasCode(error, 'WALLET_SUSPENDED');
}

/** The server's answer for a transfer it sent to Solana that isn't confirmed yet. */
export function isSentUnconfirmed(error: unknown): error is BotWalletError {
  return hasCode(error, 'SUBMISSION_UNCONFIRMED');
}

/** The transfer or paid API call was completed earlier. */
export function isAlreadyCompleted(error: unknown): boolean {
  return hasCode(error, 'ALREADY_COMPLETED');
}

/**
 * The server refuses to confirm a transfer that is being sent right now:
 * SIGNING_IN_PROGRESS. Current servers prepare a pending transfer that was
 * never sent again; older ones answered INVALID_STATUS for any pending one.
 */
export function isPendingStatusError(error: unknown): boolean {
  if (!(error instanceof BotWalletError)) return false;
  return error.code === 'SIGNING_IN_PROGRESS' ||
    (error.code === 'INVALID_STATUS' && /status: pending\b/.test(error.message));
}

/** A transfer the owner started on the signing page: only the owner finishes it, there. */
export function isOwnerSigning(error: unknown): boolean {
  return error instanceof BotWalletError && error.code === 'INVALID_STATUS' && /on the signing page/i.test(error.message);
}

/** The server's answer to confirming a transfer it lists as failed. */
export function isListedAsFailed(error: unknown): boolean {
  return error instanceof BotWalletError &&
    (error.code === 'TRANSACTION_FAILED' || error.code === 'WITHDRAWAL_FAILED');
}
