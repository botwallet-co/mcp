// Offline tests for botwallet_wallet_export / botwallet_wallet_import.
// The SDK is mocked; files go to a temporary home directory.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const testHome = path.join(os.tmpdir(), `bw-transfer-test-${Date.now()}`);
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => testHome,
  };
});

import { transferTools } from '../../../src/tools/transfer.js';
import { BotWalletError, type BotWallet } from '../../../src/sdk/index.js';
import type { ConfigContext, ToolContext, ToolResult } from '../../../src/types.js';
import { addWallet, configDir, getWallet, loadConfig } from '../../../src/config/config.js';
import { loadSeed, saveSeed } from '../../../src/config/seeds.js';
import { decryptPayload, encryptPayload, readBwlt, writeBwlt } from '../../../src/config/bwlt.js';

const walletExport = transferTools.find(t => t.name === 'botwallet_wallet_export')!;
const walletImport = transferTools.find(t => t.name === 'botwallet_wallet_import')!;

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const ADDRESS = '5DewmSGWjgidikL4eH1brrzxA3XG8esJ1fKE11wbtHkd';
const API_KEY = 'bw_bot_fixture-not-a-real-key';
const EXPORT_ID = '0f8e4c2a-5b1d-4e6f-9a3c-7d2e1b0a9c8f';
const KEY_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const KEY = Uint8Array.from(Buffer.from(KEY_B64, 'base64'));

// Written by the CLI's own code: cli-go config.EncryptPayload + config.WriteBWLT,
// with the payload map and json.Marshal from `botwallet wallet export`
// (cmd/wallet.go), key bytes 0..31 and the values above:
// {"api_key":"bw_bot_fixture-not-a-real-key","exported_at":"2026-10-04T12:00:00Z",
//  "public_key":"5Dewm...tHkd","seed":"abandon ... about","username":"research-bot",
//  "version":1,"wallet_name":"Research Bot"}
const GO_EXPORT_BWLT =
  'QldMVAEAAAAwZjhlNGMyYS01YjFkLTRlNmYtOWEzYy03ZDJlMWIwYTljOGaORqg7DJtKAHVjp0kC14sEjpNQ8K0s7EaewOscOUuI6LBBMhB4' +
  '9bCW4EoLDICQ7zcxyyaw7Oo4IoiKDGmLnhtjgUrnAStq+O56IJ7J5LpUwo4LtDMqMpIP67+KDQ4o282k9lxLxvf9sxikGmcZ+VOKqeOmQQ/W' +
  'yfjwHygs/slzOCq4fVlmzrdjQtY5YJRF6vHqLwnFD/3KYl9Pjh9SZMXNvMvQzTXkJf6q9r3wR6hH4IlDXtA4RkG40Xyp4SqYKRWDJ6mkmqjC' +
  'h+vucoOVOGFkLQ1t//MhjGIJaXccbUiBKZavhVsfu1E+F4lbKN6fxwVMFN3qasT9dI1qtEv2hED9s/46D5VSIR4dZ2GciZJC0m7Bgny8eThv' +
  'T9PZw/Zj5Rur73OG0JAwvBaT/B+Y3DkpPvSDmXfLK/+B2Hq2fu9B/lXoX0VIzLHWedC7f7cMEFo01Q==';

// Fields the CLI's import requires (cmd/wallet.go): it rejects a file missing any of them
const GO_REQUIRED_FIELDS = ['api_key', 'seed', 'username', 'public_key'];
const GO_PAYLOAD_FIELDS = ['api_key', 'exported_at', 'public_key', 'seed', 'username', 'version', 'wallet_name'];

function mockSdk(methods: Record<string, unknown> = {}): BotWallet {
  return {
    setApiKey: vi.fn(),
    getApiKey: vi.fn(),
    walletImportKey: vi.fn().mockResolvedValue({ encryption_key: KEY_B64 }),
    ...methods,
  } as unknown as BotWallet;
}

function makeCtx(sdk: BotWallet, config: Partial<ConfigContext> = {}): ToolContext {
  return { sdk, config: { walletName: undefined, hasConfig: false, hasSeed: false, ...config } };
}

function parse(result: ToolResult): Record<string, any> {
  return JSON.parse(result.content[0].text);
}

function writeTestBwlt(name: string, payload: unknown): string {
  const { nonce, ciphertext } = encryptPayload(KEY, new TextEncoder().encode(JSON.stringify(payload)));
  const file = path.join(testHome, name);
  writeBwlt(file, EXPORT_ID, nonce, ciphertext);
  return file;
}

function fullPayload(fields: Record<string, unknown> = {}) {
  return {
    version: 1,
    wallet_name: 'Research Bot',
    username: 'research-bot',
    api_key: API_KEY,
    public_key: ADDRESS,
    seed: MNEMONIC,
    exported_at: '2026-10-04T12:00:00Z',
    ...fields,
  };
}

function seedFiles(): string[] {
  const dir = path.join(configDir(), 'seeds');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

beforeEach(() => {
  fs.mkdirSync(path.join(testHome, '.botwallet', 'seeds'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe('botwallet_wallet_import', () => {
  it('imports a .bwlt file written by the Go CLI, with its API key', async () => {
    const file = path.join(testHome, 'go-export.bwlt');
    fs.writeFileSync(file, Buffer.from(GO_EXPORT_BWLT, 'base64'));
    const sdk = mockSdk();
    const ctx = makeCtx(sdk);

    const result = await walletImport.handler({ file_path: file }, ctx);
    const out = parse(result);

    expect(result.isError).toBeUndefined();
    expect(out).toMatchObject({
      imported: true,
      wallet_name: 'research-bot',
      username: 'research-bot',
      deposit_address: ADDRESS,
      is_default: true,
    });
    expect(sdk.walletImportKey).toHaveBeenCalledWith({ export_id: EXPORT_ID });

    const config = loadConfig();
    expect(config.default_wallet).toBe('research-bot');
    expect(config.wallets['research-bot']).toMatchObject({
      username: 'research-bot',
      display_name: 'Research Bot',
      api_key: API_KEY,
      public_key: ADDRESS,
      seed_file: 'seeds/research-bot.seed',
    });
    // The CLI resolves seed_file relative to ~/.botwallet when signing
    expect(fs.existsSync(path.join(configDir(), config.wallets['research-bot'].seed_file))).toBe(true);
    expect(loadSeed('research-bot')).toBe(MNEMONIC);

    // Activated for this session, and the API key is not echoed back
    expect(sdk.setApiKey).toHaveBeenCalledWith(API_KEY);
    expect(ctx.config).toEqual({ walletName: 'research-bot', hasConfig: true, hasSeed: true });
    expect(result.content[0].text).not.toContain(API_KEY);
  });

  it('never overwrites an existing wallet with the same name', async () => {
    saveSeed('research-bot', OTHER_MNEMONIC);
    addWallet('research-bot', {
      username: 'other-bot', api_key: 'key-original', public_key: 'x',
      seed_file: 'seeds/research-bot.seed', created_at: 'x',
    });

    const out = parse(await walletImport.handler(
      { file_path: writeTestBwlt('a.bwlt', fullPayload()) }, makeCtx(mockSdk()),
    ));

    expect(out.wallet_name).toBe('research-bot-2');
    expect(out.previous_default).toBe('research-bot');
    expect(out.note).toContain('previous default was "research-bot"');
    expect(loadSeed('research-bot')).toBe(OTHER_MNEMONIC);
    expect(getWallet('research-bot')!.api_key).toBe('key-original');
    expect(loadSeed('research-bot-2')).toBe(MNEMONIC);
    expect(getWallet('research-bot-2')!.api_key).toBe(API_KEY);
    expect(loadConfig().default_wallet).toBe('research-bot-2');
  });

  it('importing the same file twice keeps the first copy intact', async () => {
    const file = writeTestBwlt('a.bwlt', fullPayload());
    await walletImport.handler({ file_path: file }, makeCtx(mockSdk()));
    const second = parse(await walletImport.handler({ file_path: file }, makeCtx(mockSdk())));

    expect(second.wallet_name).toBe('research-bot-2');
    expect(getWallet('research-bot')!.api_key).toBe(API_KEY);
    expect(loadSeed('research-bot')).toBe(MNEMONIC);
  });

  it('keeps a wallet name from the file inside the seeds folder', async () => {
    const out = parse(await walletImport.handler(
      { file_path: writeTestBwlt('a.bwlt', fullPayload({ wallet_name: '../../escaped' })) }, makeCtx(mockSdk()),
    ));

    expect(out.wallet_name).toBe('escaped');
    expect(seedFiles()).toEqual(['escaped.seed']);
    expect(fs.existsSync(path.join(testHome, 'escaped.seed'))).toBe(false);
    expect(fs.existsSync(path.join(configDir(), 'escaped.seed'))).toBe(false);
  });

  it('uses the name argument like the CLI --name flag', async () => {
    const out = parse(await walletImport.handler(
      { file_path: writeTestBwlt('a.bwlt', fullPayload()), name: 'My Copy' }, makeCtx(mockSdk()),
    ));

    expect(out.wallet_name).toBe('my-copy');
    expect(getWallet('my-copy')!.display_name).toBe('My Copy');
  });

  it('rejects a file from an older MCP version (no API key) before writing anything', async () => {
    const result = await walletImport.handler({
      file_path: writeTestBwlt('old.bwlt', { wallet_name: 'trader', seed: MNEMONIC, exported_at: '2026-01-01T00:00:00.000Z' }),
    }, makeCtx(mockSdk()));

    expect(result.isError).toBe(true);
    expect(parse(result).code).toBe('IMPORT_ERROR');
    expect(parse(result).message).toContain('missing the wallet\'s API key');
    expect(fs.existsSync(path.join(configDir(), 'config.json'))).toBe(false);
    expect(seedFiles()).toEqual([]);
  });

  it.each(GO_REQUIRED_FIELDS)('rejects a file without %s', async (field) => {
    const result = await walletImport.handler(
      { file_path: writeTestBwlt('a.bwlt', fullPayload({ [field]: '' })) }, makeCtx(mockSdk()),
    );

    expect(result.isError).toBe(true);
    expect(seedFiles()).toEqual([]);
  });

  it('rejects a key share that is not a valid 12-word phrase', async () => {
    const result = await walletImport.handler(
      { file_path: writeTestBwlt('a.bwlt', fullPayload({ seed: 'not a valid phrase at all' })) }, makeCtx(mockSdk()),
    );

    expect(result.isError).toBe(true);
    expect(parse(result).message).toContain('not a valid 12-word phrase');
    expect(seedFiles()).toEqual([]);
  });

  it('explains an expired or revoked export', async () => {
    const sdk = mockSdk({
      walletImportKey: vi.fn().mockRejectedValue(new BotWalletError('NOT_FOUND', 'Export not found or has been revoked')),
    });

    const result = await walletImport.handler({ file_path: writeTestBwlt('a.bwlt', fullPayload()) }, makeCtx(sdk));

    expect(result.isError).toBe(true);
    expect(parse(result).message).toContain('24 hours');
    expect(seedFiles()).toEqual([]);
  });

  it('removes the new seed file when config.json cannot be updated', async () => {
    fs.writeFileSync(path.join(configDir(), 'config.json'), '{ not json');

    const result = await walletImport.handler(
      { file_path: writeTestBwlt('a.bwlt', fullPayload()) }, makeCtx(mockSdk()),
    );

    expect(result.isError).toBe(true);
    expect(seedFiles()).toEqual([]);
    expect(fs.readFileSync(path.join(configDir(), 'config.json'), 'utf-8')).toBe('{ not json');
  });
});

describe('botwallet_wallet_export', () => {
  function setUpWallet() {
    saveSeed('research-bot', MNEMONIC);
    addWallet('research-bot', {
      username: 'research-bot', display_name: 'Research Bot', api_key: API_KEY, public_key: ADDRESS,
      seed_file: 'seeds/research-bot.seed', created_at: '2026-10-01T00:00:00Z',
    });
  }

  function exportSdk(info: Record<string, unknown> = {}) {
    return mockSdk({
      getApiKey: vi.fn().mockReturnValue(API_KEY),
      info: vi.fn().mockResolvedValue({ username: 'research-bot', name: 'Research Bot', deposit_address: ADDRESS, ...info }),
      walletExport: vi.fn().mockResolvedValue({ export_id: EXPORT_ID, encryption_key: KEY_B64 }),
    });
  }

  const walletCtx = (sdk: BotWallet) => makeCtx(sdk, { walletName: 'research-bot', hasConfig: true, hasSeed: true });

  it('writes the CLI payload with every field the CLI import requires', async () => {
    setUpWallet();
    const out = parse(await walletExport.handler(
      { output_path: path.join(testHome, 'my-wallet') }, walletCtx(exportSdk()),
    ));

    expect(out.exported).toBe(true);
    expect(out.path).toBe(path.join(testHome, 'my-wallet.bwlt'));
    expect(JSON.stringify(out)).not.toContain(API_KEY);

    const file = readBwlt(out.path);
    expect(file.exportId).toBe(EXPORT_ID);
    const payload = JSON.parse(new TextDecoder().decode(decryptPayload(KEY, file.nonce, file.ciphertext)));

    expect(Object.keys(payload).sort()).toEqual(GO_PAYLOAD_FIELDS);
    for (const field of GO_REQUIRED_FIELDS) {
      expect(payload[field]).toBeTruthy();
    }
    expect(payload).toMatchObject({
      version: 1,
      wallet_name: 'Research Bot',
      username: 'research-bot',
      api_key: API_KEY,
      public_key: ADDRESS,
      seed: MNEMONIC,
    });
    expect(payload.exported_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  it('refuses to overwrite an existing file, before asking the server', async () => {
    setUpWallet();
    const existing = path.join(testHome, 'taken.bwlt');
    fs.writeFileSync(existing, 'keep me');
    const sdk = exportSdk();

    const result = await walletExport.handler({ output_path: existing }, walletCtx(sdk));

    expect(parse(result).code).toBe('FILE_EXISTS');
    expect(sdk.walletExport).not.toHaveBeenCalled();
    expect(fs.readFileSync(existing, 'utf-8')).toBe('keep me');
  });

  it('refuses a path inside ~/.botwallet, before asking the server', async () => {
    setUpWallet();
    const sdk = exportSdk();
    const seedFile = path.join(configDir(), 'seeds', 'research-bot.seed');
    const before = fs.readFileSync(seedFile, 'utf-8');

    for (const target of [
      seedFile,
      path.join(configDir(), 'seeds', 'other'),
      path.join(configDir(), 'config.json'),
      path.join(testHome, 'docs', '..', '.botwallet', 'export.bwlt'),
    ]) {
      const result = await walletExport.handler({ output_path: target }, walletCtx(sdk));
      expect(parse(result).code).toBe('INVALID_PATH');
    }

    expect(sdk.walletExport).not.toHaveBeenCalled();
    expect(fs.readFileSync(seedFile, 'utf-8')).toBe(before);
    expect(seedFiles()).toEqual(['research-bot.seed']);
  });

  it('accepts a folder whose name only starts like ~/.botwallet', async () => {
    setUpWallet();
    fs.mkdirSync(path.join(testHome, '.botwallet-exports'));
    const out = parse(await walletExport.handler(
      { output_path: path.join(testHome, '.botwallet-exports', 'w.bwlt') }, walletCtx(exportSdk()),
    ));
    expect(out.exported).toBe(true);
    expect(out.path).toBe(path.join(testHome, '.botwallet-exports', 'w.bwlt'));
  });

  it('refuses when the local key share is recorded for another wallet than the API key opens', async () => {
    setUpWallet();
    const sdk = exportSdk({ deposit_address: '11111111111111111111111111111111' });

    const result = await walletExport.handler({ output_path: path.join(testHome, 'x.bwlt') }, walletCtx(sdk));

    expect(parse(result).code).toBe('WALLET_MISMATCH');
    expect(sdk.walletExport).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(testHome, 'x.bwlt'))).toBe(false);
  });

  it('fills in the username and address of entries left incomplete by older imports', async () => {
    saveSeed('research-bot', MNEMONIC);
    addWallet('research-bot', {
      username: 'Research Bot', api_key: '', public_key: '', seed_file: 'research-bot.seed', created_at: 'x',
    });

    const out = parse(await walletExport.handler(
      { output_path: path.join(testHome, 'x.bwlt') }, walletCtx(exportSdk()),
    ));
    const file = readBwlt(out.path);
    const payload = JSON.parse(new TextDecoder().decode(decryptPayload(KEY, file.nonce, file.ciphertext)));

    expect(payload).toMatchObject({ username: 'research-bot', public_key: ADDRESS, api_key: API_KEY });
  });

  it('round-trips: an MCP export imports on a fresh machine with its API key', async () => {
    setUpWallet();
    const out = parse(await walletExport.handler(
      { output_path: path.join(testHome, 'move.bwlt') }, walletCtx(exportSdk()),
    ));

    fs.rmSync(configDir(), { recursive: true, force: true });
    const sdk = mockSdk();
    const imported = parse(await walletImport.handler({ file_path: out.path }, makeCtx(sdk)));

    expect(imported.wallet_name).toBe('research-bot');
    expect(getWallet('research-bot')).toMatchObject({ api_key: API_KEY, public_key: ADDRESS, username: 'research-bot' });
    expect(loadSeed('research-bot')).toBe(MNEMONIC);
    expect(sdk.setApiKey).toHaveBeenCalledWith(API_KEY);
  });
});
