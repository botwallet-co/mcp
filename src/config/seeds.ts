// Seed file management for FROST key shares.
//
// Each wallet's S1 key share is stored as a 12-word BIP39 mnemonic
// in ~/.botwallet/seeds/<name>.seed (permissions 0600).
//
// A seed file is often the only copy of a wallet's Key 1, so this module
// never overwrites one.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { seedsDir } from './config.js';

function ensureSeedsDir(): void {
  fs.mkdirSync(seedsDir(), { recursive: true, mode: 0o700 });
}

/**
 * Names come from config.json or from a decrypted .bwlt file. Refuse anything
 * that could point outside seeds/. Names are not rewritten, so seed files
 * saved by older versions under unsanitized names stay readable.
 */
function isSafeSeedName(name: string): boolean {
  return name.trim() !== '' && name !== '.' && name !== '..' && !/[\\/\0]/.test(name);
}

/** Path of a wallet's seed file. Throws for names that are not safe. */
export function seedFilePath(name: string): string {
  if (!isSafeSeedName(name)) {
    throw new Error(`Invalid wallet name for a seed file: ${JSON.stringify(name)}`);
  }
  return path.join(seedsDir(), `${name}.seed`);
}

export function seedExists(name: string): boolean {
  return isSafeSeedName(name) && fs.existsSync(seedFilePath(name));
}

/**
 * Create a new file holding a mnemonic. Fails with EEXIST instead of
 * replacing an existing file, and removes a partly written file on error.
 */
function writeNewSeedFile(filePath: string, label: string, mnemonic: string): void {
  ensureSeedsDir();
  const content = [
    '# BotWallet FROST Key Share — DO NOT SHARE',
    `# Wallet: ${label}`,
    `# Created: ${new Date().toISOString()}`,
    '',
    mnemonic,
    '',
  ].join('\n');

  const fd = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(filePath, { force: true });
    throw e;
  }
  fs.closeSync(fd);
}

/**
 * Save a 12-word mnemonic to a new seed file (permissions 0600).
 * Throws if the wallet already has a seed file. Returns the file path.
 */
export function saveSeed(name: string, mnemonic: string): string {
  const filePath = seedFilePath(name);
  writeNewSeedFile(filePath, name, mnemonic);
  return filePath;
}

/**
 * Remove a seed file that this same operation created a moment ago, because
 * the rest of the operation failed or the file was copied elsewhere.
 * Never use it on a file the operation did not create.
 */
export function removeNewSeed(filePath: string): void {
  fs.rmSync(filePath, { force: true });
}

/**
 * Save the key share of a wallet that is being registered, before the server
 * creates the wallet. The file is named by the wallet's address, so a file
 * left behind by an unfinished registration still says which wallet it opens.
 */
export function savePendingSeed(address: string, mnemonic: string): string {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    throw new Error(`Invalid wallet address: ${JSON.stringify(address)}`);
  }
  const filePath = path.join(seedsDir(), `.pending-${address}.seed`);
  writeNewSeedFile(filePath, `${address} (registration not finished)`, mnemonic);
  return filePath;
}

/**
 * Load the 12-word mnemonic from a seed file.
 * Strips comments and whitespace.
 */
export function loadSeed(name: string): string {
  const sp = seedFilePath(name);
  if (!fs.existsSync(sp)) {
    throw new Error(
      `Seed file not found for wallet '${name}'. ` +
      `Expected at: ${sp}. ` +
      'Restore it from the machine or backup that has this wallet\'s Key 1, or import the wallet from a .bwlt file. ' +
      'Registering a new wallet does not bring this one back.'
    );
  }
  const raw = fs.readFileSync(sp, 'utf-8');
  const mnemonic = raw
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .join(' ')
    .trim();
  if (!mnemonic) {
    throw new Error(`Seed file for wallet '${name}' is empty or only contains comments`);
  }
  return mnemonic;
}
