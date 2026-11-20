// Offline tests for botwallet_lookup, botwallet_can_i_afford and the
// recipient handling of botwallet_pay. The SDK is mocked.

import { describe, it, expect, vi } from 'vitest';
import { spendingTools } from '../../../src/tools/spending.js';
import { connectClient, localWallet, parseResult, toolContext } from '../../helpers/harness.js';
import { ata, testAddress } from '../../helpers/solana-messages.js';

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

const makeCtx = (sdk: ReturnType<typeof fakeSdk>) => toolContext(sdk, localWallet('agent'));

describe('botwallet_can_i_afford', () => {
  async function check(server: Record<string, unknown>, to = 'acme-bot') {
    const sdk = fakeSdk();
    sdk.canIAfford.mockResolvedValue(server);
    return parseResult(await canIAfford.handler({ to, amount: 5 }, makeCtx(sdk)));
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
    const out = parseResult(await lookup.handler({ username: '@clever-byte-1234' }, makeCtx(sdk)));
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
    const out = parseResult(await pay.handler({ to: '@acme-bot', amount: 5 }, makeCtx(sdk)));
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
    expect(parseResult(result).code).toBe('VALIDATION_ERROR');
    expect(sdk.pay).not.toHaveBeenCalled();
  });

  it('accepts @username through the MCP server and passes it on without the @', async () => {
    const sdk = fakeSdk();
    const client = await connectClient(sdk, localWallet('agent'));

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

describe('Solana address recipients', () => {
  // Base58 and the length of an address, but 33 bytes (the CLI's test value, cmd/address_test.go)
  const NOT_AN_ADDRESS = 'z'.repeat(44);

  it('botwallet_pay refuses an address that does not decode to 32 bytes, without calling Botwallet', async () => {
    const sdk = fakeSdk();
    const result = await pay.handler({ to: NOT_AN_ADDRESS, amount: 5 }, makeCtx(sdk));

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Invalid Solana address format' });
    expect(parseResult(result).how_to_fix).toContain('decode to 32 bytes');
    expect(sdk.pay).not.toHaveBeenCalled();
  });

  it('botwallet_pay still pays an address off the curve, as the CLI does', async () => {
    const sdk = fakeSdk();
    const offCurve = ata(testAddress('merchant'));
    await pay.handler({ to: offCurve, amount: 5 }, makeCtx(sdk));
    expect(sdk.pay.mock.calls[0][0]).toMatchObject({ to: offCurve });
  });
});

describe('botwallet_list_payments', () => {
  const listPayments = tool('botwallet_list_payments');

  async function list(args: Record<string, unknown>) {
    const sdk = { listPayments: vi.fn(async (_p: Record<string, unknown>) => ({ payments: [], total: 0 })) };
    const result = await listPayments.handler(args, toolContext(sdk, localWallet('agent')));
    return { result, sent: sdk.listPayments.mock.calls[0]?.[0] };
  }

  it('asks for expired payments when the agent asks for cancelled ones: cancelling marks a payment expired', async () => {
    const { result, sent } = await list({ status: 'cancelled', limit: 5 });
    expect(result.isError).toBeFalsy();
    expect(sent).toEqual({ status: 'expired', limit: 5 });
  });

  it('passes every other filter on as it is', async () => {
    for (const args of [{}, { status: 'expired' }, { status: 'all', offset: 10 }, { transaction_id: 'tx-1' }]) {
      expect((await list(args)).sent).toEqual(args);
    }
  });
});
