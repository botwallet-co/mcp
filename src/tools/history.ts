import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { formatResult } from '../utils/format.js';
import { formatToolError } from '../utils/errors.js';
import { PaginationSchema } from '../utils/schemas.js';

const transactions: ToolDefinition = {
  name: 'botwallet_transactions',
  description:
    'View the full transaction ledger: all completed money movements including payments sent, ' +
    'payments received, deposits, withdrawals, fees, and refunds. Filter by direction (in/out). ' +
    'For tracking specific outgoing payment intents by status, use botwallet_list_payments instead.',
  inputSchema: PaginationSchema.extend({
    type: z.enum(['all', 'in', 'out']).optional()
      .describe('Transaction direction filter (default: all)'),
  }),
  async handler(args, ctx) {
    try {
      const result = await ctx.sdk.transactions(args as {
        type?: 'all' | 'in' | 'out'; limit?: number; offset?: number;
      });
      return formatResult(result);
    } catch (e) {
      return formatToolError(e);
    }
  },
};

const myLimits: ToolDefinition = {
  name: 'botwallet_my_limits',
  description:
    'View all guard rails set by the wallet owner: spending limits (per-transaction, daily), ' +
    'recipient restrictions (whitelists/blacklists), earning limits, and withdrawal rules. ' +
    'Check this before attempting operations that might be restricted by the owner\'s guard rails.',
  inputSchema: z.object({}),
  async handler(_args, ctx) {
    try {
      const result = await ctx.sdk.myLimits();
      return formatResult(result);
    } catch (e) {
      return formatToolError(e);
    }
  },
};

const pendingApprovals: ToolDefinition = {
  name: 'botwallet_pending_approvals',
  description:
    'List actions waiting for owner approval (payments and withdrawals). ' +
    'Shows approval URLs so the owner can act on them.',
  inputSchema: z.object({}),
  async handler(_args, ctx) {
    try {
      const result = await ctx.sdk.pendingApprovals();
      return formatResult(result);
    } catch (e) {
      return formatToolError(e);
    }
  },
};

const approvalStatus: ToolDefinition = {
  name: 'botwallet_approval_status',
  description: 'Check the status of a specific approval by ID. Shows if it is pending, approved, rejected, or expired.',
  inputSchema: z.object({
    approval_id: z.string().describe('Approval ID to check'),
  }),
  async handler(args, ctx) {
    try {
      const { approval_id } = args as { approval_id: string };
      const result = await ctx.sdk.approvalStatus({ approval_id });
      return formatResult(result);
    } catch (e) {
      return formatToolError(e);
    }
  },
};

const events: ToolDefinition = {
  name: 'botwallet_events',
  description:
    'Get wallet notifications/events. Event types include: ' +
    'approval_resolved, deposit_received, payment_completed, fund_requested, guard_rails_updated. ' +
    'Set mark_read to true to mark returned events as read.',
  inputSchema: z.object({
    types: z.array(z.string()).optional()
      .describe('Filter by event types'),
    limit: z.number().int().min(1).max(100).optional()
      .describe('Max events to return'),
    unread_only: z.boolean().optional()
      .describe('Only return unread events'),
    since: z.string().optional()
      .describe('Only return events after this ISO 8601 timestamp'),
    mark_read: z.boolean().optional()
      .describe('Mark returned events as read'),
  }),
  async handler(args, ctx) {
    try {
      const { mark_read, ...eventParams } = args as {
        types?: string[]; limit?: number; unread_only?: boolean;
        since?: string; mark_read?: boolean;
      };

      const result = await ctx.sdk.events(eventParams);

      // Mark as read if requested
      if (mark_read && result.events.length > 0) {
        const eventIds = result.events.map(e => e.event_id);
        await ctx.sdk.markRead({ event_ids: eventIds });
      }

      return formatResult({
        ...result,
        marked_as_read: mark_read ? result.events.length : 0,
      });
    } catch (e) {
      return formatToolError(e);
    }
  },
};

export const historyTools: ToolDefinition[] = [
  transactions,
  myLimits,
  pendingApprovals,
  approvalStatus,
  events,
];
