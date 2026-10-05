// Offline tests for botwallet_lookup, botwallet_can_i_afford and the
// recipient handling of botwallet_pay. The SDK is mocked.

import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { spendingTools } from '../../../src/tools/spending.js';
import { createServer } from '../../../src/server.js';
import type { BotWallet } from '../../../src/sdk/index.js';
import type { ToolContext, ToolResult } from '../../../src/types.js';

const tool = (name: string) => spendingTools.find(t => t.name === name)!;
const lookup = tool('botwallet_lookup');
const canIAfford = tool('botwallet_can_i_afford');
const pay = tool('botwallet_pay');

function fakeSdk() {
  return {
    lookup: vi.fn(async (p: { username: string }) => ({ found: true, username: p.username, type: 'bot' })),
    canIAfford: vi.fn(async (_p: { to: string; amount: number }): Promise<Record<string, unknown>> => ({ can_pay: true })),
    pay: vi.fn(async (_p: Record<string, unknown>, _key?: string) => ({
      status: 'awaiting_approval',
      transaction_id: 'tx-1',
      approval_id: 'ap-1',
      approval_url: 'https://example.test/approve/ap-1',
    })),
  };
}

function makeCtx(sdk: ReturnType<typeof fakeSdk>): ToolContext {
  return {
    sdk: sdk as unknown as BotWallet,
    config: { walletName: 'agent', hasConfig: true, hasSeed: true },
  };
}

function parse(result: ToolResult): Record<string, any> {
  return JSON.parse(result.content[0].text);
}

describe('botwallet_can_i_afford', () => {
  async function check(server: Record<string, unknown>, to = 'acme-bot') {
    const sdk = fakeSdk();
    sdk.canIAfford.mockResolvedValue(server);
    return parse(await canIAfford.handler({ to, amount: 5 }, makeCtx(sdk)));
  }

  it('can pay: affordable and auto-approved', async () => {
    const out = await check({ can_pay: true, to: 'acme-bot', amount_usdc: 5, fee_usdc: 0.05 });
    expect(out).toMatchObject({ can_afford: true, will_auto_approve: true, fee_usdc: 0.05 });
  });

  it('needs approval: affordable, the server checked the balance first', async () => {
    const out = await check({ can_pay: false, reason: 'needs_approval', owner_message: 'Over the auto-approve limit' });
    expect(out).toMatchObject({ can_afford: true, will_auto_approve: false, needs_approval: true });
  });

  it('insufficient funds: the only case that is not affordable', async () => {
    const out = await check({
      can_pay: false, reason: 'insufficient_funds', shortfall_usdc: 1.5, funding_url: 'https://example.test/fund/agent',
    });
    expect(out).toMatchObject({ can_afford: false, will_auto_approve: false, shortfall_usdc: 1.5 });
  });

  it('unknown recipient: says so, and does not report a lack of funds', async () => {
    const out = await check({
      can_pay: false, reason: 'recipient_not_found', message: 'No merchant or agent found with username \'acme-bt\'',
    }, 'acme-bt');
    expect(out).toMatchObject({ recipient_found: false, can_afford: null, will_auto_approve: null, blocked: false });
    expect(out.message).toContain('acme-bt');
    expect(out.note).toBeUndefined();
  });

  it('a Solana address: explains that botwallet_pay takes addresses', async () => {
    const out = await check({ can_pay: false, reason: 'recipient_not_found' }, '5DewmSGWjgidikL4eH1brrzxA3XG8esJ1fKE11wbtHkd');
    expect(out).toMatchObject({ recipient_found: false, can_afford: null });
    expect(out.note).toContain('botwallet_pay');
  });

  it.each(['recipient_inactive', 'recipient_suspended'])('%s: the recipient exists but can\'t receive', async (reason) => {
    const out = await check({ can_pay: false, reason, message: 'Recipient wallet is suspended' });
    expect(out).toMatchObject({
      recipient_found: true, recipient_can_receive: false, can_afford: null, will_auto_approve: null, blocked: false,
    });
  });

  it.each(['recipient_blacklist', 'hard_cap', 'hard_cap_budget', 'wallet_suspended'])(
    'guard rail %s: blocked, balance not checked, owner message kept',
    async (reason) => {
      const out = await check({
        can_pay: false, reason, message: 'Blocked', guard_rail: reason, owner_message: 'Change it in Guard Rails',
      });
      expect(out).toMatchObject({
        blocked: true, can_afford: null, will_auto_approve: false, reason, owner_message: 'Change it in Guard Rails',
      });
    },
  );
});

describe('usernames with a leading @', () => {
  it('botwallet_lookup sends the username without the @', async () => {
    const sdk = fakeSdk();
    const out = parse(await lookup.handler({ username: '@clever-byte-1234' }, makeCtx(sdk)));
    expect(sdk.lookup).toHaveBeenCalledWith({ username: 'clever-byte-1234' });
    expect(out.found).toBe(true);
  });

  it('botwallet_can_i_afford sends the recipient without the @', async () => {
    const sdk = fakeSdk();
    await canIAfford.handler({ to: '@acme-bot', amount: 5 }, makeCtx(sdk));
    expect(sdk.canIAfford).toHaveBeenCalledWith({ to: 'acme-bot', amount: 5 });
  });

  it('botwallet_pay sends the recipient without the @', async () => {
    const sdk = fakeSdk();
    const out = parse(await pay.handler({ to: '@acme-bot', amount: 5 }, makeCtx(sdk)));
    expect(sdk.pay.mock.calls[0][0]).toMatchObject({ to: 'acme-bot', amount: 5 });
    expect(out.needs_approval).toBe(true);
  });

  it('leaves a Solana address as it is', async () => {
    const address = '5DewmSGWjgidikL4eH1brrzxA3XG8esJ1fKE11wbtHkd';
    const sdk = fakeSdk();
    await pay.handler({ to: address, amount: 5 }, makeCtx(sdk));
    expect(sdk.pay.mock.calls[0][0]).toMatchObject({ to: address });
  });

  it('refuses a username that is only an @, without calling Botwallet', async () => {
    const sdk = fakeSdk();
    const result = await pay.handler({ to: '@', amount: 5 }, makeCtx(sdk));
    expect(result.isError).toBe(true);
    expect(parse(result).code).toBe('VALIDATION_ERROR');
    expect(sdk.pay).not.toHaveBeenCalled();
  });

  it('accepts @username through the MCP server and passes it on without the @', async () => {
    const sdk = fakeSdk();
    const server = createServer(sdk as unknown as BotWallet, { walletName: 'agent', hasConfig: true, hasSeed: true });
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    const schema = listed.tools.find(t => t.name === 'botwallet_lookup')!.inputSchema as {
      properties: Record<string, { type?: string }>;
    };
    expect(schema.properties.username.type).toBe('string');

    const result = await client.callTool({ name: 'botwallet_lookup', arguments: { username: '  @clever-byte-1234 ' } });
    expect(result.isError).toBeFalsy();
    expect(sdk.lookup).toHaveBeenCalledWith({ username: 'clever-byte-1234' });
    await client.close();
  });
});
