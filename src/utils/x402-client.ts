// x402 HTTP helpers for probing paid APIs and making payment-authenticated requests.
//
// Ported from the CLI (packages/cli-go/x402: parser.go, discover.go,
// client.go), which is the reference: the 402 is read from the JSON body (v1)
// or the base64 Payment-Required header (v2), and the payment header has the
// CLI's envelope. The MCP checks addresses a little more strictly than the
// CLI (DNS answers and every redirect too), because a prompt-injected agent
// can ask it to probe any URL.

import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { usdcMintFor } from '../solana/index.js';
import { USER_AGENT } from './user-agent.js';

/** Largest 402 body read for payment requirements (as the CLI). */
export const MAX_402_BODY = 1024 * 1024;
/** Largest API response read (as the CLI). */
export const MAX_RESPONSE_BODY = 10 * 1024 * 1024;
/** Time allowed for one request, including reading its body (as the CLI). */
export const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

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

/** Botwallet will not send this request (its URL or headers). Nothing was sent. */
export class X402RequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'X402RequestError';
  }
}

// ---------------------------------------------------------------------------
// Address checks
// ---------------------------------------------------------------------------

// Addresses that are not on the public internet: this machine, private
// networks, link-local (cloud metadata at 169.254.169.254), carrier-grade NAT,
// multicast and reserved ranges. BlockList checks IPv4-mapped IPv6
// (::ffff:a.b.c.d) against the IPv4 rules itself.
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  // ::, ::1 and the old IPv4-compatible form ::a.b.c.d
  ['::', 96], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** True for an IP address that isn't on the public internet. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) return blocked.check(address, 'ipv6');
  return false;
}

/** The host as an address or DNS name: no IPv6 brackets, no trailing dot, lower case. */
function bareHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

/**
 * Check a URL without any network access: http(s) only, and no local or
 * private host given by name or as an IP address. Throws X402RequestError.
 */
export function validateUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new X402RequestError(`Invalid URL: ${url}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new X402RequestError(`Only HTTP(S) URLs are supported, got ${parsed.protocol}`);
  }

  const host = bareHost(parsed);
  if (!host || host === 'localhost' || host.endsWith('.localhost') || isBlockedAddress(host)) {
    throw new X402RequestError(`Cannot make x402 requests to private or local network addresses (${host || 'no host'})`);
  }
  return parsed;
}

/**
 * validateUrl, then look the host name up and refuse it if any address it
 * points to is local or private (e.g. a name for the cloud metadata address).
 * A failed lookup throws a plain Error. Either way nothing was sent.
 */
export async function checkUrl(url: string): Promise<URL> {
  const parsed = validateUrl(url);
  const host = bareHost(parsed);
  if (isIP(host)) return parsed;

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch (e) {
    throw new Error(`Could not find ${host} (${(e as Error).message})`);
  }
  const local = addresses.find(a => isBlockedAddress(a.address));
  if (local) {
    throw new X402RequestError(`Cannot make x402 requests to private or local network addresses (${host} is ${local.address})`);
  }
  return parsed;
}

/** A paid request must use HTTPS: the signed payment must never travel in plain text. Throws X402RequestError. */
export function requireHttps(url: string): void {
  const protocol = validateUrl(url).protocol;
  if (protocol !== 'https:') {
    throw new X402RequestError(
      `x402 payments need an HTTPS URL (got ${protocol.replace(':', '')}), so the signed payment cannot be read or changed on the way`,
    );
  }
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

function requestHeaders(headers: Record<string, string> | undefined, xPayment?: string): Headers {
  const out = new Headers({ 'User-Agent': USER_AGENT });
  for (const [name, value] of Object.entries(headers ?? {})) out.set(name, value);
  // Set last, so no caller header (in any letter case) can replace it
  if (xPayment !== undefined) out.set('X-Payment', xPayment);
  return out;
}

function withBody(init: RequestInit, method: string, body: string | undefined): RequestInit {
  if (body && method !== 'GET' && method !== 'HEAD') init.body = body;
  return init;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// Headers fetch drops when a redirect goes to another site
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

export interface ProbeResult {
  response: Response;
  /** Where the response came from, after any redirects. */
  url: string;
  /** The method of the last request (a 303 turns it into GET). */
  method: string;
}

/**
 * Probe a URL to determine if it requires x402 payment, without paying.
 * Follows up to 5 redirects, checking every address again.
 * Returns the response directly - caller checks status.
 */
export async function probeUrl(
  url: string,
  method: string = 'GET',
  headers?: Record<string, string>,
  body?: string,
): Promise<ProbeResult> {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const sent = requestHeaders(headers);
  let current = url;
  let currentMethod = method.toUpperCase();
  let currentBody = body;

  for (let redirects = 0; ; redirects++) {
    await checkUrl(current);
    const response = await fetch(current, withBody(
      { method: currentMethod, headers: sent, redirect: 'manual', signal }, currentMethod, currentBody));

    const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get('location') : null;
    if (!location) return { response, url: current, method: currentMethod };
    if (redirects >= MAX_REDIRECTS) {
      throw new Error(`${url} redirected more than ${MAX_REDIRECTS} times`);
    }
    await response.body?.cancel().catch(() => undefined);

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new Error(`${current} redirected to an invalid URL`);
    }
    // Same rules as fetch: 303 (and 301/302 after a POST) continue as GET without a body
    if ((response.status === 303 && currentMethod !== 'HEAD') ||
        ((response.status === 301 || response.status === 302) && currentMethod === 'POST')) {
      currentMethod = 'GET';
      currentBody = undefined;
      sent.delete('content-type');
    }
    if (next.origin !== new URL(current).origin) {
      for (const name of CREDENTIAL_HEADERS) sent.delete(name);
    }
    current = next.toString();
  }
}

/**
 * Everything that can rule out a paid request before Key 1 signs it: the URL
 * (HTTPS, public address, DNS answers included) and the caller's headers.
 * Throws X402RequestError, or a plain Error when the host can't be looked up.
 */
export async function checkPaidRequest(url: string, headers: Record<string, string>): Promise<void> {
  requireHttps(url);
  await checkUrl(url);
  try {
    requestHeaders(headers, '');
  } catch (e) {
    throw new X402RequestError(`Invalid HTTP header: ${(e as Error).message}`);
  }
}

/**
 * Fetch a URL with an x402 payment header. HTTPS only, and redirects are not
 * followed, so the signed payment goes to this URL and nowhere else.
 * X402RequestError means nothing was sent; any other error means the
 * payment may have reached the API.
 */
export async function fetchWithPayment(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  xPayment: string,
): Promise<Response> {
  const upper = method.toUpperCase();
  let init: RequestInit;
  try {
    requireHttps(url);
    init = withBody({
      method: upper,
      headers: requestHeaders(headers, xPayment),
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, upper, body);
  } catch (e) {
    throw e instanceof X402RequestError ? e : new X402RequestError((e as Error).message);
  }
  return fetch(url, init);
}

/**
 * Read a response body as text, keeping at most `maxBytes` (the rest is
 * dropped and `truncated` is set).
 */
export async function readResponseBody(
  response: Response,
  maxBytes: number = MAX_RESPONSE_BODY,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size));
      size = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), truncated };
}

/** The body pretty-printed when the API says it is JSON and it parses, else as it came. */
export function displayBody(contentType: string | null, text: string): string {
  if (!(contentType ?? '').toLowerCase().includes('json')) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
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

/** True for a Solana network name: "solana", "solana-mainnet", "solana-devnet" or CAIP-2 "solana:...". */
export function isSolanaNetwork(network: string): boolean {
  const net = network.toLowerCase();
  return net === 'solana' || net === 'solana-mainnet' || net === 'solana-devnet' || net.startsWith('solana:');
}

/** 'mainnet' or 'devnet' for a network name as x402 writes it; null for any other (testnet included). */
function solanaCluster(network: string): 'mainnet' | 'devnet' | null {
  const net = network.toLowerCase();
  if (net === CAIP2_SOLANA_DEVNET || (net.startsWith('solana') && net.includes('devnet'))) return 'devnet';
  if (net === 'solana' || net === 'solana-mainnet' || net === CAIP2_SOLANA_MAINNET) return 'mainnet';
  return null;
}

/** The network name the Botwallet server accepts: "solana" or "solana-devnet" (CAIP-2 ids are converted). */
export function normalizeSolanaNetwork(network: string): string {
  if (solanaCluster(network) === 'devnet') return 'solana-devnet';
  if (isSolanaNetwork(network)) return 'solana';
  return network;
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
