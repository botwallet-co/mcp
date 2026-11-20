// Offline tests for botwallet_balance (what a missing budget means) and
// botwallet_wallet_use (switching the wallet in use). The SDK is mocked;
// files go to a temporary home directory.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const testHome = path.join(os.tmpdir(), `bw-wallet-test-${Date.now()}`);
vi.mock('node:os', async () => (await import('../../helpers/temp-home.js')).osWithHome(() => testHome));

import { walletTools } from '../../../src/tools/wallet.js';
import { addWallet, loadConfig } from '../../../src/config/config.js';
import { saveSeed } from '../../../src/config/seeds.js';
import { localWallet, parseResult, TEST_MNEMONIC, toolContext } from '../../helpers/harness.js';

const tool = (name: string) => walletTools.find(t => t.name === name)!;
const balance = tool('botwallet_balance');
const walletUse = tool('botwallet_wallet_use');

const entry = (apiKey: string) => ({
  username: 'bot', api_key: apiKey, public_key: 'x', seed_file: 'x', created_at: '2026-10-04T12:00:00Z',
});

beforeEach(() => {
  fs.mkdirSync(path.join(testHome, '.botwallet', 'seeds'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe('botwallet_balance', () => {
  async function balanceWith(answer: Record<string, unknown>) {
    const sdk = { balance: vi.fn(async () => answer) };
    return parseResult(await balance.handler({}, toolContext(sdk)));
  }

  it('says when the owner has set no budget', async () => {
    const out = await balanceWith({ balance: 12.5, budget: null, remaining_budget: null });
    expect(out).toMatchObject({ balance: 12.5, budget: null, budget_status: 'no_budget_set' });
    expect(out.budget_message).toMatch(/No spending budget is configured/);
  });

  it('marks a budget the owner set as active', async () => {
    const out = await balanceWith({ balance: 12.5, budget: 50, remaining_budget: 40 });
    expect(out).toMatchObject({ budget: 50, remaining_budget: 40, budget_status: 'active' });
    expect(out.budget_message).toBeUndefined();
  });
});

describe('botwallet_wallet_use', () => {
  beforeEach(() => {
    addWallet('bot-a', entry('key-a'));
    addWallet('bot-b', entry('key-b'));
    saveSeed('bot-b', TEST_MNEMONIC);
  });

  it('makes the wallet the default and uses its API key and key share from now on', async () => {
    const sdk = { setApiKey: vi.fn() };
    const ctx = toolContext(sdk, { ...localWallet('bot-a'), hasSeed: false });

    const out = parseResult(await walletUse.handler({ name: 'bot-b' }, ctx));

    expect(out).toEqual({ switched: true, active_wallet: 'bot-b', has_seed: true });
    expect(loadConfig().default_wallet).toBe('bot-b');
    expect(sdk.setApiKey).toHaveBeenCalledWith('key-b');
    expect(ctx.config).toEqual({ walletName: 'bot-b', hasConfig: true, hasSeed: true });
  });

  it('says when the wallet has no key share on this machine', async () => {
    const sdk = { setApiKey: vi.fn() };
    const ctx = toolContext(sdk, localWallet('bot-b'));

    const out = parseResult(await walletUse.handler({ name: 'bot-a' }, ctx));

    expect(out).toMatchObject({ switched: true, active_wallet: 'bot-a', has_seed: false });
    expect(ctx.config.hasSeed).toBe(false);
  });

  it('refuses a wallet that is not in config.json and changes nothing', async () => {
    const sdk = { setApiKey: vi.fn() };
    const ctx = toolContext(sdk, localWallet('bot-a'));

    const result = await walletUse.handler({ name: 'bot-z' }, ctx);

    expect(result.isError).toBe(true);
    expect(parseResult(result).message).toContain('"bot-z" not found');
    expect(loadConfig().default_wallet).toBe('bot-a');
    expect(sdk.setApiKey).not.toHaveBeenCalled();
    expect(ctx.config.walletName).toBe('bot-a');
  });

  it('without config.json, says there is none', async () => {
    const result = await walletUse.handler({ name: 'bot-a' }, toolContext({ setApiKey: vi.fn() }));
    expect(parseResult(result).code).toBe('NO_LOCAL_CONFIG');
  });
});
