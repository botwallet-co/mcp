// x402 client helpers, offline: parsing 402 answers the way the CLI does
// (packages/cli-go/x402), which payment options Botwallet can pay, the payment
// header, and which addresses the MCP refuses to call. fetch and DNS are mocked.

import { describe, it, expect, vi, afterEach } from 'vitest';

const dns = vi.hoisted(() => ({ answers: new Map<string, string[]>() }));
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    const answer = dns.answers.get(host);
    if (!answer) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return answer.map(address => ({ address, family: address.includes(':') ? 6 : 4 }));
  }),
}));

import {
  availableNetworks,
  buildXPaymentHeader,
  checkPaidRequest,
  checkUrl,
  fetchWithPayment,
  findSolanaOption,
  getAmount,
  isPayableOption,
  isSolanaNetwork,
  normalizeSolanaNetwork,
  parse402Response,
  probeUrl,
  readResponseBody,
  requireHttps,
  validateUrl,
  X402RequestError,
  type X402PaymentOption,
} from '../../../src/utils/x402-client.js';
import { testAddress, USDC_DEVNET, USDC_MAINNET } from '../../helpers/solana-messages.js';

const PAY_TO = testAddress('merchant');
const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CAIP2_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const CAIP2_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

const usdcOption = (extra: Partial<X402PaymentOption> = {}): X402PaymentOption => ({
  scheme: 'exact', network: 'solana', asset: USDC_MAINNET, payTo: PAY_TO, maxAmountRequired: '10000', ...extra,
});

const base64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');

afterEach(() => {
  vi.unstubAllGlobals();
  dns.answers.clear();
});

describe('parse402Response', () => {
  it('reads v1 payment options from the JSON body', async () => {
    const res = new Response(JSON.stringify({
      x402Version: 1,
      error: 'X-PAYMENT header is required',
      accepts: [{
        scheme: 'exact', network: 'solana', maxAmountRequired: '10000', resource: 'https://api.example.com/data',
        description: 'Weather data', payTo: PAY_TO, asset: USDC_MAINNET, maxTimeoutSeconds: 60,
        extra: { feePayer: testAddress('facilitator') },
      }],
    }), { status: 402, headers: { 'content-type': 'application/json' } });

    const pr = await parse402Response(res);
    expect(pr.x402Version).toBe(1);
    expect(pr.accepts).toHaveLength(1);
    expect(pr.accepts[0]).toMatchObject({
      scheme: 'exact', network: 'solana', payTo: PAY_TO, asset: USDC_MAINNET, description: 'Weather data',
    });
    expect(getAmount(pr.accepts[0])).toBe('10000');
  });

  it('reads v2 payment options from the base64 Payment-Required header when the body is empty', async () => {
    const header = base64({
      x402Version: 2,
      accepts: [{ scheme: 'exact', network: CAIP2_MAINNET, amount: '25000', payTo: PAY_TO, asset: USDC_MAINNET }],
    });
    const pr = await parse402Response(new Response('', { status: 402, headers: { 'Payment-Required': header } }));
    expect(pr.x402Version).toBe(2);
    expect(getAmount(pr.accepts[0])).toBe('25000');
    expect(normalizeSolanaNetwork(pr.accepts[0].network)).toBe('solana');
  });

  it('accepts an unpadded header and falls back to it when the body has no options', async () => {
    const header = base64({ accepts: [usdcOption()] }).replace(/=+$/, '');
    const res = new Response('{"error":"pay first"}', { status: 402, headers: { 'payment-required': header } });
    expect((await parse402Response(res)).accepts[0].payTo).toBe(PAY_TO);
  });

  it('falls back to the header when the body is not JSON', async () => {
    const res = new Response('<html>Payment required</html>', {
      status: 402, headers: { 'payment-required': base64({ accepts: [usdcOption()] }) },
    });
    expect((await parse402Response(res)).accepts).toHaveLength(1);
  });

  it('no longer reads the old x-payment response header', async () => {
    const res = new Response('', {
      status: 402, headers: { 'x-payment': JSON.stringify({ accepts: [{ network: 'solana', pay_to: PAY_TO, amount: '1' }] }) },
    });
    await expect(parse402Response(res)).rejects.toThrow(/no payment options/);
  });

  it('says what is missing', async () => {
    await expect(parse402Response(new Response('', { status: 402 })))
      .rejects.toThrow('402 response contains no payment options (empty body, no payment-required header)');
    await expect(parse402Response(new Response('{"accepts":[]}', { status: 402 })))
      .rejects.toThrow(/402 body contains no payment options/);
    await expect(parse402Response(new Response('', { status: 402, headers: { 'payment-required': 'not base64!' } })))
      .rejects.toThrow(/not valid base64/);
    await expect(parse402Response(new Response('', { status: 402, headers: { 'payment-required': base64({ accepts: [] }) } })))
      .rejects.toThrow(/header contains no payment options/);
  });

  it('refuses a 402 body over 1 MB', async () => {
    const big = JSON.stringify({ accepts: [usdcOption({ description: 'x'.repeat(1024 * 1024) })] });
    await expect(parse402Response(new Response(big, { status: 402 }))).rejects.toThrow(/exceeds 1 MB/);
  });

  it('ignores fields of the wrong type instead of trusting them', async () => {
    const res = new Response(JSON.stringify({
      accepts: [{ scheme: 'exact', network: 'solana', asset: USDC_MAINNET, payTo: PAY_TO, maxAmountRequired: 10000 }],
    }), { status: 402 });
    expect(getAmount((await parse402Response(res)).accepts[0])).toBe('');
  });
});

describe('getAmount', () => {
  it('prefers v2 amount over v1 maxAmountRequired, as the CLI does', () => {
    expect(getAmount(usdcOption({ amount: '5', maxAmountRequired: '9' }))).toBe('5');
    expect(getAmount(usdcOption({ amount: undefined, maxAmountRequired: '9' }))).toBe('9');
    expect(getAmount(usdcOption({ amount: '', maxAmountRequired: undefined }))).toBe('');
  });
});

describe('Solana networks', () => {
  it('recognises short names and CAIP-2 ids only', () => {
    for (const n of ['solana', 'Solana-Mainnet', 'solana-devnet', CAIP2_MAINNET, CAIP2_DEVNET]) {
      expect(isSolanaNetwork(n)).toBe(true);
    }
    for (const n of ['base', 'eip155:8453', 'not-solana', 'solanax', '']) {
      expect(isSolanaNetwork(n)).toBe(false);
    }
  });

  it('converts to the names the Botwallet server accepts', () => {
    const cases: Record<string, string> = {
      solana: 'solana',
      'solana-mainnet': 'solana',
      [CAIP2_MAINNET]: 'solana',
      'solana-devnet': 'solana-devnet',
      'Solana-Devnet': 'solana-devnet',
      [CAIP2_DEVNET]: 'solana-devnet',
      base: 'base',
    };
    for (const [input, want] of Object.entries(cases)) {
      expect(normalizeSolanaNetwork(input), input).toBe(want);
    }
  });

  it('lists the networks on offer once each', () => {
    const pr = { accepts: [usdcOption({ network: 'base' }), usdcOption({ network: 'Base' }), usdcOption()] };
    expect(availableNetworks(pr)).toEqual(['base', 'solana']);
  });
});

describe('which payment options Botwallet can pay', () => {
  const cases: Array<[string, Partial<X402PaymentOption>, boolean]> = [
    ['USDC on solana', {}, true],
    ['USDC on solana-mainnet', { network: 'solana-mainnet' }, true],
    ['USDC on CAIP-2 mainnet', { network: CAIP2_MAINNET }, true],
    ['scheme in capitals', { scheme: 'EXACT' }, true],
    ['USDC-Dev on solana-devnet', { network: 'solana-devnet', asset: USDC_DEVNET }, true],
    ['USDC-Dev on CAIP-2 devnet', { network: CAIP2_DEVNET, asset: USDC_DEVNET }, true],
    ['SOL on solana', { asset: WRAPPED_SOL }, false],
    ['no asset', { asset: undefined }, false],
    ['other scheme', { scheme: 'upto' }, false],
    ['no scheme', { scheme: undefined }, false],
    ['mainnet USDC on devnet', { network: 'solana-devnet' }, false],
    ['devnet USDC on mainnet', { asset: USDC_DEVNET }, false],
    ['CAIP-2 testnet', { network: 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z' }, false],
    ['USDC on Base', { network: 'base', asset: BASE_USDC }, false],
  ];
  for (const [name, change, want] of cases) {
    it(`${name}: ${want ? 'payable' : 'not payable'}`, () => {
      expect(isPayableOption(usdcOption(change))).toBe(want);
    });
  }

  it('picks the USDC option even when another token comes first', () => {
    const pr = {
      accepts: [
        usdcOption({ network: 'base', asset: BASE_USDC, payTo: '0xabc' }),
        usdcOption({ asset: WRAPPED_SOL, maxAmountRequired: '1000000' }),
        usdcOption(),
      ],
    };
    expect(findSolanaOption(pr)).toMatchObject({ asset: USDC_MAINNET, maxAmountRequired: '10000' });
    expect(findSolanaOption({ accepts: pr.accepts.slice(0, 2) })).toBeUndefined();
  });

  it('copes with requirements that list no options', () => {
    expect(findSolanaOption({} as never)).toBeUndefined();
    expect(availableNetworks({} as never)).toEqual([]);
  });
});

describe('buildXPaymentHeader', () => {
  it('writes the same bytes as the CLI (Go sorts the JSON keys)', () => {
    expect(buildXPaymentHeader('AQID', 'mainnet-beta'))
      .toBe('{"network":"mainnet-beta","payload":{"signature":"AQID","transaction":"AQID"},"scheme":"exact","x402Version":1}');
  });

  it('defaults the network to solana, as the CLI does', () => {
    expect(JSON.parse(buildXPaymentHeader('AQID', '')).network).toBe('solana');
  });
});

describe('validateUrl', () => {
  const refused = [
    'http://localhost:8080/secret',
    'http://LOCALHOST./',
    'http://api.localhost/',
    'http://127.0.0.1/',
    'http://127.0.0.2/',
    'http://2130706433/',
    'http://0x7f.1/',
    'http://0.0.0.0/',
    'http://[::1]:8080/',
    'http://[::]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:a9fe:a9fe]/',
    'http://[::7f00:1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[fd00:ec2::254]/',
    'http://[fe80::1]/',
    'http://10.1.2.3/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.1.1/',
    'http://100.64.0.1/',
    'http://100.100.100.200/',
    'http://224.0.0.1/',
  ];
  for (const url of refused) {
    it(`refuses ${url}`, () => {
      expect(() => validateUrl(url)).toThrow(X402RequestError);
      expect(() => validateUrl(url)).toThrow(/private or local/);
    });
  }

  it('refuses other schemes and invalid URLs', () => {
    expect(() => validateUrl('ftp://example.com/file')).toThrow(/Only HTTP\(S\)/);
    expect(() => validateUrl('file:///etc/passwd')).toThrow(X402RequestError);
    expect(() => validateUrl('not a url')).toThrow(/Invalid URL/);
  });

  for (const url of ['https://api.example.com/data', 'http://8.8.8.8/', 'https://[2606:4700:4700::1111]/', 'http://172.32.0.1/', 'http://100.128.0.1/']) {
    it(`allows ${url}`, () => {
      expect(() => validateUrl(url)).not.toThrow();
    });
  }
});

describe('checkUrl', () => {
  it('refuses a host name that points to a local address', async () => {
    dns.answers.set('metadata.google.internal', ['169.254.169.254']);
    dns.answers.set('rebind.example.com', ['93.184.215.14', '127.0.0.1']);
    dns.answers.set('v6.example.com', ['::1']);
    await expect(checkUrl('http://metadata.google.internal/computeMetadata/v1/')).rejects.toThrow(X402RequestError);
    await expect(checkUrl('https://rebind.example.com/')).rejects.toThrow(/rebind\.example\.com is 127\.0\.0\.1/);
    await expect(checkUrl('https://v6.example.com/')).rejects.toThrow(X402RequestError);
  });

  it('allows a host name with only public addresses', async () => {
    dns.answers.set('api.example.com', ['93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c']);
    await expect(checkUrl('https://api.example.com/data')).resolves.toBeInstanceOf(URL);
  });

  it('reports a failed lookup as a plain error, not as a refused address', async () => {
    const err = await checkUrl('https://nowhere.example.com/').catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(X402RequestError);
    expect(err.message).toMatch(/Could not find nowhere\.example\.com/);
  });
});

describe('requireHttps and checkPaidRequest', () => {
  it('refuses to pay over plain HTTP', async () => {
    expect(() => requireHttps('http://api.example.com/data')).toThrow(/HTTPS/);
    dns.answers.set('api.example.com', ['93.184.215.14']);
    await expect(checkPaidRequest('http://api.example.com/data', {})).rejects.toThrow(X402RequestError);
    await expect(checkPaidRequest('https://api.example.com/data', {})).resolves.toBeUndefined();
  });

  it('refuses an invalid header before anything is signed', async () => {
    dns.answers.set('api.example.com', ['93.184.215.14']);
    await expect(checkPaidRequest('https://api.example.com/data', { 'Bad Header': 'x' }))
      .rejects.toThrow(X402RequestError);
  });
});

describe('probeUrl', () => {
  it('follows redirects, checking every address again', async () => {
    dns.answers.set('api.example.com', ['93.184.215.14']);
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://api.example.com/start') {
        return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
      }
      return new Response('secret');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(probeUrl('https://api.example.com/start')).rejects.toThrow(/private or local/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('returns where the answer came from, as GET after a 303, without credentials for another site', async () => {
    dns.answers.set('api.example.com', ['93.184.215.14']);
    dns.answers.set('pay.example.net', ['93.184.215.15']);
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === 'https://api.example.com/q') {
        return new Response(null, { status: 303, headers: { location: 'https://pay.example.net/q2' } });
      }
      return new Response('', { status: 402 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const probe = await probeUrl('https://api.example.com/q', 'POST',
      { Authorization: 'Bearer abc', 'Content-Type': 'application/json' }, '{"q":1}');
    expect(probe).toMatchObject({ url: 'https://pay.example.net/q2', method: 'GET' });
    const second = fetchMock.mock.calls[1][1]!;
    expect(second.method).toBe('GET');
    expect(second.body).toBeUndefined();
    expect(new Headers(second.headers).get('authorization')).toBeNull();
    expect(new Headers(second.headers).get('content-type')).toBeNull();
  });

  it('stops after 5 redirects', async () => {
    dns.answers.set('api.example.com', ['93.184.215.14']);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 307, headers: { location: '/again' } })));
    await expect(probeUrl('https://api.example.com/loop')).rejects.toThrow(/redirected more than 5 times/);
  });
});

describe('fetchWithPayment', () => {
  it('sends X-Payment last, so a caller header cannot replace it, and does not follow redirects', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);

    await fetchWithPayment('https://api.example.com/data', 'post', { 'x-payment': 'forged', Accept: 'application/json' },
      '{"q":1}', 'signed');
    const init = fetchMock.mock.calls[0][1]!;
    const headers = new Headers(init.headers);
    expect(headers.get('x-payment')).toBe('signed');
    expect(headers.get('accept')).toBe('application/json');
    expect(init).toMatchObject({ method: 'POST', body: '{"q":1}', redirect: 'manual' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('never sends a payment over plain HTTP', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchWithPayment('http://api.example.com/data', 'GET', {}, undefined, 'signed'))
      .rejects.toThrow(X402RequestError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('readResponseBody', () => {
  it('keeps at most the size limit', async () => {
    const out = await readResponseBody(new Response('a'.repeat(100)), 10);
    expect(out).toEqual({ text: 'a'.repeat(10), truncated: true });
    expect(await readResponseBody(new Response('short'), 10)).toEqual({ text: 'short', truncated: false });
  });
});
