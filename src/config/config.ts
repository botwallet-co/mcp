// Local wallet configuration management.
//
// Reads/writes ~/.botwallet/config.json — shared format with the CLI.
//
// Config layout:
//   ~/.botwallet/
//     config.json          # Wallet registry (version, wallets, default)
//     seeds/
//       <name>.seed        # 12-word mnemonic (FROST S1 key share)
//
// The CLI (packages/cli-go/config/config.go) is the reference for this format.

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

/**
 * The seed_file value stored in a wallet entry. The CLI reads it relative to
 * ~/.botwallet when signing, so it must include the seeds/ folder and use
 * forward slashes, exactly as the CLI writes it.
 */
export function seedFileValue(name: string): string {
  return `seeds/${name}.seed`;
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

export interface AddWalletOptions {
  /** Make the new wallet the default, as the CLI does for every new wallet. */
  makeDefault?: boolean;
}

export interface AddWalletResult {
  /** The previous default wallet, when the default moved away from one. */
  previousDefault?: string;
  totalWallets: number;
}

/**
 * Add a new wallet entry to config.json.
 *
 * Refuses a name that is already in the config, so an existing wallet's API
 * key can never be replaced (same rule as AddWalletWithInfo in the CLI). An
 * unreadable config.json is an error, not a reason to start a new one.
 */
export function addWallet(
  name: string,
  entry: WalletEntry,
  options: AddWalletOptions = {},
): AddWalletResult {
  const config: BotWalletLocalConfig = configExists()
    ? loadConfig()
    : { version: CONFIG_VERSION, wallets: {} };

  if (Object.hasOwn(config.wallets, name)) {
    throw new Error(`Wallet '${name}' already exists locally`);
  }
  config.wallets[name] = entry;
  repairSeedFilePaths(config);

  const previous = config.default_wallet;
  let previousDefault: string | undefined;
  if (options.makeDefault || !previous || Object.keys(config.wallets).length === 1) {
    config.default_wallet = name;
    if (previous && previous !== name && Object.hasOwn(config.wallets, previous)) {
      previousDefault = previous;
    }
  }

  saveConfig(config);
  return { previousDefault, totalWallets: Object.keys(config.wallets).length };
}

export function setDefaultWallet(name: string): void {
  const config = loadConfig();
  if (!Object.hasOwn(config.wallets, name)) {
    throw new Error(`Wallet '${name}' not found in config`);
  }
  config.default_wallet = name;
  repairSeedFilePaths(config);
  saveConfig(config);
}

/**
 * Older MCP versions wrote seed_file as "<name>.seed" while saving the file
 * in seeds/. The CLI resolves seed_file relative to ~/.botwallet, so it could
 * not sign for those wallets. Point such entries at seeds/ when the file is
 * there. Called only where the config is being saved anyway.
 */
function repairSeedFilePaths(config: BotWalletLocalConfig): void {
  for (const entry of Object.values(config.wallets)) {
    const file = entry?.seed_file;
    if (typeof file !== 'string' || !file.endsWith('.seed') || /[\\/]/.test(file)) continue;
    if (fs.existsSync(path.join(configDir(), file))) continue;
    try {
      if (fs.statSync(path.join(seedsDir(), file)).isFile()) {
        entry.seed_file = `seeds/${file}`;
      }
    } catch {
      // Not in seeds/ either: leave the entry as it is
    }
  }
}

/**
 * Make a wallet name safe to use as a file name. Port of sanitizeFilename in
 * packages/cli-go/config/config.go: lowercase, spaces become hyphens, only
 * a-z, 0-9 and '-' are kept, repeated hyphens collapse, never empty.
 */
export function sanitizeWalletName(name: string): string {
  let cleaned = name.trim().toLowerCase().replace(/ /g, '-').replace(/[^a-z0-9-]/g, '');
  while (cleaned.includes('--')) cleaned = cleaned.replace(/--/g, '-');
  cleaned = cleaned.replace(/^-+|-+$/g, '');
  return cleaned || 'wallet';
}

/**
 * Choose a local name for a new wallet. Port of GenerateLocalName in the CLI:
 * the sanitized name, or name-2, name-3, ... when it is taken. A name is also
 * taken when its seed file exists without a config entry, so a stray key
 * share is never overwritten.
 */
export function generateLocalName(displayName: string): string {
  const base = sanitizeWalletName(displayName);
  let wallets: Record<string, WalletEntry> = {};
  try {
    if (configExists()) wallets = loadConfig().wallets;
  } catch {
    // Unreadable config: addWallet reports it
  }
  const taken = (name: string) =>
    Object.hasOwn(wallets, name) || fs.existsSync(path.join(seedsDir(), `${name}.seed`));

  if (!taken(base)) return base;
  for (let i = 2; i <= 100; i++) {
    const candidate = `${base}-${i}`;
    if (!taken(candidate)) return candidate;
  }
  return `${base}-${Math.floor(Date.now() / 1000)}`;
}

export interface ResolvedWallet {
  /** Local wallet whose key share signs. Undefined when there is none to use. */
  name?: string;
  /** API key to authenticate with. */
  apiKey?: string;
  /** Configuration problems to report on stderr. */
  warnings: string[];
}

/**
 * Pick the API key and the local key share together, so they always belong
 * to the same wallet. Signing one wallet's payment with another wallet's key
 * share fails only after the payment was confirmed.
 *
 *   1. BOTWALLET_API_KEY (or BW_API_KEY): the key decides. The key share is
 *      the one of the wallet entry that holds this key. If no entry holds it,
 *      signing stays off, except for a selected entry with no API key stored
 *      (left by older MCP imports), which the key is taken to belong to.
 *   2. BOTWALLET_WALLET: that wallet. Throws when it is not in config.json,
 *      as the CLI does for --wallet.
 *   3. The default wallet in config.json.
 */
export function resolveWallet(env: NodeJS.ProcessEnv = process.env): ResolvedWallet {
  const envKey = env.BOTWALLET_API_KEY || env.BW_API_KEY || undefined;
  const requested = env.BOTWALLET_WALLET || undefined;
  const config = configExists() ? loadConfig() : undefined;
  const wallets = config?.wallets ?? {};
  const has = (name: string | undefined): name is string => !!name && Object.hasOwn(wallets, name);

  if (requested && !has(requested) && !envKey) {
    const names = Object.keys(wallets);
    throw new Error(
      `BOTWALLET_WALLET is set to "${requested}", but no wallet with that name is in ${configPath()}. ` +
      (names.length > 0 ? `Available wallets: ${names.join(', ')}. ` : 'No wallets are set up yet. ') +
      'Fix or remove BOTWALLET_WALLET in your MCP client settings.'
    );
  }

  const defaultName = config?.default_wallet;
  const selected = has(requested) ? requested : has(defaultName) ? defaultName : undefined;

  if (!envKey) {
    const apiKey = selected ? wallets[selected]?.api_key || undefined : undefined;
    return { name: selected, apiKey, warnings: [] };
  }

  const warnings: string[] = [];
  if (requested && !has(requested)) {
    // Env-only setup: the user paired the key with a seed file by name
    if (!/[\\/]/.test(requested) && fs.existsSync(path.join(seedsDir(), `${requested}.seed`))) {
      return { name: requested, apiKey: envKey, warnings };
    }
    warnings.push(
      `BOTWALLET_WALLET is set to "${requested}", which is not in ${configPath()}. ` +
      'BOTWALLET_API_KEY decides the wallet.'
    );
  }

  const owner = selected && wallets[selected]?.api_key === envKey
    ? selected
    : Object.keys(wallets).find(name => wallets[name]?.api_key === envKey);
  if (owner) {
    if (has(requested) && owner !== requested) {
      warnings.push(
        `BOTWALLET_WALLET is set to "${requested}", but BOTWALLET_API_KEY belongs to "${owner}". Using "${owner}".`
      );
    }
    return { name: owner, apiKey: envKey, warnings };
  }

  if (selected && !wallets[selected]?.api_key) {
    return { name: selected, apiKey: envKey, warnings };
  }

  if (Object.keys(wallets).length > 0) {
    warnings.push(
      `BOTWALLET_API_KEY does not belong to any wallet in ${configPath()}, so payments, withdrawals and ` +
      'paid API calls are turned off: they need that wallet\'s Key 1. ' +
      'Remove BOTWALLET_API_KEY to use the wallets in config.json.'
    );
  }
  return { name: undefined, apiKey: envKey, warnings };
}

/**
 * The API base URL, looked up in the CLI's order (GetBaseURL in
 * packages/cli-go/config/config.go): BOTWALLET_API_URL, then base_url in
 * config.json. BOTWALLET_BASE_URL, which older MCP versions documented, is
 * still read, right after BOTWALLET_API_URL. Undefined means the SDK default
 * (https://api.botwallet.co/v1).
 */
export function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env.BOTWALLET_API_URL || env.BOTWALLET_BASE_URL;
  if (fromEnv) return fromEnv;
  try {
    if (configExists()) return loadConfig().base_url || undefined;
  } catch {
    // An optional field: resolveWallet reports an unreadable config.json
  }
  return undefined;
}

/**
 * A note for register and import results: when these environment variables
 * are set, they pick the wallet after a restart, not the default wallet.
 */
export function envOverrideNote(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const vars: string[] = [];
  if (env.BOTWALLET_API_KEY) vars.push('BOTWALLET_API_KEY');
  else if (env.BW_API_KEY) vars.push('BW_API_KEY');
  if (env.BOTWALLET_WALLET) vars.push('BOTWALLET_WALLET');
  if (vars.length === 0) return undefined;

  return `${vars.join(' and ')} ${vars.length > 1 ? 'are' : 'is'} set for this MCP server, so after a restart ` +
    'that setting decides which wallet is used, not the default wallet. ' +
    'Change it in your MCP client settings to keep using this wallet.';
}
