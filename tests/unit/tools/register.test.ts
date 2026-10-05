// Offline tests for botwallet_register: Key 1 is on disk before the server
// creates the wallet, the CLI can find it, and the new wallet is the default.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { base58 } from '@scure/base';

const testHome = path.join(os.tmpdir(), `bw-register-test-${Date.now()}`);
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => testHome,
  };
});

import { walletTools } from '../../../src/tools/wallet.js';
import { BotWalletError, NetworkError, type BotWallet, type DkgCompleteParams } from '../../../src/sdk/index.js';
import type { ToolContext, ToolResult } from '../../../src/types.js';
import { addWallet, configDir, getWallet, loadConfig } from '../../../src/config/config.js';
import { loadSeed, saveSeed } from '../../../src/config/seeds.js';
import { computeGroupKey, generateKeyShare, keyShareFromMnemonic } from '../../../src/frost/index.js';

const register = walletTools.find(t => t.name === 'botwallet_register')!;

const OTHER_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const API_KEY = 'bw_bot_register-test-key';
const serverShare = generateKeyShare();

const seedsDir = () => path.join(configDir(), 'seeds');
const seedFiles = () => (fs.existsSync(seedsDir()) ? fs.readdirSync(seedsDir()).sort() : []);

function parse(result: ToolResult): Record<string, any> {
  return JSON.parse(result.content[0].text);
}

function readMnemonic(file: string): string {
  return fs.readFileSync(file, 'utf-8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).join(' ');
}

function completeResult(params: DkgCompleteParams) {
  return {
    wallet_id: 'wallet-1',
    username: 'research-bot',
    api_key: API_KEY,
    deposit_address: params.group_public_key,
    funding_url: 'https://example.test/fund/research-bot',
    claim_code: 'ABC123',
    claim_url: 'https://example.test/claim/wallet-1',
    claim_expires_at: '2026-10-06T00:00:00Z',
    message: 'Wallet created',
  };
}

function mockSdk(dkgComplete: (params: DkgCompleteParams) => unknown): BotWallet {
  return {
    setApiKey: vi.fn(),
    dkgInit: vi.fn().mockResolvedValue({
      session_id: 'session-1',
      server_public_share: Buffer.from(serverShare.public).toString('base64'),
    }),
    dkgComplete: vi.fn(async (params: DkgCompleteParams) => dkgComplete(params)),
  } as unknown as BotWallet;
}

function makeCtx(sdk: BotWallet): ToolContext {
  return { sdk, config: { walletName: undefined, hasConfig: false, hasSeed: false } };
}

beforeEach(() => {
  fs.mkdirSync(seedsDir(), { recursive: true });
});

afterEach(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe('botwallet_register', () => {
  it('saves Key 1 before the server creates the wallet', async () => {
    let pendingAtComplete: string[] = [];
    const sdk = mockSdk((params) => {
      pendingAtComplete = seedFiles();
      const file = path.join(seedsDir(), `.pending-${params.group_public_key}.seed`);
      // The file on disk holds the key share whose public part is being registered
      const share = keyShareFromMnemonic(readMnemonic(file));
      expect(Buffer.from(share.public).toString('base64')).toBe(params.agent_public_share);
      return completeResult(params);
    });

    const out = parse(await register.handler({ name: 'Research Bot' }, makeCtx(sdk)));

    expect(pendingAtComplete).toHaveLength(1);
    expect(pendingAtComplete[0]).toMatch(/^\.pending-.+\.seed$/);
    expect(out.registered).toBe(true);
    // The pending file was moved to its final name
    expect(seedFiles()).toEqual(['research-bot.seed']);
  });

  it('writes a config entry the CLI can sign with, and makes the wallet the default', async () => {
    addWallet('bot-a', {
      username: 'bot-a', api_key: 'key-a', public_key: 'x', seed_file: 'seeds/bot-a.seed', created_at: 'x',
    });
    const sdk = mockSdk(completeResult);
    const ctx = makeCtx(sdk);

    const out = parse(await register.handler({ name: 'Research Bot' }, ctx));

    expect(out).toMatchObject({ wallet_name: 'research-bot', is_default: true, previous_default: 'bot-a' });
    const config = loadConfig();
    expect(config.default_wallet).toBe('research-bot');
    const entry = config.wallets['research-bot'];
    expect(entry.seed_file).toBe('seeds/research-bot.seed');
    // The CLI resolves seed_file relative to ~/.botwallet
    expect(fs.existsSync(path.join(configDir(), entry.seed_file))).toBe(true);

    // The saved key share and the server's share make the recorded address
    const share = keyShareFromMnemonic(loadSeed('research-bot'));
    expect(base58.encode(computeGroupKey(share.public, serverShare.public))).toBe(entry.public_key);
    expect(entry.public_key).toBe(out.deposit_address);

    expect(sdk.setApiKey).toHaveBeenCalledWith(API_KEY);
    expect(ctx.config).toEqual({ walletName: 'research-bot', hasConfig: true, hasSeed: true });
  });

  it('saves the API key without putting it in the result', async () => {
    const result = await register.handler({ name: 'Research Bot' }, makeCtx(mockSdk(completeResult)));
    const out = parse(result);

    expect(result.content[0].text).not.toContain(API_KEY);
    expect(out.api_key).toBeUndefined();
    expect(out.api_key_saved_to).toBe(path.join(configDir(), 'config.json'));
    expect(loadConfig().wallets['research-bot'].api_key).toBe(API_KEY);
  });

  it('removes the saved key share when the server refuses to create the wallet', async () => {
    const sdk = mockSdk(() => {
      throw new BotWalletError('DKG_VERIFICATION_FAILED' as never, 'Group key mismatch');
    });

    const result = await register.handler({ name: 'Research Bot' }, makeCtx(sdk));

    expect(result.isError).toBe(true);
    expect(parse(result).code).toBe('DKG_VERIFICATION_FAILED');
    expect(seedFiles()).toEqual([]);
    expect(fs.existsSync(path.join(configDir(), 'config.json'))).toBe(false);
  });

  it('keeps the key share and says where it is when the server may have created the wallet', async () => {
    const sdk = mockSdk(() => {
      throw new NetworkError('fetch failed');
    });

    const result = await register.handler({ name: 'Research Bot' }, makeCtx(sdk));
    const out = parse(result);

    expect(result.isError).toBe(true);
    expect(out.code).toBe('REGISTRATION_UNCONFIRMED');
    const file = out.details.key_share_file as string;
    expect(fs.existsSync(file)).toBe(true);
    expect(path.basename(file)).toBe(`.pending-${out.details.deposit_address}.seed`);
    const share = keyShareFromMnemonic(readMnemonic(file));
    expect(base58.encode(computeGroupKey(share.public, serverShare.public))).toBe(out.details.deposit_address);
    expect(out.how_to_fix).toContain(file);
    expect(result.content[0].text).not.toContain(readMnemonic(file));
  });

  it('stops before creating the wallet when the key share cannot be saved', async () => {
    fs.rmSync(seedsDir(), { recursive: true, force: true });
    fs.writeFileSync(seedsDir(), 'not a folder');
    const sdk = mockSdk(completeResult);

    const result = await register.handler({ name: 'Research Bot' }, makeCtx(sdk));

    expect(result.isError).toBe(true);
    expect(parse(result).code).toBe('KEY_SAVE_FAILED');
    expect(parse(result).message).toContain('No wallet was created');
    expect(sdk.dkgComplete).not.toHaveBeenCalled();
  });

  it('still returns the new wallet and where Key 1 is when config.json cannot be updated', async () => {
    fs.writeFileSync(path.join(configDir(), 'config.json'), '{ not json');
    const ctx = makeCtx(mockSdk(completeResult));

    const result = await register.handler({ name: 'Research Bot' }, ctx);
    const out = parse(result);

    expect(result.isError).toBeUndefined();
    expect(out).toMatchObject({ registered: true, api_key: API_KEY, claim_code: 'ABC123' });
    expect(out.warning).toContain('config.json');
    expect(out.key_share_file).toBe(path.join(seedsDir(), 'research-bot.seed'));
    expect(fs.existsSync(out.key_share_file)).toBe(true);
    expect(fs.readFileSync(path.join(configDir(), 'config.json'), 'utf-8')).toBe('{ not json');
    expect(ctx.config.hasSeed).toBe(true);
  });

  it('never overwrites a stray seed file that has the same name', async () => {
    saveSeed('research-bot', OTHER_MNEMONIC);

    const out = parse(await register.handler({ name: 'Research Bot' }, makeCtx(mockSdk(completeResult))));

    expect(out.wallet_name).toBe('research-bot-2');
    expect(loadSeed('research-bot')).toBe(OTHER_MNEMONIC);
    expect(getWallet('research-bot-2')!.seed_file).toBe('seeds/research-bot-2.seed');
  });
});
