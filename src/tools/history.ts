import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { READ_ONLY, UPDATES } from '../utils/annotations.js';
import { formatResult } from '../utils/tool-result.js';
import { PaginationSchema } from '../utils/schemas.js';
import { apiTool, defineTool } from './define.js';

const transactions = apiTool({
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
  call: (sdk, args) => sdk.transactions(args),
});

const myLimits = apiTool({
  name: 'botwallet_my_limits',
  annotations: READ_ONLY,
  description:
    'View all guard rails set by the wallet owner: spending limits (per-transaction, daily), ' +
    'recipient restrictions (whitelists/blacklists), earning limits, and withdrawal rules. ' +
    'Check this before attempting operations that might be restricted by the owner\'s guard rails.',
  inputSchema: z.object({}),
  call: sdk => sdk.myLimits(),
});

const pendingApprovals = apiTool({
  name: 'botwallet_pending_approvals',
  annotations: READ_ONLY,
  description:
    'List actions waiting for owner approval (payments and withdrawals). ' +
    'Shows approval URLs so the owner can act on them.',
  inputSchema: z.object({}),
  call: sdk => sdk.pendingApprovals(),
});

const approvalStatus = defineTool({
  name: 'botwallet_approval_status',
  annotations: READ_ONLY,
  description:
    'Check the status of a specific approval by ID. Shows if it is pending, approved, rejected, or expired. ' +
    'When approved, includes the tool name and arguments needed to confirm the transaction.',
  inputSchema: z.object({
    approval_id: z.string().describe('Approval ID to check'),
  }),
  async run(args, ctx) {
    const { approval_id } = args;
    const result = await ctx.sdk.approvalStatus({ approval_id });

    // Enrich with MCP tool references (the API returns CLI commands only)
    if (result.actionable && result.transaction_id) {
      const txId = result.transaction_id;

      if (result.type === 'withdrawal') {
        result.confirm_tool = 'botwallet_confirm_withdrawal';
        result.confirm_args = { transaction_id: txId };
      } else if (result.type === 'x402_payment') {
        result.confirm_tool = 'botwallet_x402_pay_and_fetch';
        result.confirm_args = { fetch_id: txId };
      } else {
        result.confirm_tool = 'botwallet_confirm_payment';
        result.confirm_args = { transaction_id: txId };
      }
    }

    return formatResult(result);
  },
});

// The event types this tool offers, from VALID_EVENT_TYPES in
// supabase/functions/bot/handlers/events.ts. The server answers
// VALIDATION_ERROR for a type it doesn't know, so the schema lets only these
// through. guardrails_updated is left out because nothing records it;
// wallet_claimed isn't recorded either, but stays so calls that pass it keep
// working. The server also records approval_expiring, paylink_created,
// wallet_abandoned and keys_exported, which are not offered here yet.
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

const events = defineTool({
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
  async run(args, ctx) {
    const { mark_read, ...eventParams } = args;

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
    });
  },
});

export const historyTools: ToolDefinition[] = [
  transactions,
  myLimits,
  pendingApprovals,
  approvalStatus,
  events,
];
