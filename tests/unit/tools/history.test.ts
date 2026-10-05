// Offline tests for botwallet_events, through the MCP server so its input
// schema is applied. The SDK is mocked.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../../src/server.js';
import type { BotWallet } from '../../../src/sdk/index.js';

// VALID_EVENT_TYPES in supabase/functions/bot/handlers/events.ts, without the
// never-recorded guardrails_updated
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
  const server = createServer(sdk as unknown as BotWallet, { walletName: 'agent', hasConfig: true, hasSeed: true });
  client = new Client({ name: 'test-client', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
});

describe('botwallet_events', () => {
  it('offers exactly the event types the server can filter on', async () => {
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
