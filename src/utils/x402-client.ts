// x402 HTTP helpers for probing paid APIs and making payment-authenticated requests.

import type { URL } from 'node:url';
import { MCP_VERSION } from './version.js';

export interface X402PaymentOption {
  pay_to: string;
  amount: string;
  network: string;
  method: string;
  [key: string]: unknown;
}

export interface X402Requirements {
  accepts: X402PaymentOption[];
  description?: string;
  [key: string]: unknown;
}

/**
 * Probe a URL to determine if it requires x402 payment.
 * Returns the response directly - caller checks status.
 */
export async function probeUrl(
  url: string,
  method: string = 'GET',
  headers?: Record<string, string>,
  body?: string,
): Promise<Response> {
  validateUrl(url);
  const opts: RequestInit = {
    method,
    headers: {
      'User-Agent': `BotWallet-MCP/${MCP_VERSION}`,
      ...headers,
    },
  };
  if (body && method !== 'GET' && method !== 'HEAD') {
    opts.body = body;
  }
  return fetch(url, opts);
}

/**
 * Parse x402 payment requirements from a 402 response.
 */
export function parse402Response(response: Response): X402Requirements | null {
  const header = response.headers.get('x-payment');
  if (!header) return null;

  try {
    return JSON.parse(header) as X402Requirements;
  } catch {
    return null;
  }
}

/**
 * Find a Solana-compatible payment option from x402 requirements.
 */
export function findSolanaOption(requirements: X402Requirements): X402PaymentOption | undefined {
  return requirements.accepts.find(
    opt => opt.network?.toLowerCase().includes('solana') ||
           opt.network?.toLowerCase() === 'solana-mainnet',
  );
}

/**
 * Build the X-Payment header for an authenticated request.
 */
export function buildXPaymentHeader(signedTx: string, network: string): string {
  return JSON.stringify({ transaction: signedTx, network });
}

/**
 * Fetch a URL with an x402 payment header.
 */
export async function fetchWithPayment(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  xPayment: string,
): Promise<Response> {
  validateUrl(url);
  const opts: RequestInit = {
    method,
    headers: {
      'User-Agent': `BotWallet-MCP/${MCP_VERSION}`,
      'X-Payment': xPayment,
      ...headers,
    },
  };
  if (body && method !== 'GET' && method !== 'HEAD') {
    opts.body = body;
  }
  return fetch(url, opts);
}

/**
 * Validate a URL: reject private networks, localhost, non-HTTP(S).
 */
export function validateUrl(url: string): void {
  let parsed: globalThis.URL;
  try {
    parsed = new globalThis.URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Only HTTP(S) URLs are supported, got ${parsed.protocol}`);
  }

  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw new Error('Cannot make x402 requests to private/local networks');
  }
}
