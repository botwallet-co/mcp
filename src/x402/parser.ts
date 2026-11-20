// Reading a 402 answer and choosing what to pay.
//
// Ported from the CLI (packages/cli-go/x402: parser.go, types.go and the
// network names of discover.go), which is the reference: the 402 is read from
// the JSON body (v1) or the base64 Payment-Required header (v2), and the
// payment header has the CLI's envelope.

import { usdcMintFor } from '../solana/index.js';
import { readResponseBody } from './client.js';

/** Largest 402 body read for payment requirements (as the CLI). */
const MAX_402_BODY = 1024 * 1024;

/** One way the API accepts payment. v1 names the price maxAmountRequired, v2 amount. */
export interface X402PaymentOption {
  scheme?: string;
  network: string;
  maxAmountRequired?: string;
  amount?: string;
  resource?: string;
  description?: string;
  mimeType?: string;
  payTo: string;
  asset?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

export interface X402Requirements {
  accepts: X402PaymentOption[];
  error?: string;
  x402Version?: number;
}

// ---------------------------------------------------------------------------
// 402 payment requirements
// ---------------------------------------------------------------------------

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function toOption(raw: unknown): X402PaymentOption | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const extra = o.extra && typeof o.extra === 'object' && !Array.isArray(o.extra)
    ? o.extra as Record<string, unknown>
    : undefined;
  return {
    scheme: str(o.scheme),
    network: str(o.network) ?? '',
    maxAmountRequired: str(o.maxAmountRequired),
    amount: str(o.amount),
    resource: str(o.resource),
    description: str(o.description),
    mimeType: str(o.mimeType),
    payTo: str(o.payTo) ?? '',
    asset: str(o.asset),
    maxTimeoutSeconds: typeof o.maxTimeoutSeconds === 'number' ? o.maxTimeoutSeconds : undefined,
    extra,
  };
}

/** Requirements from parsed JSON, or null when it lists no payment options. */
function toRequirements(value: unknown): X402Requirements | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.accepts)) return null;
  const accepts = v.accepts.map(toOption).filter((o): o is X402PaymentOption => o !== null);
  if (accepts.length === 0) return null;
  return {
    accepts,
    error: str(v.error),
    x402Version: typeof v.x402Version === 'number' ? v.x402Version : undefined,
  };
}

/** Standard base64, padded or not (as the CLI accepts), or null. */
function decodeBase64(value: string): string | null {
  const s = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  const unpadded = s.replace(/=+$/, '');
  if (unpadded.length % 4 === 1 || (s.length !== unpadded.length && s.length % 4 !== 0)) return null;
  return Buffer.from(s, 'base64').toString('utf8');
}

/**
 * Parse x402 payment requirements from a 402 response: the JSON body (v1)
 * first, then the base64 "Payment-Required" header (v2). Reads the body.
 * Throws an Error saying what is missing.
 */
export async function parse402Response(response: Response): Promise<X402Requirements> {
  const { text, truncated } = await readResponseBody(response, MAX_402_BODY);
  if (truncated) {
    throw new Error('402 response body exceeds 1 MB, so it is not a valid x402 response');
  }

  if (text.length > 2) { // skip empty "{}" or ""
    let fromBody: X402Requirements | null = null;
    try {
      fromBody = toRequirements(JSON.parse(text));
    } catch {
      // Not JSON: try the header
    }
    if (fromBody) return fromBody;
  }

  const header = response.headers.get('payment-required');
  if (!header) {
    throw new Error(text.length > 2
      ? '402 body contains no payment options, and there is no payment-required header'
      : '402 response contains no payment options (empty body, no payment-required header)');
  }

  const decoded = decodeBase64(header);
  if (decoded === null) throw new Error('payment-required header is not valid base64');
  let json: unknown;
  try {
    json = JSON.parse(decoded);
  } catch {
    throw new Error('payment-required header is not valid JSON');
  }
  const fromHeader = toRequirements(json);
  if (!fromHeader) throw new Error('payment-required header contains no payment options');
  return fromHeader;
}

/** The price in the option's own base units: v2 `amount`, else v1 `maxAmountRequired`. */
export function getAmount(option: X402PaymentOption): string {
  return option.amount || option.maxAmountRequired || '';
}

// ---------------------------------------------------------------------------
// Networks
// ---------------------------------------------------------------------------

// CAIP-2 ids (genesis hash prefixes) of the Solana clusters Botwallet pays on, lowercased
const CAIP2_SOLANA_MAINNET = 'solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdp';
const CAIP2_SOLANA_DEVNET = 'solana:etwtrabzayq6imfeykouru166vu2xqa1';

/** 'mainnet' or 'devnet' for a network name as x402 writes it; null for any other (testnet included). */
function solanaCluster(network: string): 'mainnet' | 'devnet' | null {
  const net = network.toLowerCase();
  if (net === CAIP2_SOLANA_DEVNET || (net.startsWith('solana') && net.includes('devnet'))) return 'devnet';
  if (net === 'solana' || net === 'solana-mainnet' || net === CAIP2_SOLANA_MAINNET) return 'mainnet';
  return null;
}

/**
 * The name the Botwallet server takes for a network it pays on (isPayableOption):
 * "solana" for mainnet, "solana-devnet" for devnet, CAIP-2 ids included. Any
 * other network is returned unchanged, as NormalizeSolanaNetwork does in the CLI
 * (x402/discover.go).
 */
export function normalizeSolanaNetwork(network: string): string {
  switch (solanaCluster(network)) {
    case 'mainnet': return 'solana';
    case 'devnet': return 'solana-devnet';
    default: return network;
  }
}

/**
 * True when Botwallet can pay this option: the "exact" scheme, on Solana
 * mainnet or devnet, priced in the USDC that Botwallet pays with there. A
 * price in any other token is in that token's own units, so paying it as USDC
 * would charge the wrong amount.
 */
export function isPayableOption(option: X402PaymentOption): boolean {
  if ((option.scheme ?? '').toLowerCase() !== 'exact') return false;
  const cluster = solanaCluster(option.network);
  return cluster !== null && option.asset === usdcMintFor(cluster);
}

/** The first option Botwallet can pay (isPayableOption), if any. */
export function findSolanaOption(requirements: X402Requirements): X402PaymentOption | undefined {
  return (requirements.accepts ?? []).find(isPayableOption);
}

/** The networks the API accepts, without repeats. */
export function availableNetworks(requirements: X402Requirements): string[] {
  const seen = new Set<string>();
  const networks: string[] = [];
  for (const option of requirements.accepts ?? []) {
    const key = option.network.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    networks.push(option.network);
  }
  return networks;
}

/**
 * Build the X-Payment header for an authenticated request, exactly as the
 * CLI's BuildXPaymentHeader writes it (same fields, in the same order).
 */
export function buildXPaymentHeader(signedTx: string, network: string): string {
  return JSON.stringify({
    network: network || 'solana',
    payload: { signature: signedTx, transaction: signedTx },
    scheme: 'exact',
    x402Version: 1,
  });
}
