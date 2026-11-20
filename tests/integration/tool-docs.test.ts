// The tool list people read (README.md's tables and tool count, and the tool
// count in glama.json) matches the tools the server registers.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ALL_TOOLS } from '../../src/tools/index.js';

const packageFile = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf-8');

describe('tool documentation', () => {
  const names = ALL_TOOLS.map(t => t.name).sort();

  it('README.md has one table row per tool', () => {
    const rows = packageFile('README.md').split('\n')
      .map(line => /^\| `(botwallet_[a-z0-9_]+)` \|/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined);

    expect([...rows].sort()).toEqual(names);
  });

  it('README.md gives the number of tools', () => {
    expect(packageFile('README.md')).toContain(`${ALL_TOOLS.length} tools across`);
  });

  it('glama.json gives the number of tools', () => {
    expect(JSON.parse(packageFile('glama.json')).tools).toBe(ALL_TOOLS.length);
  });
});
