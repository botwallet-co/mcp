// Offline tests for botwallet_wallet_backup: Key 1 is revealed only by a
// second call with the one-time code, using the CLI's nonce file.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const testHome = path.join(os.tmpdir(), `bw-backup-test-${Date.now()}`);
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => testHome,
  };
});

import { transferTools } from '../../../src/tools/transfer.js';
import type { BotWallet } from '../../../src/sdk/index.js';
import type { ConfigContext, ToolContext, ToolResult } from '../../../src/types.js';
import { saveSeed } from '../../../src/config/seeds.js';
import { backupNoncePath, checkBackupCode, generateBackupCode } from '../../../src/config/backup-nonce.js';

const walletBackup = transferTools.find(t => t.name === 'botwallet_wallet_backup')!;

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

function makeCtx(config: Partial<ConfigContext> = {}): ToolContext {
  return {
    sdk: {} as BotWallet,
    config: { walletName: 'research-bot', hasConfig: true, hasSeed: true, ...config },
  };
}

function parse(result: ToolResult): Record<string, any> {
  return JSON.parse(result.content[0].text);
}

/** A nonce file as the CLI writes it (json.Marshal of BackupNonce, time.RFC3339). */
function writeGoNonce(code: string, wallet: string, createdAt: Date) {
  const created = createdAt.toISOString().replace(/\.\d{3}Z$/, 'Z');
  fs.writeFileSync(backupNoncePath(), `{"code":"${code}","wallet":"${wallet}","created_at":"${created}"}`);
}

beforeEach(() => {
  fs.mkdirSync(path.join(testHome, '.botwallet', 'seeds'), { recursive: true });
  saveSeed('research-bot', MNEMONIC);
});

afterEach(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe('botwallet_wallet_backup', () => {
  it('first call returns a one-time code, not the words', async () => {
    const result = await walletBackup.handler({}, makeCtx());
    const out = parse(result);

    expect(result.isError).toBeUndefined();
    expect(out).toMatchObject({ action: 'backup_initiated', wallet: 'research-bot', expires_in: '30 seconds' });
    expect(out.code).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]{4}$/);
    expect(out.next_step).toContain(out.code);
    expect(result.content[0].text).not.toContain('abandon');
  });

  it('writes the nonce file the CLI reads', async () => {
    const out = parse(await walletBackup.handler({}, makeCtx()));
    const raw = fs.readFileSync(path.join(testHome, '.botwallet', '.backup-nonce'), 'utf-8');
    const nonce = JSON.parse(raw);

    expect(Object.keys(nonce)).toEqual(['code', 'wallet', 'created_at']);
    expect(nonce).toMatchObject({ code: out.code, wallet: 'research-bot' });
    // Go's time.RFC3339 in UTC, whole seconds
    expect(nonce.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  it('second call with the code reveals the words once', async () => {
    const { code } = parse(await walletBackup.handler({}, makeCtx()));

    const out = parse(await walletBackup.handler({ code }, makeCtx()));
    expect(out).toMatchObject({ wallet: 'research-bot', mnemonic: MNEMONIC });
    expect(fs.existsSync(backupNoncePath())).toBe(false);

    const again = await walletBackup.handler({ code }, makeCtx());
    expect(again.isError).toBe(true);
    expect(parse(again).code).toBe('BACKUP_ERROR');
    expect(again.content[0].text).not.toContain('abandon');
  });

  it('a wrong code reveals nothing and keeps the pending code', async () => {
    const { code } = parse(await walletBackup.handler({}, makeCtx()));
    const wrong = code === 'aaaa' ? 'bbbb' : 'aaaa';

    const result = await walletBackup.handler({ code: wrong }, makeCtx());
    expect(parse(result)).toMatchObject({ code: 'BACKUP_ERROR' });
    expect(result.content[0].text).not.toContain('abandon');

    expect(parse(await walletBackup.handler({ code }, makeCtx())).mnemonic).toBe(MNEMONIC);
  });

  it('an expired code reveals nothing and is removed', async () => {
    writeGoNonce('ab2c', 'research-bot', new Date(Date.now() - 31_000));

    const result = await walletBackup.handler({ code: 'ab2c' }, makeCtx());
    expect(parse(result).code).toBe('BACKUP_ERROR');
    expect(parse(result).message).toContain('expired');
    expect(fs.existsSync(backupNoncePath())).toBe(false);
  });

  it('reveals the wallet the code was made for, from a code the CLI started', async () => {
    saveSeed('other-bot', OTHER_MNEMONIC);
    writeGoNonce('ab2c', 'other-bot', new Date());

    const out = parse(await walletBackup.handler({ code: 'ab2c' }, makeCtx()));
    expect(out).toMatchObject({ wallet: 'other-bot', mnemonic: OTHER_MNEMONIC });
  });

  it('removes an unreadable nonce file', async () => {
    fs.writeFileSync(backupNoncePath(), '{ not json');
    expect(checkBackupCode('ab2c')).toEqual({ ok: false, reason: 'invalid' });
    expect(fs.existsSync(backupNoncePath())).toBe(false);
  });

  it('without a key share, says so before making a code', async () => {
    const result = await walletBackup.handler({}, makeCtx({ hasSeed: false }));
    expect(parse(result).code).toBe('NO_LOCAL_SEED');
    expect(fs.existsSync(backupNoncePath())).toBe(false);
  });

  it('codes use only the CLI\'s alphabet', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateBackupCode()).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]{4}$/);
    }
  });
});
