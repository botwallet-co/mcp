import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  dts: true,
  clean: true,
  // @scure/base 2.x ships only ES modules, which require() cannot load before
  // Node 20.19 / 22.12. Bundling it keeps dist/index.cjs working on every
  // Node version in "engines".
  noExternal: ['@scure/base'],
});
