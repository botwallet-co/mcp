// The MCP server over an in-memory transport. Offline: fetch is stubbed and
// the client has no API key (tests/e2e covers the live API).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { BotWallet } from '../../src/sdk/index.js';
import { ALL_TOOLS } from '../../src/tools/index.js';
import { MCP_VERSION } from '../../src/utils/version.js';
import { connectClient, resultText } from '../helpers/harness.js';
import { readFileSync } from 'node:fs';

describe('MCP server integration', () => {
  let client: Client;
  const fetchMock = vi.fn(async () => Response.json({
    success: true,
    data: { ok: true, timestamp: '2026-10-04T00:00:00.000Z', version: 'test' },
  }));

  beforeAll(async () => {
    vi.stubGlobal('fetch', fetchMock);

    // No API key: only ping works without auth
    client = await connectClient(new BotWallet({ baseUrl: 'https://api.example.test/v1' }));
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('reports the package version in the handshake', () => {
    expect(client.getServerVersion()?.version).toBe(MCP_VERSION);
    // The release script bumps both; a mismatch means it missed one
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));
    expect(MCP_VERSION).toBe(pkg.version);
  });

  it('lists every tool', async () => {
    const result = await client.listTools();
    expect(result.tools.length).toBe(ALL_TOOLS.length);

    // Verify each tool has a name, description, and input schema
    for (const tool of result.tools) {
      expect(tool.name).toMatch(/^botwallet_/);
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
    }
  });

  it('has expected tool names', async () => {
    const result = await client.listTools();
    const names = result.tools.map(t => t.name).sort();

    const expected = [
      'botwallet_ping',
      'botwallet_register',
      'botwallet_info',
      'botwallet_balance',
      'botwallet_update_owner',
      'botwallet_rename',
      'botwallet_wallet_list',
      'botwallet_wallet_use',
      'botwallet_lookup',
      'botwallet_can_i_afford',
      'botwallet_pay',
      'botwallet_confirm_payment',
      'botwallet_list_payments',
      'botwallet_cancel_payment',
      'botwallet_create_paylink',
      'botwallet_send_paylink',
      'botwallet_get_paylink',
      'botwallet_list_paylinks',
      'botwallet_cancel_paylink',
      'botwallet_get_deposit_address',
      'botwallet_request_funds',
      'botwallet_list_fund_requests',
      'botwallet_withdraw',
      'botwallet_confirm_withdrawal',
      'botwallet_get_withdrawal',
      'botwallet_x402_discover',
      'botwallet_x402_fetch',
      'botwallet_x402_pay_and_fetch',
      'botwallet_transactions',
      'botwallet_my_limits',
      'botwallet_pending_approvals',
      'botwallet_approval_status',
      'botwallet_events',
      'botwallet_wallet_export',
      'botwallet_wallet_import',
      'botwallet_wallet_backup',
    ].sort();

    expect(names).toEqual(expected);
  });

  it('tells clients which tools only read and which move money or touch Key 1', async () => {
    const { tools } = await client.listTools();
    const hints = new Map(tools.map(t => [t.name, t.annotations]));

    for (const tool of tools) {
      expect(tool.annotations, tool.name).toBeDefined();
      expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe('boolean');
    }

    // Clients may run these without asking
    const readOnly = tools.filter(t => t.annotations?.readOnlyHint === true).map(t => t.name).sort();
    expect(readOnly).toEqual([
      'botwallet_approval_status',
      'botwallet_balance',
      'botwallet_can_i_afford',
      'botwallet_get_deposit_address',
      'botwallet_get_paylink',
      'botwallet_get_withdrawal',
      'botwallet_info',
      'botwallet_list_fund_requests',
      'botwallet_list_paylinks',
      'botwallet_list_payments',
      'botwallet_lookup',
      'botwallet_my_limits',
      'botwallet_pending_approvals',
      'botwallet_ping',
      'botwallet_transactions',
      'botwallet_wallet_list',
      'botwallet_x402_discover',
    ]);

    // Clients should ask before these
    for (const name of [
      'botwallet_pay',
      'botwallet_confirm_payment',
      'botwallet_withdraw',
      'botwallet_confirm_withdrawal',
      'botwallet_x402_pay_and_fetch',
      'botwallet_wallet_backup',
      'botwallet_wallet_export',
      'botwallet_wallet_import',
      'botwallet_update_owner',
    ]) {
      expect(hints.get(name)?.readOnlyHint, name).toBe(false);
      expect(hints.get(name)?.destructiveHint, name).toBe(true);
    }

    // Calls URLs the agent chooses, so it is not read-only either
    expect(hints.get('botwallet_x402_fetch')).toMatchObject({ readOnlyHint: false, openWorldHint: true });
  });

  it('lists resources', async () => {
    const result = await client.listResources();
    expect(result.resources.length).toBe(1);
    expect(result.resources[0].uri).toBe('botwallet://status');
  });

  it('botwallet_ping returns the API\'s answer, unwrapped', async () => {
    const result = await client.callTool({
      name: 'botwallet_ping',
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(resultText(result))).toMatchObject({ ok: true, version: 'test' });
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.test/v1/bot', expect.anything());
  });

  it('botwallet_wallet_list returns no-config error when unconfigured', async () => {
    const result = await client.callTool({
      name: 'botwallet_wallet_list',
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('no local config found');
  });

  it('botwallet_wallet_backup returns no-seed error when unconfigured', async () => {
    const result = await client.callTool({
      name: 'botwallet_wallet_backup',
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('no local key share');
  });

  it('validates input schemas', async () => {
    const result = await client.callTool({
      name: 'botwallet_can_i_afford',
      arguments: { to: '', amount: -5 },
    });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('validation error');
  });

  it('botwallet_info returns auth error without API key', async () => {
    const result = await client.callTool({
      name: 'botwallet_info',
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('API key');
  });

  it('reads wallet status resource', async () => {
    const result = await client.readResource({
      uri: 'botwallet://status',
    });

    expect(result.contents).toHaveLength(1);
    const [content] = result.contents;
    // Without API key, should show unavailable message
    expect('text' in content ? content.text : '').toContain('unavailable');
  });
});
