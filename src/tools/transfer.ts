import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { formatResult } from '../utils/format.js';
import { formatToolError, noSeedError, noConfigError } from '../utils/errors.js';
import {
  loadSeed,
  saveSeed,
  seedExists,
  addWallet,
  writeBwlt,
  readBwlt,
  encryptPayload,
  decryptPayload,
} from '../config/index.js';

const walletExport: ToolDefinition = {
  name: 'botwallet_wallet_export',
  description:
    'Export the current wallet to a .bwlt file for transfer to another machine. ' +
    'The file is encrypted with AES-256-GCM — the decryption key is held by the server ' +
    'and retrieved during import. The .bwlt file alone cannot unlock the wallet.',
  inputSchema: z.object({
    output_path: z.string()
      .describe('File path for the .bwlt export (e.g. "./my-wallet.bwlt")'),
  }),
  async handler(args, ctx) {
    try {
      if (!ctx.config.hasConfig || !ctx.config.walletName) {
        return noConfigError('export wallet');
      }
      if (!ctx.config.hasSeed) {
        return noSeedError('export wallet');
      }

      const { output_path } = args as { output_path: string };
      const walletName = ctx.config.walletName;

      // Get encryption key from server (returned as base64)
      const exportResult = await ctx.sdk.walletExport();
      const key = base64ToBytes(exportResult.encryption_key);

      // Build payload: seed mnemonic + wallet name
      const mnemonic = loadSeed(walletName);
      const payload = JSON.stringify({
        wallet_name: walletName,
        seed: mnemonic,
        exported_at: new Date().toISOString(),
      });

      // Encrypt and write .bwlt file
      const { nonce, ciphertext } = encryptPayload(key, new TextEncoder().encode(payload));
      writeBwlt(output_path, exportResult.export_id, nonce, ciphertext);

      return formatResult({
        exported: true,
        path: output_path,
        export_id: exportResult.export_id,
        message: 'Wallet exported. Import on another machine with botwallet_wallet_import.',
      });
    } catch (e) {
      return formatToolError(e);
    }
  },
};

const walletImport: ToolDefinition = {
  name: 'botwallet_wallet_import',
  description:
    'Import a wallet from a .bwlt file. Retrieves the decryption key from the server, ' +
    'decrypts the wallet data, and saves the key share + config locally.',
  inputSchema: z.object({
    file_path: z.string()
      .describe('Path to the .bwlt file to import'),
  }),
  async handler(args, ctx) {
    try {
      const { file_path } = args as { file_path: string };

      // Read and parse .bwlt file
      const bwlt = readBwlt(file_path);

      // Get decryption key from server (no auth required — uses export_id, returned as base64)
      const importResult = await ctx.sdk.walletImportKey({ export_id: bwlt.exportId });
      const key = base64ToBytes(importResult.encryption_key);

      // Decrypt payload
      const plaintext = decryptPayload(key, bwlt.nonce, bwlt.ciphertext);
      const payload = JSON.parse(new TextDecoder().decode(plaintext)) as {
        wallet_name: string;
        seed: string;
        exported_at: string;
      };

      saveSeed(payload.wallet_name, payload.seed);

      const apiKey = importResult.api_key || '';
      addWallet(payload.wallet_name, {
        username: payload.wallet_name,
        display_name: payload.wallet_name,
        api_key: apiKey,
        public_key: '',
        seed_file: `${payload.wallet_name}.seed`,
        created_at: payload.exported_at,
      });
      ctx.config.hasConfig = true;

      if (apiKey) {
        ctx.sdk.setApiKey(apiKey);
        ctx.config.walletName = payload.wallet_name;
        ctx.config.hasSeed = true;
      }

      return formatResult({
        imported: true,
        wallet_name: payload.wallet_name,
        has_seed: seedExists(payload.wallet_name),
        has_api_key: !!apiKey,
        message: apiKey
          ? 'Wallet imported and activated. Ready to use.'
          : 'Wallet key share imported. You may need to re-register or set the API key manually.',
      });
    } catch (e) {
      return formatToolError(e);
    }
  },
};

const walletBackup: ToolDefinition = {
  name: 'botwallet_wallet_backup',
  description:
    '⚠️ SENSITIVE: Reveals the 12-word mnemonic backup phrase for the current wallet. ' +
    'This is the local key share (S1) of the FROST 2-of-2 threshold key. ' +
    'Anyone with both this mnemonic AND the server key share can sign transactions. ' +
    'Only use when explicitly requested by the user for backup purposes.',
  inputSchema: z.object({}),
  async handler(_args, ctx) {
    try {
      if (!ctx.config.hasSeed || !ctx.config.walletName) {
        return noSeedError('reveal backup phrase');
      }

      const mnemonic = loadSeed(ctx.config.walletName);

      return formatResult({
        wallet: ctx.config.walletName,
        mnemonic,
        warning: 'This is your local FROST key share. Store it securely. Do not share it.',
        note: 'Both this mnemonic AND the server key share are required to sign transactions.',
      });
    } catch (e) {
      return formatToolError(e);
    }
  },
};

export const transferTools: ToolDefinition[] = [
  walletExport,
  walletImport,
  walletBackup,
];

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
