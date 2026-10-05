// The errors for a missing key share or config must not send the agent off
// to register a new wallet when its real wallet is only out of reach.

import { describe, it, expect } from 'vitest';
import { noConfigError, noSeedError } from '../../../src/utils/errors.js';
import type { ToolResult } from '../../../src/types.js';

function parse(result: ToolResult): Record<string, any> {
  return JSON.parse(result.content[0].text);
}

const tools = (out: Record<string, any>) => (out.options as Array<{ tool: string }>).map(o => o.tool);

describe('noSeedError', () => {
  it('for a known wallet, says which key share is missing and never offers to register', () => {
    const result = noSeedError('make a payment (FROST signing)', 'research-bot');
    const out = parse(result);

    expect(result.isError).toBe(true);
    expect(out.code).toBe('NO_LOCAL_SEED');
    expect(out.message).toContain('research-bot');
    expect(out.message).toContain('no local key share');
    expect(out.message).toContain('seeds/research-bot.seed');
    expect(out.how_to_fix).toContain('Do not register a new wallet');
    expect(tools(out)).not.toContain('botwallet_register');
    expect(tools(out)).toContain('botwallet_wallet_import');
  });

  it('without a wallet, offers registering last and only for a brand-new wallet', () => {
    const out = parse(noSeedError('make a payment (FROST signing)'));

    expect(out.message).toContain('no local key share');
    expect(tools(out).at(-1)).toBe('botwallet_register');
    expect(out.options.at(-1).description).toContain('brand-new');
    expect(out.how_to_fix).toContain('If you already have a Botwallet, do not register a new one');
  });
});

describe('noConfigError', () => {
  it('points to restoring or importing first, and registering last', () => {
    const out = parse(noConfigError('list wallets'));

    expect(out.code).toBe('NO_LOCAL_CONFIG');
    expect(out.message).toContain('no local config found');
    expect(tools(out)[0]).toBe('botwallet_wallet_import');
    expect(tools(out).at(-1)).toBe('botwallet_register');
    // botwallet_wallet_list fails the same way without config, so it isn't offered
    expect(tools(out)).not.toContain('botwallet_wallet_list');
  });
});
