import type { z } from 'zod';
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
  inputSchema: z.ZodType;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}
