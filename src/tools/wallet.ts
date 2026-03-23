import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';
import { formatResult } from '../utils/format.js';
import { formatToolError, noSeedError, noConfigError } from '../utils/errors.js';
import { generateShareMnemonic, keyShareFromMnemonic, computeGroupKey } from '../frost/index.js';
import {
  configExists,
  addWallet,
  getWallet,
  listWallets,
  setDefaultWallet,
  loadSeed,
  saveSeed,
  seedExists,
} from '../config/index.js';

const ping: ToolDefinition = {
  name: 'botwallet_ping',
  description: 'Check if the BotWallet API is reachable. No authentication required. Returns API status and version.',
  inputSchema: z.object({}),
  async handler(_args, ctx) {
    try {
      const result = await ctx.sdk.ping();
      return formatResult(result);
    } catch (e) {
      return formatToolError(e);
    }
  },
};

const register: ToolDefinition = {
  name: 'botwallet_register',
  description:
    'Register a new bot wallet using FROST Distributed Key Generation. ' +
    'Creates a wallet with a 2-of-2 threshold key — the bot holds one key share locally and the server holds the other. ' +
    'Neither share alone can sign transactions. ' +
    'Returns the API key and claim code for the human owner. ' +
    'The local key share is saved to ~/.botwallet/seeds/ automatically.',
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
  async handler(args, ctx) {
    try {
      const { name, agent_model, owner_email, description, metadata } = args as {
        name: string;
        agent_model?: string;
        owner_email?: string;
        description?: string;
        metadata?: Record<string, string>;
      };

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
      const groupKeyB64 = Buffer.from(groupKey).toString('base64');

      // Step 4: Complete DKG — server verifies and creates wallet
      const result = await ctx.sdk.dkgComplete({
        session_id: dkgInit.session_id,
        agent_public_share: botPublicB64,
        group_public_key: groupKeyB64,
      });

      // Step 5: Save locally
      saveSeed(result.username, mnemonic);
      addWallet(result.username, {
        username: result.username,
        display_name: name,
        api_key: result.api_key,
        public_key: Buffer.from(groupKey).toString('hex'),
        seed_file: `${result.username}.seed`,
        created_at: new Date().toISOString(),
      });

      // Step 6: Reconfigure SDK with new API key
      ctx.sdk.setApiKey(result.api_key);
      ctx.config.walletName = result.username;
      ctx.config.hasSeed = true;
      ctx.config.hasConfig = true;

      return formatResult({
        registered: true,
        username: result.username,
        api_key: result.api_key,
        deposit_address: result.deposit_address,
        funding_url: result.funding_url,
        claim_code: result.claim_code,
        claim_url: result.claim_url,
        message: result.message,
      });
    } catch (e) {
      return formatToolError(e);
    }
  },
};

const info: ToolDefinition = {
  name: 'botwallet_info',
  description:
    'Get wallet metadata: status, deposit address, owner/claim status, creation date, and wallet type. ' +
    'For live on-chain balance, spending limits, and remaining budget, use botwallet_balance instead.',
  inputSchema: z.object({}),
  async handler(_args, ctx) {
    try {
      const result = await ctx.sdk.info();
      return formatResult(result);
    } catch (e) {
      return formatToolError(e);
    }
  },
};

const balance: ToolDefinition = {
  name: 'botwallet_balance',
  description:
    'Check your live on-chain USDC balance, spending budget, amount spent this period, and remaining allowance. ' +
    'Also indicates if balance is low and provides the funding URL. ' +
    'For wallet metadata (status, owner, creation date, claim info), use botwallet_info instead.',
  inputSchema: z.object({}),
  async handler(_args, ctx) {
    try {
      const result = await ctx.sdk.balance();
      return formatResult(result);
    } catch (e) {
      return formatToolError(e);
    }
  },
};

const updateOwner: ToolDefinition = {
  name: 'botwallet_update_owner',
  description:
    'Set or change the owner email for an unclaimed wallet. ' +
    'The owner will receive a notification and can claim the wallet through the portal.',
  inputSchema: z.object({
    owner_email: z.string().email()
      .describe('Email address of the human owner'),
  }),
  async handler(args, ctx) {
    try {
      const { owner_email } = args as { owner_email: string };
      const result = await ctx.sdk.updateOwner({ owner_email });
      return formatResult(result);
    } catch (e) {
      return formatToolError(e);
    }
  },
};

const rename: ToolDefinition = {
  name: 'botwallet_rename',
  description:
    'Update the wallet display name shown to other users and in the owner portal. ' +
    'Use when you want to rebrand or clarify the bot\'s purpose.',
  inputSchema: z.object({
    name: z.string().min(2).max(50)
      .describe('New display name'),
  }),
  async handler(args, ctx) {
    try {
      const { name } = args as { name: string };
      const result = await ctx.sdk.updateName({ name });
      return formatResult(result);
    } catch (e) {
      return formatToolError(e);
    }
  },
};

const walletList: ToolDefinition = {
  name: 'botwallet_wallet_list',
  description:
    'List all locally configured wallets. Shows which wallet is the default. ' +
    'This reads from ~/.botwallet/config.json — the wallet registry shared with the CLI.',
  inputSchema: z.object({}),
  async handler(_args, ctx) {
    if (!ctx.config.hasConfig) {
      return noConfigError('list wallets');
    }
    try {
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
    } catch (e) {
      return formatToolError(e);
    }
  },
};

const walletUse: ToolDefinition = {
  name: 'botwallet_wallet_use',
  description:
    'Switch the default wallet. Subsequent operations will use this wallet\'s API key and seed. ' +
    'Use botwallet_wallet_list to see available wallets.',
  inputSchema: z.object({
    name: z.string().min(1)
      .describe('Name of the wallet to switch to'),
  }),
  async handler(args, ctx) {
    if (!ctx.config.hasConfig) {
      return noConfigError('switch wallets');
    }
    try {
      const { name } = args as { name: string };
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
    } catch (e) {
      return formatToolError(e);
    }
  },
};

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
