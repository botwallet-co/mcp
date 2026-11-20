// The x402 catalog: paid APIs Botwallet lists, from the public endpoint of
// the Botwallet API (the CLI's `botwallet x402 discover`, packages/cli-go/cmd/x402.go).

import { BotWalletError } from '../sdk/index.js';
import { USER_AGENT } from '../utils/user-agent.js';

/** Same as the API client's default timeout. */
const CATALOG_TIMEOUT_MS = 30_000;

/** A failed catalog request as an error with a next step. `status` is 0 when no reply came. */
function catalogError(e: unknown, status: number): BotWalletError {
  if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
    return new BotWalletError('TIMEOUT', `The x402 catalog did not answer within ${CATALOG_TIMEOUT_MS / 1000} seconds`, 'Try again in a moment.');
  }
  if (status) {
    return new BotWalletError('NETWORK_ERROR', `The x402 catalog sent an unreadable reply (HTTP ${status})`, 'Try again in a moment.');
  }
  return new BotWalletError('NETWORK_ERROR', 'Could not reach the x402 catalog', 'Check your internet connection and try again.');
}

/**
 * The catalog entries matching `query` (all of them without one). `baseUrl`
 * is the API's, e.g. https://api.botwallet.co/v1; the catalog needs no API key.
 * Throws a BotWalletError when the catalog can't be read, and a plain Error
 * with the catalog's message when it refuses the query.
 */
export async function searchCatalog(baseUrl: string, query?: string): Promise<Array<Record<string, unknown>>> {
  const url = new URL(`${baseUrl}/public`);
  url.searchParams.set('action', 'x402_catalog');
  if (query) url.searchParams.set('query', query);

  // The timeout covers reading the reply as well as waiting for it
  let status = 0;
  let json: Record<string, unknown>;
  try {
    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
    status = res.status;
    json = await res.json() as Record<string, unknown>;
  } catch (e) {
    throw catalogError(e, status);
  }

  if (json.success === false) {
    const err = json.error as Record<string, unknown> | undefined;
    throw new Error((err?.message as string) || 'Failed to query x402 catalog');
  }
  if (status !== 200) {
    throw new BotWalletError('NETWORK_ERROR', `The x402 catalog answered HTTP ${status}`, 'Try again in a moment.');
  }

  const data = (json.data || {}) as Record<string, unknown>;
  return (data.entries || []) as Array<Record<string, unknown>>;
}
