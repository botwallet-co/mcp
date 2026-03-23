// =============================================================================
// Botwallet SDK Errors
// =============================================================================

import type { BotWalletErrorCode, ApiErrorResponse } from './types.js';

/**
 * Base error class for all BotWallet errors
 */
export class BotWalletError extends Error {
  /** Machine-readable error code */
  readonly code: BotWalletErrorCode;
  /** Suggested fix (when available) */
  readonly howToFix?: string;
  /** Additional error details */
  readonly details?: Record<string, unknown>;

  constructor(
    code: BotWalletErrorCode,
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
      error as BotWalletErrorCode,
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
  constructor(message = 'Invalid or missing API key') {
    super(
      'UNAUTHORIZED', 
      message, 
      'Provide API key via constructor, BOTWALLET_API_KEY env variable, or call register() to create a new wallet'
    );
    this.name = 'UnauthorizedError';
  }
}

/**
 * Error thrown when balance is insufficient
 */
export class InsufficientFundsError extends BotWalletError {
  readonly balance: number;
  readonly required: number;
  readonly shortfall: number;
  readonly fundingUrl?: string;

  constructor(
    balance: number = 0,
    required: number = 0,
    fundingUrl?: string
  ) {
    const shortfall = Math.max(0, required - balance);
    const balanceStr = (balance ?? 0).toFixed(2);
    const requiredStr = (required ?? 0).toFixed(2);
    const shortfallStr = shortfall.toFixed(2);
    
    super(
      'INSUFFICIENT_FUNDS',
      `Insufficient balance: have $${balanceStr}, need $${requiredStr}`,
      fundingUrl ? `Add $${shortfallStr} at: ${fundingUrl}` : 'Add funds to your wallet',
      { balance, required, shortfall }
    );
    this.name = 'InsufficientFundsError';
    this.balance = balance ?? 0;
    this.required = required ?? 0;
    this.shortfall = shortfall;
    this.fundingUrl = fundingUrl;
  }
}

/**
 * Error thrown when a recipient is not found
 */
export class RecipientNotFoundError extends BotWalletError {
  readonly username: string;

  constructor(username: string) {
    super(
      'RECIPIENT_NOT_FOUND',
      `No merchant or bot found with username '${username}'`,
      'Use lookup() to verify the username exists'
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

  constructor(guardRail: string, message: string, details?: Record<string, unknown>) {
    super(guardRail.toUpperCase() as BotWalletErrorCode, message, undefined, details);
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
    super('NETWORK_ERROR', message, 'Check your internet connection and try again');
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
      'The server may be busy - try again in a moment'
    );
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

