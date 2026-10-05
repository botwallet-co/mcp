// Hints for MCP clients about what each tool does (MCP tool annotations).
// With them a client can let reads through without asking, and ask the
// user before a tool that moves money, touches Key 1 or can't be undone.
// They are only hints: the owner's guard rails on the server and the check
// before Key 1 signs are what protect the wallet.

import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

/** Only reads, from Botwallet or the local config. */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: false,
};

/** Changes something that can be changed back (a name, the active wallet). */
export const UPDATES: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Creates something new (a wallet, a paylink, a request to the owner). */
export const CREATES: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

/** Sends a request or a message outside Botwallet, without moving money. */
export const REACHES_OUT: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/** Cancels or replaces something, which can't be undone. */
export const CANNOT_UNDO: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

/** Can move money out of the wallet. */
export const MOVES_MONEY: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

/**
 * Reveals Key 1, writes it to a file, or brings in another wallet's. Never
 * marked read-only, even when nothing changes, so clients ask first.
 */
export const KEY_MATERIAL: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
