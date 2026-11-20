// Offline tests for botwallet_x402_discover. fetch is stubbed.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { x402Tools } from '../../../src/tools/x402.js';
import { USER_AGENT } from '../../../src/utils/user-agent.js';
import { parseResult, toolContext } from '../../helpers/harness.js';

const discover = x402Tools.find((t) => t.name === 'botwallet_x402_discover')!;

const ctx = toolContext({ getBaseUrl: () => 'https://api.example.test/v1' });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('botwallet_x402_discover', () => {
  it('queries the public catalog with our User-Agent and a timeout', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: { entries: [{ name: 'Weather', url: 'https://weather.example.test' }] },
    })));
    vi.stubGlobal('fetch', fetchMock);

    const out = parseResult(await discover.handler({ query: 'weather' }, ctx));

    expect(out.count).toBe(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.test/v1/public?action=x402_catalog&query=weather');
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(USER_AGENT);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports a timeout as TIMEOUT with a next step', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }));

    const result = await discover.handler({}, ctx);
    const out = parseResult(result);

    expect(result.isError).toBe(true);
    expect(out.code).toBe('TIMEOUT');
    expect(out.how_to_fix).toBeTruthy();
  });

  it('reports a timeout while the reply is still arriving as TIMEOUT too', async () => {
    const stalled = new ReadableStream({
      start(controller) {
        controller.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stalled, { status: 200 })));

    const out = parseResult(await discover.handler({}, ctx));

    expect(out.code).toBe('TIMEOUT');
  });

  it('reports an error status with a JSON body as NETWORK_ERROR, not as an empty catalog', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'upstream down' }), { status: 503 })));

    const result = await discover.handler({}, ctx);
    const out = parseResult(result);

    expect(result.isError).toBe(true);
    expect(out.code).toBe('NETWORK_ERROR');
    expect(out.message).toContain('HTTP 503');
  });

  it('keeps the server message when the catalog answers success: false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      success: false,
      error: { message: 'query too long' },
    }), { status: 400 })));

    const out = parseResult(await discover.handler({ query: 'x'.repeat(500) }, ctx));

    expect(out.message).toBe('query too long');
  });

  it('reports a failed connection as NETWORK_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));

    const out = parseResult(await discover.handler({}, ctx));

    expect(out.code).toBe('NETWORK_ERROR');
    expect(out.message).toBe('Could not reach the x402 catalog');
  });

  it('reports a reply that is not JSON as NETWORK_ERROR with the HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad gateway</html>', { status: 502 })));

    const out = parseResult(await discover.handler({}, ctx));

    expect(out.code).toBe('NETWORK_ERROR');
    expect(out.message).toContain('HTTP 502');
  });
});
