import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotWallet } from './sdk/index.js';
import type { ConfigContext, ToolContext } from './types.js';
import { ALL_TOOLS } from './tools/index.js';
import { ALL_RESOURCES } from './resources/index.js';
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
      (args: Record<string, unknown>) => tool.handler(args, ctx),
    );
  }

  for (const resource of ALL_RESOURCES) {
    server.registerResource(
      resource.name,
      resource.uri,
      { description: resource.description },
      async () => ({
        contents: [{
          uri: resource.uri,
          mimeType: 'text/plain',
          text: await resource.read(sdk, config),
        }],
      }),
    );
  }

  return server;
}
