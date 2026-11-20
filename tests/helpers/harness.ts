// What the tool tests share: the test key shares, reading a tool's result, a
// ToolContext over a fake SDK, and an MCP client talking to the server in
// memory.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { BotWallet } from '../../src/sdk/index.js';
import { createServer } from '../../src/server.js';
import type { ConfigContext, ToolContext, ToolResult } from '../../src/types.js';

/** BIP39 test phrases, used as Key 1 of the test wallets. */
export const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
export const OTHER_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

/** A session with no local wallet (env-only, or nothing set up yet). */
const NO_WALLET: ConfigContext = { walletName: undefined, hasConfig: false, hasSeed: false };

/** The session of a local wallet whose Key 1 is on this machine. */
export function localWallet(walletName: string): ConfigContext {
  return { walletName, hasConfig: true, hasSeed: true };
}

/** A ToolContext over a fake SDK (only the methods a test needs). */
export function toolContext(sdk: object, config: Partial<ConfigContext> = {}): ToolContext {
  return { sdk: sdk as unknown as BotWallet, config: { ...NO_WALLET, ...config } };
}

type CallToolResult = Awaited<ReturnType<Client['callTool']>>;

/** The text of a tool's result, from tool.handler or through the MCP client. */
export function resultText(result: ToolResult | CallToolResult): string {
  const [first] = result.content as Array<{ type: string; text?: string }>;
  return first?.text ?? '';
}

/** A tool's result as the JSON it is. */
export function parseResult(result: ToolResult | CallToolResult): Record<string, any> {
  return JSON.parse(resultText(result));
}

/** An MCP client connected in memory to the server over `sdk`. */
export async function connectClient(sdk: object, config: Partial<ConfigContext> = {}): Promise<Client> {
  const server = createServer(sdk as unknown as BotWallet, { ...NO_WALLET, ...config });
  const client = new Client({ name: 'test-client', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}
