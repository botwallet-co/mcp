import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock os.homedir() to use temp directory
const testHome = path.join(os.tmpdir(), `bw-test-${Date.now()}`);
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => testHome,
  };
});

import {
  configDir,
  configExists,
  loadConfig,
  saveConfig,
  addWallet,
  getWallet,
  getDefaultWallet,
  listWallets,
  setDefaultWallet,
  type BotWalletLocalConfig,
} from '../../../src/config/config.js';
import { saveSeed, loadSeed, seedExists } from '../../../src/config/seeds.js';

beforeEach(() => {
  fs.mkdirSync(path.join(testHome, '.botwallet', 'seeds'), { recursive: true });
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

  it('addWallet creates config and sets default', () => {
    addWallet('test-bot', {
      username: 'clever-byte-1234',
      api_key: 'bw_bot_test',
      public_key: 'deadbeef',
      seed_file: 'test-bot.seed',
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
      seed_file: 'test-bot.seed',
      created_at: '2025-01-01T00:00:00Z',
    });

    const wallet = getWallet('test-bot');
    expect(wallet).toBeDefined();
    expect(wallet!.api_key).toBe('bw_bot_test');
  });

  it('getWallet returns undefined for missing', () => {
    addWallet('test-bot', {
      username: 'x', api_key: 'x', public_key: 'x', seed_file: 'x', created_at: 'x',
    });
    expect(getWallet('nonexistent')).toBeUndefined();
  });

  it('getDefaultWallet returns default', () => {
    addWallet('bot-a', {
      username: 'a', api_key: 'key-a', public_key: 'x', seed_file: 'x', created_at: 'x',
    });
    addWallet('bot-b', {
      username: 'b', api_key: 'key-b', public_key: 'x', seed_file: 'x', created_at: 'x',
    });

    const def = getDefaultWallet();
    expect(def).toBeDefined();
    // First wallet added becomes default
    expect(def!.name).toBe('bot-a');
  });

  it('setDefaultWallet switches default', () => {
    addWallet('bot-a', {
      username: 'a', api_key: 'key-a', public_key: 'x', seed_file: 'x', created_at: 'x',
    });
    addWallet('bot-b', {
      username: 'b', api_key: 'key-b', public_key: 'x', seed_file: 'x', created_at: 'x',
    });

    setDefaultWallet('bot-b');
    const def = getDefaultWallet();
    expect(def!.name).toBe('bot-b');
  });

  it('setDefaultWallet rejects missing wallet', () => {
    addWallet('bot-a', {
      username: 'a', api_key: 'key-a', public_key: 'x', seed_file: 'x', created_at: 'x',
    });

    expect(() => setDefaultWallet('nonexistent')).toThrow('not found');
  });

  it('listWallets returns all wallets', () => {
    addWallet('bot-a', {
      username: 'a', api_key: 'key-a', public_key: 'x', seed_file: 'x', created_at: 'x',
    });
    addWallet('bot-b', {
      username: 'b', api_key: 'key-b', public_key: 'x', seed_file: 'x', created_at: 'x',
    });

    const wallets = listWallets();
    expect(wallets).toHaveLength(2);
    expect(wallets.find(w => w.isDefault)).toBeDefined();
  });
});

describe('seeds', () => {
  it('saveSeed and loadSeed round-trip', () => {
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    saveSeed('test-bot', mnemonic);

    expect(seedExists('test-bot')).toBe(true);

    const loaded = loadSeed('test-bot');
    expect(loaded).toBe(mnemonic);
  });

  it('seedExists returns false for missing', () => {
    expect(seedExists('nonexistent')).toBe(false);
  });

  it('loadSeed throws for missing seed', () => {
    expect(() => loadSeed('nonexistent')).toThrow('not found');
  });

  it('loadSeed strips comments', () => {
    const seedsPath = path.join(testHome, '.botwallet', 'seeds', 'commented.seed');
    fs.writeFileSync(seedsPath, [
      '# BotWallet FROST Key Share',
      '# Wallet: test',
      '',
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      '',
    ].join('\n'));

    const mnemonic = loadSeed('commented');
    expect(mnemonic).toBe('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  });
});
