import type { ToolResult } from '../types.js';
import { BotWalletError } from '../sdk/index.js';

/**
 * Format any error into a structured MCP tool error response.
 * Extracts actionable fields from BotWalletError when available.
 */
export function formatToolError(error: unknown): ToolResult {
  if (error instanceof BotWalletError) {
    const parts: string[] = [`Error: ${error.message}`];

    if (error.howToFix) {
      parts.push(`How to fix: ${error.howToFix}`);
    }

    const extra = error.details;
    if (extra) {
      if (extra.funding_url) parts.push(`Fund wallet: ${extra.funding_url}`);
      if (extra.approval_url) parts.push(`Approval URL: ${extra.approval_url}`);
      if (extra.balance !== undefined) parts.push(`Current balance: $${extra.balance}`);
      if (extra.shortfall !== undefined) parts.push(`Shortfall: $${extra.shortfall}`);
    }

    return {
      content: [{ type: 'text', text: parts.join('\n') }],
      isError: true,
    };
  }

  if (error instanceof Error) {
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true,
    };
  }

  return {
    content: [{ type: 'text', text: `Error: ${String(error)}` }],
    isError: true,
  };
}

/**
 * Return a helpful error when FROST signing is required but no seed is available.
 */
export function noSeedError(operation: string): ToolResult {
  return {
    content: [{
      type: 'text',
      text: [
        `Error: Cannot ${operation} — no local key share (seed) found.`,
        '',
        'FROST threshold signing requires a local key share stored in ~/.botwallet/seeds/.',
        'To fix this, either:',
        '  1. Register a new wallet using botwallet_register',
        '  2. Import a wallet using botwallet_wallet_import',
        '  3. Set BOTWALLET_WALLET to the wallet name if using a named wallet',
      ].join('\n'),
    }],
    isError: true,
  };
}

/**
 * Return a helpful error when config is not available.
 */
export function noConfigError(operation: string): ToolResult {
  return {
    content: [{
      type: 'text',
      text: [
        `Error: Cannot ${operation} — no local config found.`,
        '',
        'This operation requires ~/.botwallet/config.json.',
        'To set up: register a new wallet using botwallet_register,',
        'or import a wallet using botwallet_wallet_import.',
      ].join('\n'),
    }],
    isError: true,
  };
}
