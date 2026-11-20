// Requests to paid APIs: probing a URL without paying, and the request that
// carries the signed payment.
//
// Ported from the CLI (packages/cli-go/x402/client.go), which is the
// reference. The MCP checks addresses a little more strictly than the CLI
// (DNS answers and every redirect too), because a prompt-injected agent can
// ask it to probe any URL.

import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { USER_AGENT } from '../utils/user-agent.js';

/** Largest API response read (as the CLI). */
const MAX_RESPONSE_BODY = 10 * 1024 * 1024;
/** Time allowed for one request, including reading its body (as the CLI). */
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

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
function isBlockedAddress(address: string): boolean {
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

/**
 * Refuses a probe's answer that came from another host than the one probed
 * (a subdomain is another host), as the CLI's CheckAnsweringHost. The payment
 * is prepared for the URL that answered, and the paid request sends the
 * caller's headers there. Those headers were meant for the host that was
 * probed, and the probe itself kept Authorization, Cookie and
 * Proxy-Authorization from every other origin, so a request for payment from
 * another host is not prepared. Another path, port or scheme on the same host
 * is still the API that was probed.
 * Throws X402RequestError.
 */
export function checkAnsweringHost(probedUrl: string, answeredUrl: string): void {
  const probed = bareHost(new URL(probedUrl));
  const answered = bareHost(new URL(answeredUrl));
  if (probed !== answered) {
    throw new X402RequestError(
      `${probed} redirected to another host, ${answered}. Nothing was prepared or paid. ` +
      'To pay that host, probe its URL directly and pass only the headers meant for it',
    );
  }
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
