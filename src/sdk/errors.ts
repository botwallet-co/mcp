// =============================================================================
// Botwallet SDK Errors
// =============================================================================

import type { ApiErrorResponse } from './types.js';

/**
 * Base error class for all BotWallet errors
 */
export class BotWalletError extends Error {
  /**
   * Machine-readable error code: the API's own (it adds codes over time; the
   * ones the tools react to are checked in error-codes.ts) or this client's
   * (NETWORK_ERROR, TIMEOUT).
   */
  readonly code: string;
  /** Suggested fix (when available) */
  readonly howToFix?: string;
  /** Additional error details */
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    howToFix?: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'BotWalletError';
    this.code = code;
    this.howToFix = howToFix;
    this.details = details;
    
    // Maintains proper stack trace in V8
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, BotWalletError);
    }
  }

  /**
   * Create error from API response
   */
  static fromResponse(response: ApiErrorResponse): BotWalletError {
    const { error, message, how_to_fix, ...rest } = response;
    return new BotWalletError(
      error,
      message,
      how_to_fix,
      Object.keys(rest).length > 0 ? rest : undefined
    );
  }

  /**
   * Create a human-readable string
   */
  toString(): string {
    let str = `[${this.code}] ${this.message}`;
    if (this.howToFix) {
      str += `\n  → ${this.howToFix}`;
    }
    return str;
  }

  /**
   * Convert to plain object (for logging/serialization)
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      howToFix: this.howToFix,
      details: this.details,
    };
  }
}

/**
 * Error thrown when authentication fails
 */
export class UnauthorizedError extends BotWalletError {
  /**
   * The default hint is written for the agent. It never suggests registering
   * first: a new wallet is separate and empty, and the agent's real wallet
   * may only be unreachable because of a wrong or missing key.
   */
  constructor(
    message = 'Invalid or missing API key',
    howToFix = 'Check that BOTWALLET_API_KEY in this MCP server\'s settings is right, or switch to another wallet ' +
      'on this machine with botwallet_wallet_use (botwallet_wallet_list shows them). If you already have a ' +
      'Botwallet, do not register a new one; call botwallet_register only if your human wants a brand-new wallet.'
  ) {
    super('UNAUTHORIZED', message, howToFix);
    this.name = 'UnauthorizedError';
  }
}

function isAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Error thrown when balance is insufficient
 */
export class InsufficientFundsError extends BotWalletError {
  readonly balance: number;
  readonly required: number;
  readonly shortfall: number;
  readonly fundingUrl?: string;

  /**
   * @param balance - Current balance in USD, when the API reported it
   * @param required - Amount needed (including fees) in USD, when reported
   * @param fundingUrl - Where the owner can add funds
   * @param server - The API's own message, how_to_fix and extra fields. The
   *   message is used when the amounts are missing (so we never print a
   *   made-up "$0.00"), and the extra fields are kept as error details.
   */
  constructor(
    balance?: number,
    required?: number,
    fundingUrl?: string,
    server: { message?: string; howToFix?: string; details?: Record<string, unknown> } = {}
  ) {
    const hasAmounts = isAmount(balance) && isAmount(required);
    const balanceValue = isAmount(balance) ? balance : 0;
    const requiredValue = isAmount(required) ? required : 0;
    // Round to cents so float noise (10.55 - 5 = 5.550000000000001) never shows
    const shortfall = hasAmounts ? Math.max(0, Math.round((requiredValue - balanceValue) * 100) / 100) : 0;

    const message = hasAmounts
      ? `Insufficient balance: have $${balanceValue.toFixed(2)}, need $${requiredValue.toFixed(2)}`
      : server.message || 'Insufficient balance';

    let howToFix: string;
    if (fundingUrl) {
      howToFix = shortfall > 0
        ? `Add $${shortfall.toFixed(2)} at: ${fundingUrl}`
        : `Add funds at: ${fundingUrl}`;
    } else {
      howToFix = server.howToFix || 'Add funds to your wallet';
    }

    const details = hasAmounts
      ? { ...server.details, balance: balanceValue, required: requiredValue, shortfall }
      : server.details;

    super(
      'INSUFFICIENT_FUNDS',
      message,
      howToFix,
      details && Object.keys(details).length > 0 ? details : undefined
    );
    this.name = 'InsufficientFundsError';
    this.balance = balanceValue;
    this.required = requiredValue;
    this.shortfall = shortfall;
    this.fundingUrl = fundingUrl;
  }
}

/**
 * Error thrown when a recipient is not found
 */
export class RecipientNotFoundError extends BotWalletError {
  readonly username?: string;

  /**
   * @param username - The username that was not found, when known
   * @param server - The API's own message, how_to_fix and extra fields, which
   *   name the username even when it is not sent as a separate field
   */
  constructor(
    username?: string,
    server: { message?: string; howToFix?: string; details?: Record<string, unknown> } = {}
  ) {
    super(
      'RECIPIENT_NOT_FOUND',
      server.message ||
        (username ? `No merchant or bot found with username '${username}'` : 'No merchant or bot found with that username'),
      server.howToFix || 'Check the username with botwallet_lookup, or pay a Solana address instead',
      server.details && Object.keys(server.details).length > 0 ? server.details : undefined
    );
    this.name = 'RecipientNotFoundError';
    this.username = username;
  }
}

/**
 * Error thrown when a guard rail blocks the action
 */
export class GuardRailError extends BotWalletError {
  readonly guardRail: string;

  /**
   * @param guardRail - The rule that blocked the action, e.g. "max_withdrawal"
   * @param message - The API's explanation
   * @param details - Extra fields, including the server's guard_rail object
   * @param howToFix - The API's next step for the agent, kept as it is
   */
  constructor(guardRail: string, message: string, details?: Record<string, unknown>, howToFix?: string) {
    super(guardRail.toUpperCase(), message, howToFix, details);
    this.name = 'GuardRailError';
    this.guardRail = guardRail;
  }
}

/**
 * Error thrown on network/connection issues
 */
export class NetworkError extends BotWalletError {
  readonly originalError?: Error;

  constructor(message: string, originalError?: Error) {
    super(
      'NETWORK_ERROR',
      message,
      'Check your internet connection. If the request moved money, check its status before sending it again; ' +
      'otherwise try again.'
    );
    this.name = 'NetworkError';
    this.originalError = originalError;
  }
}

/**
 * Error thrown on request timeout
 */
export class TimeoutError extends BotWalletError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(
      'TIMEOUT',
      `Request timed out after ${timeoutMs}ms`,
      'The server may be busy. If the request moved money, check its status before sending it again; ' +
      'otherwise try again in a moment.'
    );
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

