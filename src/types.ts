import type { z } from 'zod';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { BotWallet } from './sdk/index.js';

export interface ConfigContext {
  walletName?: string;
  hasSeed: boolean;
  hasConfig: boolean;
}

export interface ToolContext {
  sdk: BotWallet;
  config: ConfigContext;
}

export interface ToolDefinition {
  name: string;
  description: string;
  // Must be a z.object(...) — server.ts registers tools with inputSchema.shape
  inputSchema: z.ZodObject<z.ZodRawShape>;
  // Tells MCP clients which tools only read and which move money or touch
  // Key 1 (presets in utils/annotations.ts). Required, so no tool goes without.
  annotations: ToolAnnotations;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  // Matches the MCP SDK's CallToolResult, which allows extra fields
  [key: string]: unknown;
}
