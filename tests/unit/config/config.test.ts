import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock os.homedir() to use temp directory
const testHome = path.join(os.tmpdir(), `bw-test-${Date.now()}`);
vi.mock('node:os', async () => (await import('../../helpers/temp-home.js')).osWithHome(() => testHome));

import {
  configDir,
  configExists,
  loadConfig,
  saveConfig,
  addWallet,
  getWallet,
  listWallets,
  setDefaultWallet,
  seedFileValue,
  sanitizeWalletName,
  generateLocalName,
  resolveWallet,
  resolveBaseUrl,
  type BotWalletLocalConfig,
  type WalletEntry,
} from '../../../src/config/config.js';
import {
  saveSeed,
  loadSeed,
  seedExists,
  seedFilePath,
  savePendingSeed,
} from '../../../src/config/seeds.js';
import { OTHER_MNEMONIC, TEST_MNEMONIC } from '../../helpers/harness.js';

const seedsPath = () => path.join(testHome, '.botwallet', 'seeds');

function entry(fields: Partial<WalletEntry> = {}): WalletEntry {
  return { username: 'x', api_key: 'x', public_key: 'x', seed_file: 'x', created_at: 'x', ...fields };
}

beforeEach(() => {
  fs.mkdirSync(seedsPath(), { recursive: true });
});

afterEach(() => {
  fs.rmSync(path.join(testHome, '.botwallet'), { recursive: true, force: true });
});

describe('config', () => {
  it('configDir points to test home', () => {
    expect(configDir()).toBe(path.join(testHome, '.botwallet'));
  });

  it('configExists returns false when no config', () => {
    expect(configExists()).toBe(false);
  });

  it('saveConfig and loadConfig round-trip', () => {
    const config: BotWalletLocalConfig = {
      version: 2,
      wallets: {},
    };
    saveConfig(config);
    expect(configExists()).toBe(true);

    const loaded = loadConfig();
    expect(loaded.version).toBe(2);
    expect(loaded.wallets).toEqual({});
  });

  it('loadConfig names the file and the fix when config.json is not valid JSON', () => {
    fs.mkdirSync(configDir(), { recursive: true });
    const file = path.join(configDir(), 'config.json');
    fs.writeFileSync(file, '{"version": 2, "wallets": {');

    expect(() => loadConfig()).toThrow(`${file} is not valid JSON`);
    expect(() => loadConfig()).toThrow('Do not delete it');
    // The broken file is left as it was
    expect(fs.readFileSync(file, 'utf-8')).toBe('{"version": 2, "wallets": {');
  });

  it('loadConfig does not quote the broken text, which may be part of an API key', () => {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(path.join(configDir(), 'config.json'), '{"wallets": {"a": {"api_key": bw_bot_fixture-not-a-real-key}}}');

    expect(() => loadConfig()).toThrow('is not valid JSON');
    try {
      loadConfig();
    } catch (e) {
      expect((e as Error).message).not.toContain('bw_bot');
    }
  });

  it('addWallet creates config and sets default', () => {
    addWallet('test-bot', {
      username: 'clever-byte-1234',
      api_key: 'bw_bot_test',
      public_key: 'deadbeef',
      seed_file: 'seeds/test-bot.seed',
      created_at: '2025-01-01T00:00:00Z',
    });

    const config = loadConfig();
    expect(config.default_wallet).toBe('test-bot');
    expect(config.wallets['test-bot'].username).toBe('clever-byte-1234');
  });

  it('getWallet returns wallet entry', () => {
    addWallet('test-bot', {
      username: 'clever-byte-1234',
      api_key: 'bw_bot_test',
      public_key: 'deadbeef',
      seed_file: 'seeds/test-bot.seed',
      created_at: '2025-01-01T00:00:00Z',
    });

    const wallet = getWallet('test-bot');
    expect(wallet).toBeDefined();
    expect(wallet!.api_key).toBe('bw_bot_test');
  });

  it('getWallet returns undefined for missing', () => {
    addWallet('test-bot', entry());
    expect(getWallet('nonexistent')).toBeUndefined();
  });

  it('the first wallet added becomes the default', () => {
    addWallet('bot-a', entry({ username: 'a', api_key: 'key-a' }));
    addWallet('bot-b', entry({ username: 'b', api_key: 'key-b' }));

    expect(loadConfig().default_wallet).toBe('bot-a');
  });

  it('setDefaultWallet switches default', () => {
    addWallet('bot-a', entry({ username: 'a', api_key: 'key-a' }));
    addWallet('bot-b', entry({ username: 'b', api_key: 'key-b' }));

    setDefaultWallet('bot-b');
    expect(loadConfig().default_wallet).toBe('bot-b');
  });

  it('setDefaultWallet rejects missing wallet', () => {
    addWallet('bot-a', entry({ username: 'a', api_key: 'key-a' }));

    expect(() => setDefaultWallet('nonexistent')).toThrow('not found');
  });

  it('listWallets returns all wallets', () => {
    addWallet('bot-a', entry({ username: 'a', api_key: 'key-a' }));
    addWallet('bot-b', entry({ username: 'b', api_key: 'key-b' }));

    const wallets = listWallets();
    expect(wallets).toHaveLength(2);
    expect(wallets.find(w => w.isDefault)).toBeDefined();
  });

  it('seedFileValue matches the CLI format (relative to ~/.botwallet)', () => {
    expect(seedFileValue('research-bot')).toBe('seeds/research-bot.seed');
    // Resolving it the CLI's way lands on the file saveSeed writes
    expect(path.join(configDir(), seedFileValue('research-bot'))).toBe(seedFilePath('research-bot'));
  });
});

describe('addWallet never replaces a wallet', () => {
  it('refuses an existing name and keeps its API key', () => {
    addWallet('trader', entry({ api_key: 'key-original' }));

    expect(() => addWallet('trader', entry({ api_key: 'key-new' }))).toThrow('already exists');
    expect(getWallet('trader')!.api_key).toBe('key-original');
  });

  it('does not mistake built-in object keys for existing wallets', () => {
    const result = addWallet('constructor', entry({ api_key: 'key-c' }));
    expect(result.totalWallets).toBe(1);
    expect(getWallet('constructor')!.api_key).toBe('key-c');
  });

  it('does not start a new config over an unreadable one', () => {
    fs.writeFileSync(path.join(configDir(), 'config.json'), '{ not json');

    expect(() => addWallet('bot-a', entry())).toThrow();
    expect(fs.readFileSync(path.join(configDir(), 'config.json'), 'utf-8')).toBe('{ not json');
  });

  it('makeDefault switches the default and reports the previous one', () => {
    addWallet('bot-a', entry());
    const result = addWallet('bot-b', entry(), { makeDefault: true });

    expect(result).toEqual({ previousDefault: 'bot-a', totalWallets: 2 });
    expect(loadConfig().default_wallet).toBe('bot-b');
  });

  it('first wallet becomes the default with no previous default', () => {
    const result = addWallet('bot-a', entry(), { makeDefault: true });
    expect(result).toEqual({ previousDefault: undefined, totalWallets: 1 });
  });
});

describe('legacy seed_file repair', () => {
  it('points old "<name>.seed" entries at seeds/ when the file is there', () => {
    saveSeed('old-bot', TEST_MNEMONIC);
    saveConfig({
      version: 2,
      default_wallet: 'old-bot',
      wallets: { 'old-bot': entry({ seed_file: 'old-bot.seed' }) },
    });

    addWallet('new-bot', entry({ seed_file: 'seeds/new-bot.seed' }));

    expect(getWallet('old-bot')!.seed_file).toBe('seeds/old-bot.seed');
  });

  it('leaves entries alone when the file is not in seeds/', () => {
    saveConfig({
      version: 2,
      default_wallet: 'gone',
      wallets: { gone: entry({ seed_file: 'gone.seed' }) },
    });

    setDefaultWallet('gone');

    expect(getWallet('gone')!.seed_file).toBe('gone.seed');
  });
});

describe('local names (port of the CLI rules)', () => {
  it('sanitizeWalletName matches sanitizeFilename in cli-go', () => {
    expect(sanitizeWalletName('My Research Wallet')).toBe('my-research-wallet');
    expect(sanitizeWalletName('  --Weird__Name!! ')).toBe('weirdname');
    expect(sanitizeWalletName('a  -  b')).toBe('a-b');
    expect(sanitizeWalletName('../escaped')).toBe('escaped');
    expect(sanitizeWalletName('..\\..\\evil')).toBe('evil');
    expect(sanitizeWalletName('')).toBe('wallet');
    expect(sanitizeWalletName('!!!')).toBe('wallet');
    expect(sanitizeWalletName('research-bot')).toBe('research-bot');
  });

  it('generateLocalName adds a number when the name is taken', () => {
    expect(generateLocalName('Research Bot')).toBe('research-bot');

    addWallet('research-bot', entry());
    expect(generateLocalName('Research Bot')).toBe('research-bot-2');

    addWallet('research-bot-2', entry());
    expect(generateLocalName('research-bot')).toBe('research-bot-3');
  });

  it('generateLocalName skips names whose seed file exists without a config entry', () => {
    saveSeed('stray', TEST_MNEMONIC);
    expect(generateLocalName('stray')).toBe('stray-2');
  });
});

describe('resolveWallet (API key and key share always belong together)', () => {
  beforeEach(() => {
    addWallet('bot-a', entry({ api_key: 'key-a' }));
    addWallet('bot-b', entry({ api_key: 'key-b' }));
  });

  it('uses the default wallet without env vars', () => {
    expect(resolveWallet({})).toEqual({ name: 'bot-a', apiKey: 'key-a', warnings: [] });
  });

  it('uses BOTWALLET_WALLET when set', () => {
    expect(resolveWallet({ BOTWALLET_WALLET: 'bot-b' })).toEqual({ name: 'bot-b', apiKey: 'key-b', warnings: [] });
  });

  it('fails when BOTWALLET_WALLET names a missing wallet, listing the available ones', () => {
    expect(() => resolveWallet({ BOTWALLET_WALLET: 'bot-z' })).toThrow(/bot-z.*Available wallets: bot-a, bot-b/);
  });

  it('picks the key share of the wallet that holds BOTWALLET_API_KEY, not the default', () => {
    expect(resolveWallet({ BOTWALLET_API_KEY: 'key-b' })).toEqual({ name: 'bot-b', apiKey: 'key-b', warnings: [] });
  });

  it('accepts BW_API_KEY like the CLI does', () => {
    expect(resolveWallet({ BW_API_KEY: 'key-b' }).name).toBe('bot-b');
  });

  it('warns when BOTWALLET_WALLET and BOTWALLET_API_KEY disagree, and follows the key', () => {
    const resolved = resolveWallet({ BOTWALLET_API_KEY: 'key-b', BOTWALLET_WALLET: 'bot-a' });
    expect(resolved.name).toBe('bot-b');
    expect(resolved.warnings[0]).toContain('belongs to "bot-b"');
  });

  it('turns signing off when BOTWALLET_API_KEY matches no wallet', () => {
    const resolved = resolveWallet({ BOTWALLET_API_KEY: 'key-unknown' });
    expect(resolved.name).toBeUndefined();
    expect(resolved.apiKey).toBe('key-unknown');
    expect(resolved.warnings[0]).toContain('does not belong to any wallet');
  });

  it('keeps an env key with a selected wallet that has no API key stored (older imports)', () => {
    addWallet('legacy', entry({ api_key: '' }));
    const resolved = resolveWallet({ BOTWALLET_API_KEY: 'key-legacy', BOTWALLET_WALLET: 'legacy' });
    expect(resolved).toEqual({ name: 'legacy', apiKey: 'key-legacy', warnings: [] });
  });

  it('does not fail on a missing BOTWALLET_WALLET when the env key decides', () => {
    const resolved = resolveWallet({ BOTWALLET_API_KEY: 'key-a', BOTWALLET_WALLET: 'bot-z' });
    expect(resolved.name).toBe('bot-a');
    expect(resolved.warnings[0]).toContain('bot-z');
  });
});

describe('resolveWallet without config.json', () => {
  it('env-only setup without a seed file: key only, no warning', () => {
    expect(resolveWallet({ BOTWALLET_API_KEY: 'key-x' })).toEqual({ name: undefined, apiKey: 'key-x', warnings: [] });
  });

  it('env-only setup that pairs the key with a seed file by name', () => {
    saveSeed('solo', TEST_MNEMONIC);
    expect(resolveWallet({ BOTWALLET_API_KEY: 'key-x', BOTWALLET_WALLET: 'solo' }))
      .toEqual({ name: 'solo', apiKey: 'key-x', warnings: [] });
  });

  it('nothing set: nothing resolved', () => {
    expect(resolveWallet({})).toEqual({ name: undefined, apiKey: undefined, warnings: [] });
  });
});

describe('resolveBaseUrl (same order as GetBaseURL in the CLI)', () => {
  const API_URL = 'https://api-url.example.test/v1';
  const BASE_URL = 'https://base-url.example.test/v1';
  const CONFIG_URL = 'https://config.example.test/v1';
  const withConfigUrl = () => saveConfig({ version: 2, wallets: {}, base_url: CONFIG_URL });

  it('BOTWALLET_API_URL comes first, as in the CLI', () => {
    withConfigUrl();
    expect(resolveBaseUrl({ BOTWALLET_API_URL: API_URL, BOTWALLET_BASE_URL: BASE_URL })).toBe(API_URL);
  });

  it('still reads BOTWALLET_BASE_URL, which older versions documented', () => {
    withConfigUrl();
    expect(resolveBaseUrl({ BOTWALLET_BASE_URL: BASE_URL })).toBe(BASE_URL);
  });

  it('then base_url in config.json, which the CLI also honours', () => {
    withConfigUrl();
    expect(resolveBaseUrl({})).toBe(CONFIG_URL);
  });

  it('otherwise leaves it to the SDK default', () => {
    expect(resolveBaseUrl({})).toBeUndefined();
    saveConfig({ version: 2, wallets: {} });
    expect(resolveBaseUrl({})).toBeUndefined();
  });

  it('does not fail on an unreadable config.json', () => {
    fs.writeFileSync(path.join(testHome, '.botwallet', 'config.json'), '{ not json');
    expect(resolveBaseUrl({})).toBeUndefined();
  });
});

describe('seeds', () => {
  it('saveSeed and loadSeed round-trip', () => {
    saveSeed('test-bot', TEST_MNEMONIC);

    expect(seedExists('test-bot')).toBe(true);

    const loaded = loadSeed('test-bot');
    expect(loaded).toBe(TEST_MNEMONIC);
  });

  it('saveSeed never overwrites an existing key share', () => {
    saveSeed('trader', TEST_MNEMONIC);

    expect(() => saveSeed('trader', OTHER_MNEMONIC)).toThrow(/EEXIST/);
    expect(loadSeed('trader')).toBe(TEST_MNEMONIC);
  });

  it('refuses names that could leave the seeds folder', () => {
    for (const bad of ['../escaped', 'a/b', 'a\\b', '', ' ', '..', '.']) {
      expect(() => saveSeed(bad, TEST_MNEMONIC)).toThrow('Invalid wallet name');
      expect(() => loadSeed(bad)).toThrow('Invalid wallet name');
      expect(seedExists(bad)).toBe(false);
    }
    expect(fs.existsSync(path.join(testHome, '.botwallet', 'escaped.seed'))).toBe(false);
  });

  it('keeps reading seed files saved under unsanitized names by older versions', () => {
    fs.writeFileSync(path.join(seedsPath(), 'My Research Wallet.seed'), `${TEST_MNEMONIC}\n`);
    expect(loadSeed('My Research Wallet')).toBe(TEST_MNEMONIC);
  });

  it('savePendingSeed names the file by the wallet address', () => {
    const address = '5DewmSGWjgidikL4eH1brrzxA3XG8esJ1fKE11wbtHkd';
    const file = savePendingSeed(address, TEST_MNEMONIC);

    expect(file).toBe(path.join(seedsPath(), `.pending-${address}.seed`));
    expect(fs.readFileSync(file, 'utf-8')).toContain(TEST_MNEMONIC);
    expect(() => savePendingSeed('../not-an-address', TEST_MNEMONIC)).toThrow('Invalid wallet address');
  });

  it('seedExists returns false for missing', () => {
    expect(seedExists('nonexistent')).toBe(false);
  });

  it('loadSeed throws for missing seed', () => {
    expect(() => loadSeed('nonexistent')).toThrow('not found');
  });

  it('loadSeed strips comments', () => {
    const file = path.join(seedsPath(), 'commented.seed');
    fs.writeFileSync(file, [
      '# BotWallet FROST Key Share',
      '# Wallet: test',
      '',
      TEST_MNEMONIC,
      '',
    ].join('\n'));

    const mnemonic = loadSeed('commented');
    expect(mnemonic).toBe(TEST_MNEMONIC);
  });
});
