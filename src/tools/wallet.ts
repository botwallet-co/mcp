import { z } from 'zod';
import { base58 } from '@scure/base';
import type { ToolDefinition } from '../types.js';
import { READ_ONLY, UPDATES, CREATES, CANNOT_UNDO } from '../utils/annotations.js';
import { BotWalletError, type DkgCompleteResponse } from '../sdk/index.js';
import { formatResult, formatToolError, toolError } from '../utils/tool-result.js';
import { errorMessage, noConfigError } from '../utils/errors.js';
import { generateShareMnemonic, keyShareFromMnemonic, computeGroupKey } from '../frost/index.js';
import {
  configExists,
  configPath,
  seedsDir,
  seedFileValue,
  addWallet,
  getWallet,
  listWallets,
  setDefaultWallet,
  generateLocalName,
  envOverrideNote,
  saveSeed,
  savePendingSeed,
  removeNewSeed,
  seedFilePath,
  seedExists,
  type AddWalletResult,
} from '../config/index.js';
import { apiTool, defineTool } from './define.js';

const ping = apiTool({
  name: 'botwallet_ping',
  annotations: READ_ONLY,
  description: 'Check if the BotWallet API is reachable. No authentication required. Returns API status and version.',
  inputSchema: z.object({}),
  call: sdk => sdk.ping(),
});

/**
 * Whether dkg_complete was clearly refused before the server created a wallet
 * (bad input, expired session, group key mismatch), as the CLI's
 * dkgCompleteRefused decides. "This group key is already registered" means a
 * wallet with this key exists, and anything else (network errors, timeouts,
 * internal errors) leaves it unknown: then Key 1 must be kept.
 */
export function dkgCompleteRefused(e: unknown): e is BotWalletError {
  if (!(e instanceof BotWalletError)) return false;
  switch (e.code) {
    case 'SESSION_EXPIRED':
    case 'DKG_VERIFICATION_FAILED':
      return true;
    case 'VALIDATION_ERROR':
      return !e.message.toLowerCase().includes('already registered');
  }
  return false;
}

const register = defineTool({
  name: 'botwallet_register',
  annotations: CREATES,
  description:
    'Register a new bot wallet using FROST Distributed Key Generation. ' +
    'Only call this when your human asks for a new wallet. If a wallet is already set up (botwallet_info works, ' +
    'or botwallet_wallet_list shows one), do not register another: a new wallet is separate and starts empty, ' +
    'and it does not fix a missing API key or key share. ' +
    'Creates a wallet with a 2-of-2 threshold key — the bot holds one key share locally and the server holds the other. ' +
    'Neither share alone can sign transactions. ' +
    'Returns a claim link + claim code to send to your human owner so they can claim the wallet. ' +
    'The claim code expires 48 hours after registration. ' +
    'The wallet\'s API key and the local key share are saved to ~/.botwallet/ automatically and are not shown, ' +
    'and the new wallet becomes the default.',
  inputSchema: z.object({
    name: z.string().min(2).max(50)
      .describe('Display name for the bot (e.g. "my-trading-bot")'),
    agent_model: z.string().optional()
      .describe('Agent model identifier (e.g. "claude-sonnet-4", "gpt-4")'),
    owner_email: z.string().email().optional()
      .describe('Owner email — wallet will appear in their portal when they sign up'),
    description: z.string().max(200).optional()
      .describe('Purpose of this wallet (helps the owner identify it)'),
    metadata: z.record(z.string()).optional()
      .describe('Key-value metadata (e.g. {"platform": "cursor", "project": "my-app"})'),
  }),
  async run(args, ctx) {
    const { name, agent_model, owner_email, description, metadata } = args;

    // Step 1: Generate local key share
    const mnemonic = generateShareMnemonic();
    const keyShare = keyShareFromMnemonic(mnemonic);
    const botPublicB64 = Buffer.from(keyShare.public).toString('base64');

    // Build metadata (matching CLI behavior: description goes into metadata)
    const dkgMetadata: Record<string, string> = { ...metadata };
    if (description) {
      dkgMetadata.description = description;
    }

    // Step 2: Initiate DKG — server generates its key share
    const dkgInit = await ctx.sdk.dkgInit({
      name,
      agent_model,
      owner_email,
      metadata: Object.keys(dkgMetadata).length > 0 ? dkgMetadata : undefined,
    });

    const serverPublicBytes = Buffer.from(dkgInit.server_public_share, 'base64');

    // Step 3: Compute group key (the Solana wallet address)
    const groupKey = computeGroupKey(keyShare.public, Uint8Array.from(serverPublicBytes));
    const groupKeyB58 = base58.encode(groupKey);

    // Step 4: Save the key share before the server creates the wallet. Once
    // dkg_complete succeeds the wallet exists (and a pledged owner is emailed),
    // so its only copy of Key 1 must already be on disk. If it can't be
    // saved, stop here: the DKG session simply expires.
    let pendingFile: string;
    try {
      pendingFile = savePendingSeed(groupKeyB58, mnemonic);
    } catch (e) {
      return toolError('KEY_SAVE_FAILED',
        `Could not save the new wallet's key share in ${seedsDir()}: ${errorMessage(e)}. No wallet was created.`,
        'Make sure that folder is writable and the disk has free space, then call botwallet_register again.');
    }

    // Step 5: Complete DKG — server verifies and creates wallet
    let result: DkgCompleteResponse;
    try {
      result = await ctx.sdk.dkgComplete({
        session_id: dkgInit.session_id,
        agent_public_share: botPublicB64,
        group_public_key: groupKeyB58,
      });
    } catch (e) {
      if (dkgCompleteRefused(e)) {
        // The server refused the request, so no wallet exists for this key share
        try {
          removeNewSeed(pendingFile);
        } catch {
          // Report the server's error, not the cleanup's
        }
        return formatToolError(e);
      }
      return toolError('REGISTRATION_UNCONFIRMED',
        `The server did not confirm the new wallet (${errorMessage(e)}). ` +
        `It may or may not have been created, at address ${groupKeyB58}.`,
        'Calling botwallet_register again is safe: it creates a separate wallet. ' +
        `Key 1 for ${groupKeyB58} is kept in ${pendingFile}; do not delete it. ` +
        'If your owner was told about a wallet with that address, ask them not to fund it.',
        { deposit_address: groupKeyB58, key_share_file: pendingFile });
    }

    // Step 6: Move the key share to its final file and record the wallet,
    // under a local name that no other wallet or seed file uses
    const localName = generateLocalName(result.username);
    let seedFile: string | undefined;
    let added: AddWalletResult | undefined;
    let saveError: string | undefined;
    try {
      seedFile = saveSeed(localName, mnemonic);
      try {
        removeNewSeed(pendingFile);
      } catch {
        // A leftover copy in the same folder does no harm
      }
      added = addWallet(localName, {
        username: result.username,
        display_name: name,
        api_key: result.api_key,
        public_key: groupKeyB58,
        seed_file: seedFileValue(localName),
        created_at: new Date().toISOString(),
      }, { makeDefault: true });
    } catch (e) {
      saveError = errorMessage(e);
    }

    // Step 7: Use the new wallet in this session
    ctx.sdk.setApiKey(result.api_key);
    ctx.config.walletName = localName;
    ctx.config.hasSeed = seedFile !== undefined;
    ctx.config.hasConfig = added !== undefined || configExists();

    let warning: string | undefined;
    if (saveError && !seedFile) {
      warning = `The wallet was created, but its key share could not be saved as ${seedFilePath(localName)} ` +
        `(${saveError}). Key 1 is in ${pendingFile}; do not delete that file. ` +
        'Payments from this wallet need that file moved to the seeds folder and the wallet added to ~/.botwallet/config.json. ' +
        'The api_key in this result is not stored anywhere else: keep it private and safe.';
    } else if (saveError) {
      warning = `The wallet was created and Key 1 is saved in ${seedFile}, but ~/.botwallet/config.json ` +
        `could not be updated (${saveError}). The api_key in this result is not stored anywhere else: ` +
        'keep it private and safe. After a restart this wallet is not available until it is added to config.json.';
    }

    const notes = [
      added?.previousDefault
        ? `This wallet is now the default. The previous default was "${added.previousDefault}".`
        : undefined,
      added ? envOverrideNote() : undefined,
    ].filter(Boolean);

    return formatResult({
      registered: true,
      username: result.username,
      wallet_name: localName,
      // The API key is a secret and stays out of the conversation (the CLI
      // doesn't print it either). Only when config.json could not be written
      // is this result its one copy, so then it is returned.
      api_key: added ? undefined : result.api_key,
      api_key_saved_to: added ? configPath() : undefined,
      deposit_address: result.deposit_address,
      funding_url: result.funding_url,
      claim_code: result.claim_code,
      claim_url: result.claim_url,
      // Omitted from the JSON when the API doesn't send it
      claim_expires_at: result.claim_expires_at,
      message: result.message,
      is_default: added ? true : undefined,
      previous_default: added?.previousDefault,
      note: notes.length > 0 ? notes.join(' ') : undefined,
      warning,
      key_share_file: warning ? (seedFile ?? pendingFile) : undefined,
    });
  },
});

const info = apiTool({
  name: 'botwallet_info',
  annotations: READ_ONLY,
  description:
    'Get wallet metadata: status, deposit address, owner/claim status, creation date, and wallet type. ' +
    'For live on-chain balance, spending limits, and remaining budget, use botwallet_balance instead.',
  inputSchema: z.object({}),
  call: sdk => sdk.info(),
});

const balance = defineTool({
  name: 'botwallet_balance',
  annotations: READ_ONLY,
  description:
    'Check your live on-chain USDC balance, spending budget, amount spent this period, and remaining allowance. ' +
    'Also indicates if balance is low and provides the funding URL. ' +
    'For wallet metadata (status, owner, creation date, claim info), use botwallet_info instead.',
  inputSchema: z.object({}),
  async run(_args, ctx) {
    const result = await ctx.sdk.balance();

    // Enrich budget information so agents understand null values
    const budget = result.budget == null && result.remaining_budget == null
      ? {
        budget_status: 'no_budget_set',
        budget_message: 'No spending budget is configured. All transactions require owner approval unless auto-approve rules are set in guard rails.',
      }
      : { budget_status: 'active' };

    return formatResult({ ...result, ...budget });
  },
});

const updateOwner = apiTool({
  name: 'botwallet_update_owner',
  annotations: CANNOT_UNDO,
  description:
    'Set or change the owner email for an unclaimed wallet. ' +
    'The owner will receive a notification and can claim the wallet through the portal.',
  inputSchema: z.object({
    owner_email: z.string().email()
      .describe('Email address of the human owner'),
  }),
  call: (sdk, { owner_email }) => sdk.updateOwner({ owner_email }),
});

const rename = apiTool({
  name: 'botwallet_rename',
  annotations: UPDATES,
  description:
    'Update the wallet display name shown to other users and in the owner portal. ' +
    'Use when you want to rebrand or clarify the bot\'s purpose.',
  inputSchema: z.object({
    name: z.string().min(2).max(50)
      .describe('New display name'),
  }),
  call: (sdk, { name }) => sdk.updateName({ name }),
});

const walletList = defineTool({
  name: 'botwallet_wallet_list',
  annotations: READ_ONLY,
  description:
    'List all locally configured wallets. Shows which wallet is the default. ' +
    'This reads from ~/.botwallet/config.json — the wallet registry shared with the CLI.',
  inputSchema: z.object({}),
  async run(_args, ctx) {
    if (!ctx.config.hasConfig) {
      return noConfigError('list wallets');
    }
    const wallets = listWallets();
    return formatResult({
      wallets: wallets.map(w => ({
        name: w.name,
        username: w.wallet.username,
        display_name: w.wallet.display_name,
        is_default: w.isDefault,
        has_seed: seedExists(w.name),
        created_at: w.wallet.created_at,
      })),
      count: wallets.length,
    });
  },
});

const walletUse = defineTool({
  name: 'botwallet_wallet_use',
  annotations: UPDATES,
  description:
    'Switch the default wallet. Subsequent operations will use this wallet\'s API key and seed. ' +
    'Use botwallet_wallet_list to see available wallets.',
  inputSchema: z.object({
    name: z.string().min(1)
      .describe('Name of the wallet to switch to'),
  }),
  async run(args, ctx) {
    if (!ctx.config.hasConfig) {
      return noConfigError('switch wallets');
    }
    const { name } = args;
    const wallet = getWallet(name);
    if (!wallet) {
      return formatToolError(new Error(
        `Wallet "${name}" not found in config. Run botwallet_wallet_list to see available wallets.`
      ));
    }

    setDefaultWallet(name);
    ctx.sdk.setApiKey(wallet.api_key);
    ctx.config.walletName = name;
    ctx.config.hasSeed = seedExists(name);

    return formatResult({
      switched: true,
      active_wallet: name,
      has_seed: seedExists(name),
    });
  },
});

export const walletTools: ToolDefinition[] = [
  ping,
  register,
  info,
  balance,
  updateOwner,
  rename,
  walletList,
  walletUse,
];
