import { configDefaults, defineConfig } from 'vitest/config';

// tests/e2e calls the live Botwallet API and public websites. It runs only
// with `npm run test:e2e` (or BOTWALLET_E2E=1), so `npm test`, and the
// publish workflow with it, works offline and doesn't depend on production.
export default defineConfig(({ mode }) => {
  const e2e = mode === 'e2e' || !!process.env.BOTWALLET_E2E;
  return {
    test: {
      testTimeout: 30000,
      exclude: e2e ? configDefaults.exclude : [...configDefaults.exclude, 'tests/e2e/**'],
    },
  };
});
