import { MCP_VERSION } from './version.js';

/**
 * Sent with every request this package makes, to the Botwallet API and to
 * paid APIs, so they can tell MCP traffic (and its version) from the CLI's
 * "Botwallet-CLI/<version>".
 */
export const USER_AGENT = `BotWallet-MCP/${MCP_VERSION}`;
