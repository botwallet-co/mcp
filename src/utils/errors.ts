import type { ToolResult } from '../types.js';
import { BotWalletError } from '../sdk/index.js';
import type { TransactionCheckError } from '../solana/index.js';

function errorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof BotWalletError) {
    const payload: Record<string, unknown> = {
      error: true,
      code: error.code,
      message: error.message,
    };

    if (error.howToFix) {
      payload.how_to_fix = error.howToFix;
    }

    if (error.details && Object.keys(error.details).length > 0) {
      payload.details = error.details;
    }

    return payload;
  }

  return {
    error: true,
    code: 'UNKNOWN_ERROR',
    message: error instanceof Error ? error.message : String(error),
  };
}

function errorResult(payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

/**
 * Format any error into a structured JSON MCP tool error response.
 * Returns machine-parseable JSON with error code, message, and actionable details.
 */
export function formatToolError(error: unknown): ToolResult {
  return errorResult(errorPayload(error));
}

/**
 * True when no answer came back from the server (timeout, lost connection,
 * unreadable reply), so it isn't known whether the request was carried out.
 */
export function isNoAnswer(error: unknown): boolean {
  return error instanceof BotWalletError && (error.code === 'TIMEOUT' || error.code === 'NETWORK_ERROR');
}

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
 * Botwallet lists a payment or withdrawal as failed. Keeps the error's code
 * and message and adds the ids, but doesn't say nothing was sent: older
 * servers also mark a transfer failed when the request to Solana broke off
 * after sending it.
 */
export function listedAsFailedError(error: unknown, ref: TransferRef, howToFix: string): ToolResult {
  return errorResult({
    ...errorPayload(error),
    ...ref,
    how_to_fix: howToFix,
  });
}

/**
 * Keeps the error's code and message and adds the ids, our own next step and
 * `extra`, without saying whether anything was sent: for answers that don't
 * tell, or where the server's hint names a CLI command.
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
 * Return a structured error with our own code, in the same JSON shape as
 * formatToolError.
 */
export function toolError(
  code: string,
  message: string,
  howToFix?: string,
  details?: Record<string, unknown>,
): ToolResult {
  const payload: Record<string, unknown> = { error: true, code, message };
  if (howToFix) payload.how_to_fix = howToFix;
  if (details && Object.keys(details).length > 0) payload.details = details;
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
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

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
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
      }, null, 2),
    }],
    isError: true,
  };
}

// Registering never brings back an existing wallet: it makes a separate,
// empty one. Errors about missing local files say so, and offer registering
// last, for when the human really wants a new wallet.
const REGISTER_LAST = { tool: 'botwallet_register', description: 'Only if your human wants a brand-new wallet' };

/**
 * Return a helpful error when FROST signing is required but no seed is available.
 * `walletName` is the wallet in use, when there is one: its key share may be
 * missing on this machine while the wallet and its funds are fine.
 */
export function noSeedError(operation: string, walletName?: string): ToolResult {
  if (walletName) {
    return errorResult({
      error: true,
      code: 'NO_LOCAL_SEED',
      message: `Cannot ${operation}: wallet "${walletName}" has no local key share (Key 1) on this machine ` +
        `(~/.botwallet/seeds/${walletName}.seed is missing).`,
      how_to_fix: 'Do not register a new wallet to fix this: a new wallet is separate and starts empty, and this ' +
        'wallet keeps its funds. Ask your human to restore the key share file from the machine or backup that has it, ' +
        'or to export the wallet there and import the .bwlt file here with botwallet_wallet_import. ' +
        'botwallet_info shows which wallet the API key opens; botwallet_wallet_list shows the wallets on this ' +
        'machine and which have Key 1.',
      options: [
        { tool: 'botwallet_info', description: 'See which wallet the API key opens' },
        { tool: 'botwallet_wallet_list', description: 'See the wallets on this machine and which have Key 1' },
        { tool: 'botwallet_wallet_import', description: 'Import the wallet from a .bwlt file exported where its Key 1 is' },
      ],
    });
  }

  return errorResult({
    error: true,
    code: 'NO_LOCAL_SEED',
    message: `Cannot ${operation}: no local key share (Key 1) was found for the wallet in use.`,
    how_to_fix: 'This needs the wallet\'s Key 1 in ~/.botwallet/seeds/. If you already have a Botwallet, do not ' +
      'register a new one to fix this: a new wallet is separate and starts empty. Ask your human to restore ' +
      '~/.botwallet from the machine that has the wallet, or to export it there and import the .bwlt file here with ' +
      'botwallet_wallet_import. If BOTWALLET_API_KEY is set for this MCP server, it decides the wallet: check that it ' +
      'belongs to a wallet whose Key 1 is on this machine (botwallet_wallet_list shows them). ' +
      'Call botwallet_register only if your human wants a brand-new wallet.',
    options: [
      { tool: 'botwallet_wallet_import', description: 'Import the wallet from a .bwlt file exported where its Key 1 is' },
      { tool: 'botwallet_wallet_list', description: 'See the wallets on this machine and which have Key 1' },
      { tool: 'botwallet_info', description: 'See which wallet the API key opens, if one is set' },
      REGISTER_LAST,
    ],
  });
}

/**
 * Return a helpful error when config is not available.
 */
export function noConfigError(operation: string): ToolResult {
  return errorResult({
    error: true,
    code: 'NO_LOCAL_CONFIG',
    message: `Cannot ${operation}: no local config found (~/.botwallet/config.json).`,
    how_to_fix: 'If you already have a Botwallet, do not register a new one: ask your human to restore the ' +
      '~/.botwallet folder from the machine that has the wallet, or to export it there and import the .bwlt file ' +
      'here with botwallet_wallet_import. If BOTWALLET_API_KEY is set for this MCP server, botwallet_info shows the ' +
      'wallet it opens. Call botwallet_register only if your human wants a brand-new wallet.',
    options: [
      { tool: 'botwallet_wallet_import', description: 'Import a wallet from a .bwlt file' },
      { tool: 'botwallet_info', description: 'See the wallet BOTWALLET_API_KEY opens, if one is set' },
      REGISTER_LAST,
    ],
  });
}
