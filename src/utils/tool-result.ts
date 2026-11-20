// Every tool result is JSON text: a success with formatResult, an error with
// errorResult. The error builders for payments and withdrawals are in
// transfers/results.ts and use the same payload.

import type { ToolResult } from '../types.js';
import { BotWalletError } from '../sdk/index.js';

/** A successful tool result. */
export function formatResult(data: object): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

/** A tool error with this JSON payload. */
export function errorResult(payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

/** The error fields for any thrown value: a BotWalletError's code, message, hint and details. */
export function errorPayload(error: unknown): Record<string, unknown> {
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

/**
 * Format any error into a structured JSON MCP tool error response.
 * Returns machine-parseable JSON with error code, message, and actionable details.
 */
export function formatToolError(error: unknown): ToolResult {
  return errorResult(errorPayload(error));
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
  return errorResult(payload);
}
