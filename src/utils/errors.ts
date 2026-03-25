import type { ToolResult } from '../types.js';
import { BotWalletError } from '../sdk/index.js';

/**
 * Format any error into a structured JSON MCP tool error response.
 * Returns machine-parseable JSON with error code, message, and actionable details.
 */
export function formatToolError(error: unknown): ToolResult {
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

    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      isError: true,
    };
  }

  if (error instanceof Error) {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: true,
        code: 'UNKNOWN_ERROR',
        message: error.message,
      }, null, 2) }],
      isError: true,
    };
  }

  return {
    content: [{ type: 'text', text: JSON.stringify({
      error: true,
      code: 'UNKNOWN_ERROR',
      message: String(error),
    }, null, 2) }],
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
      text: JSON.stringify({
        error: true,
        code: 'NO_LOCAL_SEED',
        message: `Cannot ${operation} — no local key share (seed) found.`,
        how_to_fix: 'FROST threshold signing requires a local key share stored in ~/.botwallet/seeds/.',
        options: [
          { tool: 'botwallet_register', description: 'Register a new wallet' },
          { tool: 'botwallet_wallet_import', description: 'Import a wallet from a .bwlt file' },
        ],
      }, null, 2),
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
      text: JSON.stringify({
        error: true,
        code: 'NO_LOCAL_CONFIG',
        message: `Cannot ${operation} — no local config found (~/.botwallet/config.json).`,
        how_to_fix: 'Register a new wallet or import an existing one.',
        options: [
          { tool: 'botwallet_register', description: 'Register a new wallet' },
          { tool: 'botwallet_wallet_import', description: 'Import a wallet from a .bwlt file' },
        ],
      }, null, 2),
    }],
    isError: true,
  };
}
