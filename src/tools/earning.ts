import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { formatResult } from '../utils/format.js';
import { formatToolError } from '../utils/errors.js';
import { AmountSchema, PaginationSchema } from '../utils/schemas.js';

const LineItemSchema = z.object({
  description: z.string().describe('Line item description'),
  unit_price_cents: z.number().int().min(1).describe('Price per unit in cents (e.g. 500 = $5.00)'),
  quantity: z.number().int().min(1).default(1).describe('Quantity (default: 1)'),
  total_cents: z.number().int().min(1).describe('Total in cents (unit_price_cents * quantity)'),
});

const createPaylink: ToolDefinition = {
  name: 'botwallet_create_paylink',
  description:
    'Create a payment request (paylink) that someone can pay. ' +
    'Returns a payment URL and short code that you can share or send via botwallet_send_paylink. ' +
    'Supports itemized invoices via the items array — when items are provided, the total is auto-calculated. ' +
    'You must provide either `amount` or `items` (or both).',
  inputSchema: z.object({
    amount: AmountSchema.optional()
      .describe('Amount to request in USD (optional if items are provided — total calculated from items)'),
    description: z.string().min(1).max(500)
      .describe('What this payment is for'),
    reference: z.string().max(100).optional()
      .describe('Your internal reference for tracking'),
    expires_in: z.string().optional()
      .describe('Expiration time (e.g. "1h", "24h", "7d"). Default: 24h'),
    reveal_owner: z.boolean().optional()
      .describe('Show owner email on payment page (default: true)'),
    items: z.array(LineItemSchema).optional()
      .describe('Itemized invoice line items. Total is auto-calculated from items.'),
  }),
  async handler(args, ctx) {
    try {
      const { amount, description, reference, expires_in, reveal_owner, items } = args as {
        amount?: number; description: string; reference?: string; expires_in?: string;
        reveal_owner?: boolean; items?: Array<{ description: string; unit_price_cents: number; quantity: number; total_cents: number }>;
      };

      if (!amount && (!items || items.length === 0)) {
        return formatToolError(new Error(
          'Either amount or items must be provided. Use items for itemized invoices, or amount for a simple paylink.'
        ));
      }

      // Auto-calculate amount from items when not explicitly provided
      let finalAmount = amount;
      if (!finalAmount && items && items.length > 0) {
        const totalCents = items.reduce((sum, item) => sum + item.total_cents, 0);
        finalAmount = totalCents / 100;
      }

      const result = await ctx.sdk.createPaymentRequest({
        amount: finalAmount,
        description,
        reference,
        expires_in,
        reveal_owner,
        line_items: items,
      } as Record<string, unknown>);
      return formatResult(result);
    } catch (e) {
      return formatToolError(e);
    }
  },
};

const sendPaylink: ToolDefinition = {
  name: 'botwallet_send_paylink',
  description:
    'Send a paylink to a specific recipient. Use after botwallet_create_paylink to deliver the payment request ' +
    'via email (for humans) or directly to a bot wallet inbox (for agents). ' +
    'The recipient receives a notification with a "Pay Now" link.',
  inputSchema: z.object({
    request_id: z.string().describe('Payment request ID to send'),
    to_email: z.string().email().optional()
      .describe('Send to this email address'),
    to_wallet: z.string().optional()
      .describe('Send to this bot wallet username'),
    message: z.string().max(500).optional()
      .describe('Optional message to include'),
  }),
  async handler(args, ctx) {
    try {
      const result = await ctx.sdk.sendPaylinkInvitation(args as {
        request_id: string; to_email?: string; to_wallet?: string; message?: string;
      });
      return formatResult(result);
    } catch (e) {
      return formatToolError(e);
    }
  },
};

const getPaylink: ToolDefinition = {
  name: 'botwallet_get_paylink',
  description: 'Get the status of a payment request by ID or reference. Shows if it has been paid.',
  inputSchema: z.object({
    request_id: z.string().optional()
      .describe('Payment request ID'),
    reference: z.string().optional()
      .describe('Your internal reference'),
  }),
  async handler(args, ctx) {
    try {
      const result = await ctx.sdk.getPaymentRequest(args as {
        request_id?: string; reference?: string;
      });
      return formatResult(result);
    } catch (e) {
      return formatToolError(e);
    }
  },
};

const listPaylinks: ToolDefinition = {
  name: 'botwallet_list_paylinks',
  description:
    'List your payment requests (paylinks) — these are requests YOU created to receive money. ' +
    'Filter by status to find pending, completed, or expired paylinks. ' +
    'For payments you SENT (outgoing), use botwallet_list_payments. ' +
    'For all money movements, use botwallet_transactions.',
  inputSchema: PaginationSchema.extend({
    status: z.enum(['pending', 'completed', 'expired', 'cancelled', 'all']).optional()
      .describe('Filter by status (default: all)'),
  }),
  async handler(args, ctx) {
    try {
      const result = await ctx.sdk.listPaymentRequests(args as {
        status?: string; limit?: number; offset?: number;
      });
      return formatResult(result);
    } catch (e) {
      return formatToolError(e);
    }
  },
};

const cancelPaylink: ToolDefinition = {
  name: 'botwallet_cancel_paylink',
  description: 'Cancel a pending payment request. Only pending paylinks can be cancelled — paid or expired paylinks cannot.',
  inputSchema: z.object({
    request_id: z.string().describe('Payment request ID to cancel'),
  }),
  async handler(args, ctx) {
    try {
      const { request_id } = args as { request_id: string };
      const result = await ctx.sdk.cancelPaymentRequest({ request_id });
      return formatResult(result);
    } catch (e) {
      return formatToolError(e);
    }
  },
};

export const earningTools: ToolDefinition[] = [
  createPaylink,
  sendPaylink,
  getPaylink,
  listPaylinks,
  cancelPaylink,
];
