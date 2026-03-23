// Seed file management for FROST key shares.
//
// Each wallet's S1 key share is stored as a 12-word BIP39 mnemonic
// in ~/.botwallet/seeds/<name>.seed (permissions 0600).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { seedsDir } from './config.js';

function ensureSeedsDir(): void {
  fs.mkdirSync(seedsDir(), { recursive: true, mode: 0o700 });
}

function seedPath(name: string): string {
  return path.join(seedsDir(), `${name}.seed`);
}

export function seedExists(name: string): boolean {
  return fs.existsSync(seedPath(name));
}

/**
 * Save a 12-word mnemonic to the seed file.
 * Writes with 0600 permissions (owner read/write only).
 */
export function saveSeed(name: string, mnemonic: string): void {
  ensureSeedsDir();
  const content = [
    '# BotWallet FROST Key Share — DO NOT SHARE',
    `# Wallet: ${name}`,
    `# Created: ${new Date().toISOString()}`,
    '',
    mnemonic,
    '',
  ].join('\n');
  fs.writeFileSync(seedPath(name), content, { mode: 0o600 });
}

/**
 * Load the 12-word mnemonic from a seed file.
 * Strips comments and whitespace.
 */
export function loadSeed(name: string): string {
  const sp = seedPath(name);
  if (!fs.existsSync(sp)) {
    throw new Error(
      `Seed file not found for wallet '${name}'. ` +
      `Expected at: ${sp}. ` +
      `The wallet may need to be re-imported or registered.`
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
