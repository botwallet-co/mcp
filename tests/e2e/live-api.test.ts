// End-to-end tests against the real BotWallet API (api.botwallet.co).
// Not part of `npm test`: run them with `npm run test:e2e` (vitest.config.ts).
// They make no payments; the authenticated part needs BOTWALLET_E2E_API_KEY
// and is skipped without it.

import { describe, it, expect, beforeAll } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { BotWallet } from '../../src/sdk/index.js';
import { connectClient, parseResult, resultText } from '../helpers/harness.js';

describe('E2E: Live API tests', () => {
  let client: Client;

  beforeAll(async () => {
    // No API key: only the calls that need none reach the API
    client = await connectClient(new BotWallet());
  });

  it('ping: API is reachable and response is unwrapped', async () => {
    const result = await client.callTool({ name: 'botwallet_ping', arguments: {} });
    const parsed = parseResult(result);

    // SDK should unwrap V3 envelope: { success, data } -> data
    expect(result.isError).toBeFalsy();
    expect(parsed.ok).toBe(true);
    expect(parsed.version).toBeDefined();
    expect(parsed.timestamp).toBeDefined();
    // Verify envelope was stripped — these should NOT be present
    expect(parsed.success).toBeUndefined();
    expect(parsed.data).toBeUndefined();
  });

  it('info: returns auth error without API key', async () => {
    const result = await client.callTool({ name: 'botwallet_info', arguments: {} });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('API key');
  });

  it('lookup: needs an API key', async () => {
    const result = await client.callTool({
      name: 'botwallet_lookup',
      arguments: { username: '@nonexistent-test-bot-12345' },
    });

    expect(result.isError).toBe(true);
    expect(parseResult(result).code).toBe('UNAUTHORIZED');
  });

  it('wallet_list: returns no-config error', async () => {
    const result = await client.callTool({
      name: 'botwallet_wallet_list',
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('no local config');
  });

  it('x402_fetch: probes a URL', async () => {
    const result = await client.callTool({
      name: 'botwallet_x402_fetch',
      arguments: { url: 'https://httpbin.org/get' },
    });
    const parsed = parseResult(result);

    // httpbin.org should return 200 (free)
    expect(result.isError).toBeFalsy();
    expect(parsed.payment_required).toBe(false);
    expect(parsed.status).toBe(200);
  });

  it('x402_fetch: validates URL safety', async () => {
    const result = await client.callTool({
      name: 'botwallet_x402_fetch',
      arguments: { url: 'http://localhost:8080/secret' },
    });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('private');
  });

  it('can_i_afford: validates input schema', async () => {
    const result = await client.callTool({
      name: 'botwallet_can_i_afford',
      arguments: { to: '', amount: -1 },
    });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('validation error');
  });

  it('events: requires auth', async () => {
    const result = await client.callTool({
      name: 'botwallet_events',
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('API key');
  });
});

const API_KEY = process.env.BOTWALLET_E2E_API_KEY;

describe.skipIf(!API_KEY)('E2E: Authenticated tests', () => {
  let client: Client;

  beforeAll(async () => {
    client = await connectClient(new BotWallet({ apiKey: API_KEY }), { walletName: 'e2e-test' });
  });

  it('info: returns wallet details', async () => {
    const result = await client.callTool({ name: 'botwallet_info', arguments: {} });
    const parsed = parseResult(result);

    expect(result.isError).toBeFalsy();
    expect(parsed.wallet_id).toBeDefined();
    expect(parsed.username).toBeDefined();
    expect(parsed.status).toBeDefined();
    expect(parsed.deposit_address).toBeDefined();
  });

  it('balance: returns balance and limits', async () => {
    const result = await client.callTool({ name: 'botwallet_balance', arguments: {} });
    const parsed = parseResult(result);

    expect(result.isError).toBeFalsy();
    expect(parsed.balance).toBeDefined();
    expect(typeof parsed.balance).toBe('number');
  });

  it('my_limits: returns guard rails', async () => {
    const result = await client.callTool({ name: 'botwallet_my_limits', arguments: {} });
    const parsed = parseResult(result);

    expect(result.isError).toBeFalsy();
    expect(parsed.budget).toBeDefined();
    expect(parsed.remaining_budget).toBeDefined();
  });

  it('transactions: returns history', async () => {
    const result = await client.callTool({
      name: 'botwallet_transactions',
      arguments: { limit: 5 },
    });
    const parsed = parseResult(result);

    expect(result.isError).toBeFalsy();
    expect(parsed.transactions).toBeDefined();
    expect(Array.isArray(parsed.transactions)).toBe(true);
  });

  it('get_deposit_address: returns Solana address', async () => {
    const result = await client.callTool({
      name: 'botwallet_get_deposit_address',
      arguments: {},
    });
    const parsed = parseResult(result);

    expect(result.isError).toBeFalsy();
    expect(parsed.deposit_address).toBeDefined();
    expect(parsed.deposit_address.length).toBeGreaterThanOrEqual(32);
  });

  it('pending_approvals: returns list', async () => {
    const result = await client.callTool({
      name: 'botwallet_pending_approvals',
      arguments: {},
    });
    const parsed = parseResult(result);

    expect(result.isError).toBeFalsy();
    expect(parsed.pending).toBeDefined();
    expect(typeof parsed.count).toBe('number');
  });

  it('events: returns notifications', async () => {
    const result = await client.callTool({
      name: 'botwallet_events',
      arguments: { limit: 5 },
    });
    const parsed = parseResult(result);

    expect(result.isError).toBeFalsy();
    expect(parsed.events).toBeDefined();
  });

  it('list_paylinks: returns payment requests', async () => {
    const result = await client.callTool({
      name: 'botwallet_list_paylinks',
      arguments: { limit: 5 },
    });
    const parsed = parseResult(result);

    expect(result.isError).toBeFalsy();
    expect(parsed.requests).toBeDefined();
  });

  it('list_fund_requests: returns fund requests', async () => {
    const result = await client.callTool({
      name: 'botwallet_list_fund_requests',
      arguments: { limit: 5 },
    });
    const parsed = parseResult(result);

    expect(result.isError).toBeFalsy();
    expect(parsed.requests).toBeDefined();
  });

  it('lookup: checks a known username', async () => {
    // Look up the wallet's own username first
    const infoResult = await client.callTool({ name: 'botwallet_info', arguments: {} });
    expect(infoResult.isError).toBeFalsy();

    const { username } = parseResult(infoResult);
    const result = await client.callTool({
      name: 'botwallet_lookup',
      arguments: { username },
    });

    expect(result.isError).toBeFalsy();
    expect(parseResult(result).found).toBe(true);
  });

  it('resource: botwallet://status', async () => {
    const result = await client.readResource({ uri: 'botwallet://status' });
    const [content] = result.contents;
    const text = 'text' in content ? content.text : '';

    expect(text).toContain('Balance:');
    expect(text).toContain('Deposit Address:');
  });
});
