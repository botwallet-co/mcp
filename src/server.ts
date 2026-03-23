import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotWallet } from './sdk/index.js';
import type { ConfigContext, ToolContext } from './types.js';
import { ALL_TOOLS } from './tools/index.js';
import { getWalletStatus } from './resources/index.js';
import { formatToolError } from './utils/errors.js';

/**
 * Create a configured MCP server.
 * Pure factory — no transport. Caller is responsible for connecting stdio/SSE/etc.
 */
export function createServer(sdk: BotWallet, config: ConfigContext): McpServer {
  const server = new McpServer(
    {
      name: 'BotWallet',
      version: '0.2.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  const ctx: ToolContext = { sdk, config };

  // Register all tools — pass Zod shapes so the SDK handles validation and JSON Schema conversion
  for (const tool of ALL_TOOLS) {
    server.tool(
      tool.name,
      tool.description,
      tool.inputSchema.shape,
      async (args: Record<string, unknown>) => {
        try {
          return await tool.handler(args, ctx);
        } catch (e) {
          return formatToolError(e);
        }
      },
    );
  }

  // Register resources
  server.resource(
    'wallet-status',
    'botwallet://status',
    { description: 'Current wallet status: balance, limits, deposit address, and local key share status.' },
    async () => ({
      contents: [{
        uri: 'botwallet://status',
        mimeType: 'text/plain',
        text: await getWalletStatus(sdk, config),
      }],
    }),
  );

  return server;
}
