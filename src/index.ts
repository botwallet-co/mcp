#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BotWallet } from './sdk/index.js';
import { createServer } from './server.js';
import { configExists, resolveBaseUrl, resolveWallet, seedExists } from './config/index.js';
import type { ConfigContext } from './types.js';

async function main() {
  // Resolve the API key and the key share together, so both are the same wallet's
  const resolved = resolveWallet();
  for (const warning of resolved.warnings) {
    process.stderr.write(`Warning: ${warning}\n`);
  }
  const walletName = resolved.name;
  const apiKey = resolved.apiKey;
  const hasConfig = configExists();
  const hasSeed = walletName ? seedExists(walletName) : false;

  const config: ConfigContext = {
    walletName,
    hasConfig,
    hasSeed,
  };

  // Create SDK client. The API URL is looked up the way the CLI does it, so
  // both talk to the same server for the same wallet.
  const sdk = new BotWallet({
    apiKey: apiKey || undefined,
    baseUrl: resolveBaseUrl(),
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
