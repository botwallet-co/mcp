// How a tool is written. defineTool gives `run` its arguments typed by the
// input schema (the MCP SDK checks them against it before the call) and turns
// anything `run` throws into formatToolError's structured error, so no tool
// needs a catch of its own. apiTool is for tools that only pass their
// arguments to one API call.

import type { z } from 'zod';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { BotWallet } from '../sdk/index.js';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';
import { formatResult, formatToolError } from '../utils/tool-result.js';

/** What ToolDefinition (types.ts) describes, with the schema's own type. */
interface ToolSpec<T extends z.AnyZodObject> {
  name: string;
  description: string;
  annotations: ToolAnnotations;
  inputSchema: T;
}

export function defineTool<T extends z.AnyZodObject>(
  spec: ToolSpec<T> & { run(args: z.infer<T>, ctx: ToolContext): Promise<ToolResult> },
): ToolDefinition {
  const { run, ...definition } = spec;
  return {
    ...definition,
    async handler(args, ctx) {
      try {
        return await run(args as z.infer<T>, ctx);
      } catch (e) {
        return formatToolError(e);
      }
    },
  };
}

/** A tool that makes one API call and returns its answer as it came. */
export function apiTool<T extends z.AnyZodObject>(
  spec: ToolSpec<T> & { call(sdk: BotWallet, args: z.infer<T>): Promise<object> },
): ToolDefinition {
  const { call, ...definition } = spec;
  return defineTool({
    ...definition,
    run: async (args, ctx) => formatResult(await call(ctx.sdk, args)),
  });
}
