// Local wallet configuration management.
//
// Reads/writes ~/.botwallet/config.json — shared format with the CLI.
//
// Config layout:
//   ~/.botwallet/
//     config.json          # Wallet registry (version, wallets, default)
//     seeds/
//       <name>.seed        # 12-word mnemonic (FROST S1 key share)

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface WalletEntry {
  username: string;
  display_name?: string;
  api_key: string;
  public_key: string;
  seed_file: string;
  created_at: string;
}

export interface BotWalletLocalConfig {
  version: number;
  default_wallet?: string;
  wallets: Record<string, WalletEntry>;
  base_url?: string;
}

const CONFIG_VERSION = 2;

export function configDir(): string {
  return path.join(os.homedir(), '.botwallet');
}

export function configPath(): string {
  return path.join(configDir(), 'config.json');
}

export function seedsDir(): string {
  return path.join(configDir(), 'seeds');
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function configExists(): boolean {
  return fs.existsSync(configPath());
}

export function loadConfig(): BotWalletLocalConfig {
  const raw = fs.readFileSync(configPath(), 'utf-8');
  const config = JSON.parse(raw) as BotWalletLocalConfig;
  if (!config.wallets) config.wallets = {};
  if (!config.version) config.version = CONFIG_VERSION;
  return config;
}

export function saveConfig(config: BotWalletLocalConfig): void {
  ensureDir(configDir());
  const json = JSON.stringify(config, null, 2) + '\n';
  fs.writeFileSync(configPath(), json, { mode: 0o600 });
}

export function getWallet(name: string): WalletEntry | undefined {
  const config = loadConfig();
  return config.wallets[name];
}

export function getDefaultWallet(): { name: string; wallet: WalletEntry } | undefined {
  const config = loadConfig();
  const name = config.default_wallet;
  if (!name || !config.wallets[name]) return undefined;
  return { name, wallet: config.wallets[name] };
}

export function listWallets(): { name: string; wallet: WalletEntry; isDefault: boolean }[] {
  const config = loadConfig();
  return Object.entries(config.wallets).map(([name, wallet]) => ({
    name,
    wallet,
    isDefault: name === config.default_wallet,
  }));
}

export function addWallet(name: string, entry: WalletEntry): void {
  let config: BotWalletLocalConfig;
  try {
    config = loadConfig();
  } catch {
    config = { version: CONFIG_VERSION, wallets: {} };
  }
  config.wallets[name] = entry;
  if (!config.default_wallet || Object.keys(config.wallets).length === 1) {
    config.default_wallet = name;
  }
  saveConfig(config);
}

export function setDefaultWallet(name: string): void {
  const config = loadConfig();
  if (!config.wallets[name]) {
    throw new Error(`Wallet '${name}' not found in config`);
  }
  config.default_wallet = name;
  saveConfig(config);
}

/**
 * Resolve API key from multiple sources in priority order:
 *   1. BOTWALLET_API_KEY env var
 *   2. Specific wallet name (from BOTWALLET_WALLET env or argument)
 *   3. Default wallet from config
 */
export function resolveApiKey(walletName?: string): string | undefined {
  const envKey = process.env.BOTWALLET_API_KEY;
  if (envKey) return envKey;

  if (!configExists()) return undefined;

  const name = walletName || process.env.BOTWALLET_WALLET;
  if (name) {
    const wallet = getWallet(name);
    return wallet?.api_key;
  }

  const def = getDefaultWallet();
  return def?.wallet.api_key;
}

/**
 * Resolve which wallet to use and load its mnemonic seed.
 * Returns undefined if local config is not available.
 */
export function resolveWalletName(walletName?: string): string | undefined {
  const name = walletName || process.env.BOTWALLET_WALLET;
  if (name) return name;

  if (!configExists()) return undefined;

  const def = getDefaultWallet();
  return def?.name;
}
