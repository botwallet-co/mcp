import type { ToolResult } from '../types.js';
import { errorResult, toolError } from './tool-result.js';

/** The message of a thrown value, whatever was thrown. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * A recipient that looks like a Solana address but isn't one. The server
 * would take it as an address all the same, so the CLI refuses it before the
 * request (pay.go, withdraw.go), and so does this server.
 */
export function invalidAddressError(): ToolResult {
  return toolError('VALIDATION_ERROR', 'Invalid Solana address format',
    'A Solana address is 32-44 base58 characters (no 0, O, I or l) that decode to 32 bytes. ' +
    'Use the recipient\'s wallet address, not a token account address');
}

// Registering never brings back an existing wallet: it makes a separate,
// empty one. Errors about missing local files say so, and offer registering
// last, for when the human really wants a new wallet.
const REGISTER_LAST = { tool: 'botwallet_register', description: 'Only if your human wants a brand-new wallet' };

/**
 * Return a helpful error when FROST signing is required but no seed is available.
 * `walletName` is the wallet in use, when there is one: its key share may be
 * missing on this machine while the wallet and its funds are fine.
 */
export function noSeedError(operation: string, walletName?: string): ToolResult {
  if (walletName) {
    return errorResult({
      error: true,
      code: 'NO_LOCAL_SEED',
      message: `Cannot ${operation}: wallet "${walletName}" has no local key share (Key 1) on this machine ` +
        `(~/.botwallet/seeds/${walletName}.seed is missing).`,
      how_to_fix: 'Do not register a new wallet to fix this: a new wallet is separate and starts empty, and this ' +
        'wallet keeps its funds. Ask your human to restore the key share file from the machine or backup that has it, ' +
        'or to export the wallet there and import the .bwlt file here with botwallet_wallet_import. ' +
        'botwallet_info shows which wallet the API key opens; botwallet_wallet_list shows the wallets on this ' +
        'machine and which have Key 1.',
      options: [
        { tool: 'botwallet_info', description: 'See which wallet the API key opens' },
        { tool: 'botwallet_wallet_list', description: 'See the wallets on this machine and which have Key 1' },
        { tool: 'botwallet_wallet_import', description: 'Import the wallet from a .bwlt file exported where its Key 1 is' },
      ],
    });
  }

  return errorResult({
    error: true,
    code: 'NO_LOCAL_SEED',
    message: `Cannot ${operation}: no local key share (Key 1) was found for the wallet in use.`,
    how_to_fix: 'This needs the wallet\'s Key 1 in ~/.botwallet/seeds/. If you already have a Botwallet, do not ' +
      'register a new one to fix this: a new wallet is separate and starts empty. Ask your human to restore ' +
      '~/.botwallet from the machine that has the wallet, or to export it there and import the .bwlt file here with ' +
      'botwallet_wallet_import. If BOTWALLET_API_KEY is set for this MCP server, it decides the wallet: check that it ' +
      'belongs to a wallet whose Key 1 is on this machine (botwallet_wallet_list shows them). ' +
      'Call botwallet_register only if your human wants a brand-new wallet.',
    options: [
      { tool: 'botwallet_wallet_import', description: 'Import the wallet from a .bwlt file exported where its Key 1 is' },
      { tool: 'botwallet_wallet_list', description: 'See the wallets on this machine and which have Key 1' },
      { tool: 'botwallet_info', description: 'See which wallet the API key opens, if one is set' },
      REGISTER_LAST,
    ],
  });
}

/**
 * Return a helpful error when config is not available.
 */
export function noConfigError(operation: string): ToolResult {
  return errorResult({
    error: true,
    code: 'NO_LOCAL_CONFIG',
    message: `Cannot ${operation}: no local config found (~/.botwallet/config.json).`,
    how_to_fix: 'If you already have a Botwallet, do not register a new one: ask your human to restore the ' +
      '~/.botwallet folder from the machine that has the wallet, or to export it there and import the .bwlt file ' +
      'here with botwallet_wallet_import. If BOTWALLET_API_KEY is set for this MCP server, botwallet_info shows the ' +
      'wallet it opens. Call botwallet_register only if your human wants a brand-new wallet.',
    options: [
      { tool: 'botwallet_wallet_import', description: 'Import a wallet from a .bwlt file' },
      { tool: 'botwallet_info', description: 'See the wallet BOTWALLET_API_KEY opens, if one is set' },
      REGISTER_LAST,
    ],
  });
}
