import type { ToolResult } from '../types.js';

/**
 * Format a successful tool result as JSON text.
 */
export function formatResult(data: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * Format a plain text tool result.
 */
export function formatText(text: string): ToolResult {
  return {
    content: [{ type: 'text', text }],
  };
}

/**
 * Format a dollar amount for display.
 */
export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
