import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { formatResult } from '../utils/format.js';
import { formatToolError } from '../utils/errors.js';
import { AmountSchema, PaginationSchema } from '../utils/schemas.js';

const getDepositAddress: ToolDefinition = {
  name: 'botwallet_get_deposit_address',
  description:
    'Get your USDC deposit address on Solana. Anyone can send USDC to this address to fund your wallet. ' +
    'Also returns a funding URL for the owner portal.',
  inputSchema: z.object({}),
  async handler(_args, ctx) {
    try {
      const result = await ctx.sdk.getDepositAddress();
      return formatResult(result);
    } catch (e) {
      return formatToolError(e);
    }
  },
};

const requestFunds: ToolDefinition = {
  name: 'botwallet_request_funds',
  description:
    'Request funds from your human owner. Sends a notification with the amount and reason. ' +
    'Use this when your balance is too low to complete a task.',
  inputSchema: z.object({
    amount: AmountSchema.describe('Amount to request in USD'),
    reason: z.string().min(1).max(500)
      .describe('Why you need the funds (shown to owner)'),
  }),
  async handler(args, ctx) {
    try {
      const { amount, reason } = args as { amount: number; reason: string };
      const result = await ctx.sdk.requestFunds({ amount, reason });
      return formatResult(result);
    } catch (e) {
      return formatToolError(e);
    }
  },
};

const listFundRequests: ToolDefinition = {
  name: 'botwallet_list_fund_requests',
  description: 'List your fund requests with status (pending, funded, dismissed). Supports pagination.',
  inputSchema: PaginationSchema.extend({
    status: z.enum(['pending', 'funded', 'dismissed', 'all']).optional()
      .describe('Filter by status (default: all)'),
  }),
  async handler(args, ctx) {
    try {
      const result = await ctx.sdk.listFundRequests(args as {
        status?: string; limit?: number; offset?: number;
      });
      return formatResult(result);
    } catch (e) {
      return formatToolError(e);
    }
  },
};

export const fundingTools: ToolDefinition[] = [
  getDepositAddress,
  requestFunds,
  listFundRequests,
];
