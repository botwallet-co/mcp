// Moving a wallet to another machine (.bwlt export and import) and revealing
// Key 1 for the owner's backup. The file formats are in config/.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { KEY_MATERIAL } from '../utils/annotations.js';
import { BotWalletError } from '../sdk/index.js';
import { formatResult, toolError } from '../utils/tool-result.js';
import { errorMessage, noSeedError, noConfigError } from '../utils/errors.js';
import { base64ToBytes } from '../utils/bytes.js';
import {
  configDir,
  loadSeed,
  saveSeed,
  seedExists,
  removeNewSeed,
  addWallet,
  getWallet,
  generateLocalName,
  seedFileValue,
  envOverrideNote,
  writeBwlt,
  readBwlt,
  encryptPayload,
  decryptPayload,
  encodeBwltPayload,
  parseBwltPayload,
  BwltPayloadError,
  generateBackupCode,
  writeBackupNonce,
  checkBackupCode,
  type AddWalletResult,
  type BackupCodeCheck,
  type BwltPayload,
} from '../config/index.js';
import { defineTool } from './define.js';

const walletExport = defineTool({
  name: 'botwallet_wallet_export',
  annotations: KEY_MATERIAL,
  description:
    'Export the current wallet to an encrypted .bwlt file, to move it to another machine ' +
    '(same format as the Botwallet CLI). The file holds this wallet\'s Key 1 and API key, ' +
    'encrypted with a key that the Botwallet server releases on import. ' +
    'Anyone with the file can import the wallet within 24 hours (5 imports at most); after that it can no longer ' +
    'be imported, so it is not a long-term backup. Treat the file like the 12 words. An existing file is never overwritten.',
  inputSchema: z.object({
    output_path: z.string()
      .describe('Where to save the .bwlt file, best as a full path (e.g. "/home/me/my-wallet.bwlt"). ' +
        'A relative path is taken from the folder this MCP server runs in; the result gives the full path. ' +
        '".bwlt" is added if missing. It can\'t be inside ~/.botwallet.'),
  }),
  async run(args, ctx) {
    if (!ctx.config.hasConfig || !ctx.config.walletName) {
      return noConfigError('export wallet');
    }
    if (!ctx.config.hasSeed) {
      return noSeedError('export wallet', ctx.config.walletName);
    }

    const { output_path } = args;
    const walletName = ctx.config.walletName;

    // Same file rules as the CLI: .bwlt extension, never overwrite a file
    let outPath = path.resolve(output_path);
    if (!outPath.toLowerCase().endsWith('.bwlt')) {
      outPath += '.bwlt';
    }
    // ~/.botwallet holds the wallets' own files (config.json, key shares).
    // An export never belongs there, so a mistaken or injected path can't
    // put files next to them.
    if (isInside(configDir(), outPath)) {
      return toolError('INVALID_PATH', `Can't save the export inside ${configDir()}: that folder holds the wallets' own files.`,
        'Choose a path in another folder, e.g. your home or documents folder.');
    }
    if (fs.existsSync(outPath)) {
      return toolError('FILE_EXISTS', `File already exists: ${outPath}`,
        'Use a different path or delete the existing file first.');
    }

    const mnemonic = loadSeed(walletName);
    const apiKey = ctx.sdk.getApiKey();
    if (!apiKey) {
      return toolError('NO_API_KEY', `Cannot export wallet "${walletName}": its API key is not available.`,
        'A .bwlt file without the API key cannot restore the wallet. Set up the wallet\'s API key first.');
    }

    // The file must restore a working wallet, so take the username and address
    // from the server for the wallet this API key opens, and make sure the
    // local key share is recorded for that same wallet.
    const info = await ctx.sdk.info();
    const entry = getWallet(walletName);
    if (entry?.public_key && entry.public_key !== info.deposit_address) {
      return toolError('WALLET_MISMATCH',
        `The local wallet "${walletName}" (address ${entry.public_key}) is not the wallet ` +
        `this API key opens (address ${info.deposit_address}). Nothing was exported.`,
        'Switch to the right wallet with botwallet_wallet_use, or fix BOTWALLET_API_KEY, then export again.');
    }

    // Get encryption key from server (returned as base64)
    const exportResult = await ctx.sdk.walletExport();
    const key = base64ToBytes(exportResult.encryption_key);

    // Same payload as the CLI, which refuses files without these fields
    const plaintext = encodeBwltPayload({
      wallet_name: entry?.display_name || info.name || info.username,
      username: info.username,
      api_key: apiKey,
      public_key: info.deposit_address,
      seed: mnemonic,
    });

    const { nonce, ciphertext } = encryptPayload(key, plaintext);
    try {
      writeBwlt(outPath, exportResult.export_id, nonce, ciphertext);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        return toolError('FILE_EXISTS', `File already exists: ${outPath}`,
          'Use a different path or delete the existing file first.');
      }
      throw e;
    }

    // Read the file back, as the CLI does, so a bad write shows up now and not at import time
    let verified = false;
    try {
      const check = readBwlt(outPath);
      verified = check.exportId === exportResult.export_id &&
        Buffer.from(check.nonce).equals(Buffer.from(nonce)) &&
        Buffer.from(check.ciphertext).equals(Buffer.from(ciphertext));
    } catch {
      verified = false;
    }
    if (!verified) {
      fs.rmSync(outPath, { force: true });
      return toolError('EXPORT_FAILED', 'The exported file did not read back correctly and has been deleted.',
        'Try again. If it keeps failing, check the disk.');
    }

    return formatResult({
      exported: true,
      path: outPath,
      wallet_name: walletName,
      export_id: exportResult.export_id,
      message: 'Wallet exported. Import it on the other machine with botwallet_wallet_import ' +
        '(or "botwallet wallet import") within 24 hours; it can be imported 5 times at most. ' +
        'The file holds Key 1 and the API key, so keep it private.',
    });
  },
});

const walletImport = defineTool({
  name: 'botwallet_wallet_import',
  annotations: KEY_MATERIAL,
  description:
    'Import a wallet from a .bwlt file made by botwallet_wallet_export or the Botwallet CLI. ' +
    'Gets the decryption key from the server, saves the key share and API key locally under a new name ' +
    '(an existing wallet is never replaced), and makes the imported wallet the default.',
  inputSchema: z.object({
    file_path: z.string()
      .describe('Path to the .bwlt file to import'),
    name: z.string().min(1).max(50).optional()
      .describe('Local name for the wallet (default: the name stored in the file). A number is added if the name is taken.'),
  }),
  async run(args, ctx) {
    const { file_path, name } = args;

    // Read and parse .bwlt file
    const bwlt = readBwlt(file_path);

    // Get decryption key from server (no auth required — uses export_id, returned as base64)
    let encryptionKey: string;
    try {
      encryptionKey = (await ctx.sdk.walletImportKey({ export_id: bwlt.exportId })).encryption_key;
    } catch (e) {
      if (e instanceof BotWalletError && (e.code === 'NOT_FOUND' || e.code === 'EXPORT_EXPIRED')) {
        return toolError(e.code,
          'This export can no longer be imported: it was revoked, is more than 24 hours old, or was already imported 5 times.',
          'Export the wallet again on the machine that has it.');
      }
      throw e;
    }

    let plaintext: Uint8Array;
    try {
      plaintext = decryptPayload(base64ToBytes(encryptionKey), bwlt.nonce, bwlt.ciphertext);
    } catch {
      return toolError('IMPORT_ERROR', 'The .bwlt file could not be decrypted. It may be corrupted or modified.',
        'Export the wallet again.');
    }

    // Check every field before anything is written to disk
    let payload: BwltPayload;
    try {
      payload = parseBwltPayload(plaintext);
    } catch (e) {
      if (e instanceof BwltPayloadError) {
        return toolError('IMPORT_ERROR', e.message);
      }
      throw e;
    }

    // Never touch an existing wallet: pick a free local name, as the CLI does
    const displayName = name?.trim() || payload.wallet_name || payload.username;
    const localName = generateLocalName(displayName);

    const seedFile = saveSeed(localName, payload.seed);
    let added: AddWalletResult;
    try {
      added = addWallet(localName, {
        username: payload.username,
        display_name: displayName,
        api_key: payload.api_key,
        public_key: payload.public_key,
        seed_file: seedFileValue(localName),
        created_at: new Date().toISOString(),
      }, { makeDefault: true });
    } catch (e) {
      // The seed file was created above, so removing it loses nothing
      removeNewSeed(seedFile);
      throw e;
    }

    ctx.sdk.setApiKey(payload.api_key);
    ctx.config.walletName = localName;
    ctx.config.hasSeed = true;
    ctx.config.hasConfig = true;

    const notes = [
      added.previousDefault
        ? `The imported wallet is now the default. The previous default was "${added.previousDefault}".`
        : undefined,
      envOverrideNote(),
    ].filter(Boolean);

    return formatResult({
      imported: true,
      wallet_name: localName,
      username: payload.username,
      deposit_address: payload.public_key,
      is_default: true,
      previous_default: added.previousDefault,
      note: notes.length > 0 ? notes.join(' ') : undefined,
      message: 'Wallet imported and activated. Ready to use.',
    });
  },
});

// Why a backup code was not accepted, and what to do (CLI: ValidateBackupNonce)
const BACKUP_CODE_ERRORS: Record<Exclude<BackupCodeCheck, { ok: true }>['reason'], [string, string]> = {
  none: ['No backup was started, or its code was already used.',
    'Call botwallet_wallet_backup without a code to get a new one.'],
  invalid: ['The pending backup request could not be read.',
    'Call botwallet_wallet_backup without a code to get a new one.'],
  expired: ['The code expired: it is valid for 30 seconds.',
    'Call botwallet_wallet_backup without a code to get a new one, then call it again with that code right away.'],
  wrong_code: ['That code does not match the pending backup.',
    'Use the code from your last botwallet_wallet_backup call, or call it without a code to get a new one.'],
};

const walletBackup = defineTool({
  name: 'botwallet_wallet_backup',
  annotations: KEY_MATERIAL,
  description:
    '⚠️ SENSITIVE: Reveals Key 1, the 12 secret words of this wallet\'s local key share, for your human owner\'s backup. ' +
    'Together with the Botwallet server\'s Key 2 it can sign transactions; the owner needs it to withdraw from the ' +
    'Botwallet dashboard and to recover the wallet. ' +
    'Only use when your human owner explicitly asks for their backup key, and send the words only to them, privately. ' +
    'Two steps, as in the CLI: call without `code` to get a one-time code (valid for 30 seconds), ' +
    'then call again with that code to reveal the words.',
  inputSchema: z.object({
    code: z.string().optional()
      .describe('The one-time code from your first botwallet_wallet_backup call. Leave it out to start a backup.'),
  }),
  async run(args, ctx) {
    const code = args.code?.trim();

    // Step 1: a one-time code, so the words are never revealed by a single call
    if (!code) {
      if (!ctx.config.hasSeed || !ctx.config.walletName) {
        return noSeedError('reveal backup phrase', ctx.config.walletName);
      }
      const newCode = generateBackupCode();
      try {
        writeBackupNonce(newCode, ctx.config.walletName);
      } catch (e) {
        return toolError('CONFIG_ERROR', `Could not start the backup: ${errorMessage(e)}`,
          'Check that the ~/.botwallet folder is writable.');
      }
      return formatResult({
        action: 'backup_initiated',
        wallet: ctx.config.walletName,
        warning: 'The next call reveals Key 1, the 12 secret words that are this wallet\'s half of the backup key. ' +
          'Only continue if your human owner asked for their backup key.',
        code: newCode,
        expires_in: '30 seconds',
        next_step: `Call botwallet_wallet_backup again with code "${newCode}" within 30 seconds to reveal the words.`,
      });
    }

    // Step 2: the code names the wallet whose words are revealed
    const check = checkBackupCode(code);
    if (!check.ok) {
      const [message, howToFix] = BACKUP_CODE_ERRORS[check.reason];
      return toolError('BACKUP_ERROR', message, howToFix);
    }
    const wallet = check.wallet;
    if (!seedExists(wallet)) {
      return noSeedError('reveal backup phrase', wallet);
    }

    const mnemonic = loadSeed(wallet);

    return formatResult({
      wallet,
      mnemonic,
      warning: 'This is Key 1 (12 words), this wallet\'s half of the key. ' +
        'Only share it with your human owner, privately, when they ask for it for their backup.',
      note: 'Both this mnemonic AND the server key share (Key 2) are required to sign transactions. ' +
        'The owner needs Key 1 to withdraw from the Botwallet dashboard and to recover the wallet. ' +
        'Key 2 can be retrieved from the Botwallet dashboard.',
    });
  },
});

export const walletFileTools: ToolDefinition[] = [
  walletExport,
  walletImport,
  walletBackup,
];

/** True when `file` is `dir` itself or anywhere below it (case-insensitive on Windows). */
function isInside(dir: string, file: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  if (rel === '') return true;
  return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`);
}
