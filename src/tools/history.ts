import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { READ_ONLY, UPDATES } from '../utils/annotations.js';
import { formatResult } from '../utils/format.js';
import { formatToolError } from '../utils/errors.js';
import { PaginationSchema } from '../utils/schemas.js';

const transactions: ToolDefinition = {
  name: 'botwallet_transactions',
  annotations: READ_ONLY,
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
  annotations: READ_ONLY,
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
  annotations: READ_ONLY,
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
  annotations: READ_ONLY,
  description:
    'Check the status of a specific approval by ID. Shows if it is pending, approved, rejected, or expired. ' +
    'When approved, includes the tool name and arguments needed to confirm the transaction.',
  inputSchema: z.object({
    approval_id: z.string().describe('Approval ID to check'),
  }),
  async handler(args, ctx) {
    try {
      const { approval_id } = args as { approval_id: string };
      const result = await ctx.sdk.approvalStatus({ approval_id });
      const data = result as Record<string, unknown>;

      // Enrich with MCP tool references (the API returns CLI commands only)
      if (data.actionable && data.transaction_id) {
        const txId = data.transaction_id as string;
        const type = data.type as string;

        if (type === 'withdrawal') {
          data.confirm_tool = 'botwallet_confirm_withdrawal';
          data.confirm_args = { transaction_id: txId };
        } else if (type === 'x402_payment') {
          data.confirm_tool = 'botwallet_x402_pay_and_fetch';
          data.confirm_args = { fetch_id: txId };
        } else {
          data.confirm_tool = 'botwallet_confirm_payment';
          data.confirm_args = { transaction_id: txId };
        }
      }

      return formatResult(data);
    } catch (e) {
      return formatToolError(e);
    }
  },
};

// Event types the server filters on (VALID_EVENT_TYPES in
// supabase/functions/bot/handlers/events.ts). The server ignores any other
// type, and a filter left with no known type returns every event, so only
// these are accepted. 'guardrails_updated' is left out: the server accepts it
// but never records such an event, so filtering on it always comes back empty.
const EVENT_TYPES = [
  'approval_required',
  'approval_resolved',
  'fund_requested',
  'fund_request_funded',
  'fund_request_dismissed',
  'deposit_received',
  'payment_completed',
  'paylink_received',
  'wallet_pledged',
  'wallet_claimed',
  'low_balance',
  'x402_payment_completed',
  'x402_payment_failed',
  'withdrawal_completed',
] as const;

const events: ToolDefinition = {
  name: 'botwallet_events',
  // Not read-only: mark_read marks the returned events as read
  annotations: UPDATES,
  description:
    'Get wallet notifications, newest first. By default only unread events are returned, 10 at a time (25 at most). ' +
    'Useful types: approval_resolved (your owner approved or rejected a payment or withdrawal), approval_required, ' +
    'deposit_received, payment_completed, withdrawal_completed, x402_payment_completed, x402_payment_failed, ' +
    'fund_request_funded, low_balance. ' +
    'Set unread_only to false to include events already read. ' +
    'Set mark_read to true to mark the events this call returns as read.',
  inputSchema: z.object({
    types: z.array(z.enum(EVENT_TYPES)).optional()
      .describe('Only return events of these types'),
    limit: z.number().int().min(1).max(25).optional()
      .describe('Max events to return (default 10, max 25)'),
    unread_only: z.boolean().optional()
      .describe('Only return unread events. Defaults to true; set false to include events already read.'),
    since: z.string().optional()
      .describe('Only return events after this ISO 8601 timestamp'),
    mark_read: z.boolean().optional()
      .describe('Mark the events this call returns as read (only those, not other unread events)'),
  }),
  async handler(args, ctx) {
    try {
      const { mark_read, ...eventParams } = args as {
        types?: string[]; limit?: number; unread_only?: boolean;
        since?: string; mark_read?: boolean;
      };

      const result = await ctx.sdk.events(eventParams);

      // Mark as read if requested
      let markedCount = 0;
      if (mark_read && result.events.length > 0) {
        const eventIds = result.events.map(e => e.id).filter(Boolean);
        if (eventIds.length > 0) {
          const markResult = await ctx.sdk.markRead({ event_ids: eventIds });
          markedCount = markResult.marked_read ?? eventIds.length;
        }
      }

      return formatResult({
        ...result,
        marked_as_read: markedCount,
      } as unknown as Record<string, unknown>);
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
