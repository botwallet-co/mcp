import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotWallet } from './sdk/index.js';
import type { ConfigContext, ToolContext } from './types.js';
import { ALL_TOOLS } from './tools/index.js';
import { getWalletStatus } from './resources/index.js';
import { formatToolError } from './utils/errors.js';
import { MCP_VERSION } from './utils/version.js';

/**
 * Create a configured MCP server.
 * Pure factory — no transport. Caller is responsible for connecting stdio/SSE/etc.
 */
export function createServer(sdk: BotWallet, config: ConfigContext): McpServer {
  const server = new McpServer(
    {
      name: 'BotWallet',
      version: MCP_VERSION,
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
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema.shape,
        annotations: tool.annotations,
      },
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
    {
      description: 'Current wallet status: balance, limits, deposit address, local key share status, ' +
        'and the claim link while no human owner has claimed the wallet.',
    },
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
