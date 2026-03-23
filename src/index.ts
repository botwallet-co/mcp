#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BotWallet } from './sdk/index.js';
import { createServer } from './server.js';
import { configExists, resolveApiKey, resolveWalletName, seedExists } from './config/index.js';
import type { ConfigContext } from './types.js';

async function main() {
  // Resolve wallet configuration
  const walletName = resolveWalletName();
  const apiKey = resolveApiKey(walletName);
  const hasConfig = configExists();
  const hasSeed = walletName ? seedExists(walletName) : false;

  const config: ConfigContext = {
    walletName,
    hasConfig,
    hasSeed,
  };

  // Create SDK client
  const sdk = new BotWallet({
    apiKey: apiKey || undefined,
    baseUrl: process.env.BOTWALLET_BASE_URL,
  });

  // Create and start MCP server
  const server = createServer(sdk, config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`Fatal: ${error.message || error}\n`);
  process.exit(1);
});
