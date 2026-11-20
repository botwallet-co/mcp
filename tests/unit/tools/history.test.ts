// Offline tests for botwallet_events, through the MCP server so its input
// schema is applied, and for botwallet_approval_status. The SDK is mocked.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { historyTools } from '../../../src/tools/history.js';
import { connectClient, localWallet, parseResult, toolContext } from '../../helpers/harness.js';

// The types botwallet_events offers: VALID_EVENT_TYPES in
// supabase/functions/bot/handlers/events.ts without guardrails_updated, which
// nothing records, and without the four types recorded since that the tool
// doesn't offer yet (see EVENT_TYPES in src/tools/history.ts)
const SERVER_EVENT_TYPES = [
  'approval_required', 'approval_resolved', 'fund_requested', 'fund_request_funded', 'fund_request_dismissed',
  'deposit_received', 'payment_completed', 'paylink_received', 'wallet_pledged', 'wallet_claimed',
  'low_balance', 'x402_payment_completed', 'x402_payment_failed', 'withdrawal_completed',
];

let client: Client;
let sdk: { events: ReturnType<typeof vi.fn>; markRead: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  sdk = {
    events: vi.fn(async () => ({
      events: [{ id: 'ev-1', type: 'deposit_received', title: 'Deposit', message: '$5', severity: 'info' }],
      count: 1, total_matching: 1, unread_count: 1, tip: '',
    })),
    markRead: vi.fn(async () => ({ marked_read: 1 })),
  };
  client = await connectClient(sdk, localWallet('agent'));
});

afterEach(async () => {
  await client.close();
});

describe('botwallet_events', () => {
  it('offers exactly the event types listed above', async () => {
    const listed = await client.listTools();
    const schema = listed.tools.find(t => t.name === 'botwallet_events')!.inputSchema as {
      properties: Record<string, { items?: { enum?: string[] }; maximum?: number }>;
    };
    expect([...schema.properties.types.items!.enum!].sort()).toEqual([...SERVER_EVENT_TYPES].sort());
    expect(schema.properties.limit.maximum).toBe(25);
  });

  it('refuses an unknown type instead of returning every event', async () => {
    const result = await client.callTool({ name: 'botwallet_events', arguments: { types: ['guard_rails_updated'] } });
    expect(result.isError).toBe(true);
    expect(sdk.events).not.toHaveBeenCalled();
  });

  it('refuses a limit above the server\'s 25', async () => {
    const result = await client.callTool({ name: 'botwallet_events', arguments: { limit: 100 } });
    expect(result.isError).toBe(true);
    expect(sdk.events).not.toHaveBeenCalled();
  });

  it('passes the filter on and marks only the returned events as read', async () => {
    const result = await client.callTool({
      name: 'botwallet_events',
      arguments: { types: ['deposit_received', 'approval_resolved'], unread_only: false, mark_read: true },
    });
    expect(result.isError).toBeFalsy();
    expect(sdk.events).toHaveBeenCalledWith({ types: ['deposit_received', 'approval_resolved'], unread_only: false });
    expect(sdk.markRead).toHaveBeenCalledWith({ event_ids: ['ev-1'] });
  });
});

describe('botwallet_approval_status', () => {
  const approvalStatus = historyTools.find(t => t.name === 'botwallet_approval_status')!;

  async function status(answer: Record<string, unknown>) {
    const sdk = { approvalStatus: vi.fn(async () => ({ approval_id: 'ap-1', ...answer })) };
    const out = parseResult(await approvalStatus.handler({ approval_id: 'ap-1' }, toolContext(sdk)));
    expect(sdk.approvalStatus).toHaveBeenCalledWith({ approval_id: 'ap-1' });
    return out;
  }

  it.each([
    ['payment', 'botwallet_confirm_payment', { transaction_id: 'tx-1' }],
    ['withdrawal', 'botwallet_confirm_withdrawal', { transaction_id: 'tx-1' }],
    ['x402_payment', 'botwallet_x402_pay_and_fetch', { fetch_id: 'tx-1' }],
  ])('an approved %s names the tool and arguments that finish it', async (type, tool, args) => {
    const out = await status({
      type, status: 'approved', actionable: true, transaction_id: 'tx-1', confirm_command: 'botwallet pay confirm tx-1',
    });
    expect(out).toMatchObject({ status: 'approved', confirm_tool: tool, confirm_args: args });
    // The server's CLI command is passed on as it is
    expect(out.confirm_command).toBe('botwallet pay confirm tx-1');
  });

  it('names no tool while the approval is pending', async () => {
    const out = await status({ type: 'payment', status: 'pending', actionable: false, transaction_id: 'tx-1' });
    expect(out.status).toBe('pending');
    expect(out.confirm_tool).toBeUndefined();
    expect(out.confirm_args).toBeUndefined();
  });

  it('names no tool when the approved transfer is not found', async () => {
    const out = await status({ type: 'payment', status: 'approved', actionable: true, transaction_id: null });
    expect(out.confirm_tool).toBeUndefined();
  });
});
