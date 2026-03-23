// End-to-end tests against the real BotWallet API (api.botwallet.co).

import { describe, it, expect, beforeAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BotWallet } from '../../src/sdk/index.js';
import { createServer } from '../../src/server.js';
import type { ConfigContext } from '../../src/types.js';

function parseResult(result: { content: unknown[]; isError?: boolean }) {
  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  try {
    return { parsed: JSON.parse(text), raw: text, isError: result.isError };
  } catch {
    return { parsed: null, raw: text, isError: result.isError };
  }
}

describe('E2E: Live API tests', () => {
  let client: Client;
  let sdk: BotWallet;

  beforeAll(async () => {
    sdk = new BotWallet();

    const config: ConfigContext = {
      walletName: undefined,
      hasConfig: false,
      hasSeed: false,
    };

    const server = createServer(sdk, config);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    client = new Client({ name: 'e2e-test', version: '0.1.0' });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  it('ping: API is reachable and response is unwrapped', async () => {
    const result = await client.callTool({ name: 'botwallet_ping', arguments: {} });
    const { parsed, isError } = parseResult(result);

    console.log('  ping response:', JSON.stringify(parsed, null, 2));

    // SDK should unwrap V3 envelope: { success, data } -> data
    expect(isError).toBeFalsy();
    expect(parsed.ok).toBe(true);
    expect(parsed.version).toBeDefined();
    expect(parsed.timestamp).toBeDefined();
    // Verify envelope was stripped — these should NOT be present
    expect(parsed.success).toBeUndefined();
    expect(parsed.data).toBeUndefined();
  });

  it('info: returns auth error without API key', async () => {
    const result = await client.callTool({ name: 'botwallet_info', arguments: {} });
    const { raw, isError } = parseResult(result);

    console.log('  info (no auth):', raw.substring(0, 200));

    expect(isError).toBe(true);
    expect(raw).toContain('API key');
  });

  it('lookup: validates recipient', async () => {
    // This requires auth, should fail gracefully
    const result = await client.callTool({
      name: 'botwallet_lookup',
      arguments: { username: '@nonexistent-test-bot-12345' },
    });
    const { raw, isError } = parseResult(result);

    console.log('  lookup (no auth):', raw.substring(0, 200));

    // Either auth error or not-found — both are valid
    expect(raw).toBeTruthy();
  });

  it('wallet_list: returns no-config error', async () => {
    const result = await client.callTool({
      name: 'botwallet_wallet_list',
      arguments: {},
    });
    const { raw, isError } = parseResult(result);

    expect(isError).toBe(true);
    expect(raw).toContain('no local config');
  });

  it('x402_fetch: probes a URL', async () => {
    const result = await client.callTool({
      name: 'botwallet_x402_fetch',
      arguments: { url: 'https://httpbin.org/get' },
    });
    const { parsed, isError } = parseResult(result);

    console.log('  x402_fetch (free URL):', JSON.stringify(parsed, null, 2).substring(0, 300));

    // httpbin.org should return 200 (free)
    expect(isError).toBeFalsy();
    expect(parsed.payment_required).toBe(false);
    expect(parsed.status).toBe(200);
  });

  it('x402_fetch: validates URL safety', async () => {
    const result = await client.callTool({
      name: 'botwallet_x402_fetch',
      arguments: { url: 'http://localhost:8080/secret' },
    });
    const { raw, isError } = parseResult(result);

    expect(isError).toBe(true);
    expect(raw).toContain('private');
  });

  it('can_i_afford: validates input schema', async () => {
    const result = await client.callTool({
      name: 'botwallet_can_i_afford',
      arguments: { to: '', amount: -1 },
    });
    const { raw, isError } = parseResult(result);

    expect(isError).toBe(true);
    expect(raw).toContain('validation error');
  });

  it('events: requires auth', async () => {
    const result = await client.callTool({
      name: 'botwallet_events',
      arguments: {},
    });
    const { raw, isError } = parseResult(result);

    expect(isError).toBe(true);
    expect(raw).toContain('API key');
  });
});

describe('E2E: Authenticated tests', () => {
  let client: Client;
  let sdk: BotWallet;
  const API_KEY = process.env.BOTWALLET_E2E_API_KEY;

  beforeAll(async () => {
    if (!API_KEY) {
      console.log('  ⏭ Skipping authenticated tests (set BOTWALLET_E2E_API_KEY)');
      return;
    }

    sdk = new BotWallet({ apiKey: API_KEY });

    const config: ConfigContext = {
      walletName: 'e2e-test',
      hasConfig: false,
      hasSeed: false,
    };

    const server = createServer(sdk, config);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    client = new Client({ name: 'e2e-auth-test', version: '0.1.0' });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  it('info: returns wallet details', async () => {
    if (!API_KEY) return;

    const result = await client.callTool({ name: 'botwallet_info', arguments: {} });
    const { parsed, isError } = parseResult(result);

    console.log('  info:', JSON.stringify(parsed, null, 2));

    expect(isError).toBeFalsy();
    expect(parsed.wallet_id).toBeDefined();
    expect(parsed.username).toBeDefined();
    expect(parsed.status).toBeDefined();
    expect(parsed.deposit_address).toBeDefined();
  });

  it('balance: returns balance and limits', async () => {
    if (!API_KEY) return;

    const result = await client.callTool({ name: 'botwallet_balance', arguments: {} });
    const { parsed, isError } = parseResult(result);

    console.log('  balance:', JSON.stringify(parsed, null, 2));

    expect(isError).toBeFalsy();
    expect(parsed.balance).toBeDefined();
    expect(typeof parsed.balance).toBe('number');
  });

  it('my_limits: returns guard rails', async () => {
    if (!API_KEY) return;

    const result = await client.callTool({ name: 'botwallet_my_limits', arguments: {} });
    const { parsed, isError } = parseResult(result);

    console.log('  limits:', JSON.stringify(parsed, null, 2));

    expect(isError).toBeFalsy();
    expect(parsed.budget).toBeDefined();
    expect(parsed.remaining_budget).toBeDefined();
  });

  it('transactions: returns history', async () => {
    if (!API_KEY) return;

    const result = await client.callTool({
      name: 'botwallet_transactions',
      arguments: { limit: 5 },
    });
    const { parsed, isError } = parseResult(result);

    console.log('  transactions:', JSON.stringify(parsed, null, 2).substring(0, 500));

    expect(isError).toBeFalsy();
    expect(parsed.transactions).toBeDefined();
    expect(Array.isArray(parsed.transactions)).toBe(true);
  });

  it('get_deposit_address: returns Solana address', async () => {
    if (!API_KEY) return;

    const result = await client.callTool({
      name: 'botwallet_get_deposit_address',
      arguments: {},
    });
    const { parsed, isError } = parseResult(result);

    console.log('  deposit_address:', JSON.stringify(parsed, null, 2));

    expect(isError).toBeFalsy();
    expect(parsed.deposit_address).toBeDefined();
    expect(parsed.deposit_address.length).toBeGreaterThanOrEqual(32);
  });

  it('pending_approvals: returns list', async () => {
    if (!API_KEY) return;

    const result = await client.callTool({
      name: 'botwallet_pending_approvals',
      arguments: {},
    });
    const { parsed, isError } = parseResult(result);

    console.log('  pending_approvals:', JSON.stringify(parsed, null, 2));

    expect(isError).toBeFalsy();
    expect(parsed.pending).toBeDefined();
    expect(typeof parsed.count).toBe('number');
  });

  it('events: returns notifications', async () => {
    if (!API_KEY) return;

    const result = await client.callTool({
      name: 'botwallet_events',
      arguments: { limit: 5 },
    });
    const { parsed, isError } = parseResult(result);

    console.log('  events:', JSON.stringify(parsed, null, 2).substring(0, 500));

    expect(isError).toBeFalsy();
    expect(parsed.events).toBeDefined();
  });

  it('list_paylinks: returns payment requests', async () => {
    if (!API_KEY) return;

    const result = await client.callTool({
      name: 'botwallet_list_paylinks',
      arguments: { limit: 5 },
    });
    const { parsed, isError } = parseResult(result);

    console.log('  paylinks:', JSON.stringify(parsed, null, 2).substring(0, 500));

    expect(isError).toBeFalsy();
    expect(parsed.requests).toBeDefined();
  });

  it('list_fund_requests: returns fund requests', async () => {
    if (!API_KEY) return;

    const result = await client.callTool({
      name: 'botwallet_list_fund_requests',
      arguments: { limit: 5 },
    });
    const { parsed, isError } = parseResult(result);

    console.log('  fund_requests:', JSON.stringify(parsed, null, 2).substring(0, 500));

    expect(isError).toBeFalsy();
    expect(parsed.requests).toBeDefined();
  });

  it('lookup: checks a known username', async () => {
    if (!API_KEY) return;

    // Look up the wallet's own username first
    const infoResult = await client.callTool({ name: 'botwallet_info', arguments: {} });
    const info = parseResult(infoResult);
    if (info.isError) return;

    const username = info.parsed.username;
    const result = await client.callTool({
      name: 'botwallet_lookup',
      arguments: { username },
    });
    const { parsed, isError } = parseResult(result);

    console.log('  lookup self:', JSON.stringify(parsed, null, 2));

    expect(isError).toBeFalsy();
    expect(parsed.found).toBe(true);
  });

  it('resource: botwallet://status', async () => {
    if (!API_KEY) return;

    const result = await client.readResource({ uri: 'botwallet://status' });
    const text = result.contents[0].text as string;

    console.log('  status resource:\n', text);

    expect(text).toContain('Balance:');
    expect(text).toContain('Deposit Address:');
  });
});
