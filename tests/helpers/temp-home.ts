// A temporary home folder for tests that write ~/.botwallet:
//
//   const testHome = path.join(os.tmpdir(), `bw-<name>-test-${Date.now()}`);
//   vi.mock('node:os', async () => (await import('../../helpers/temp-home.js')).osWithHome(() => testHome));
//
// vi.mock is hoisted above the imports, so the module is loaded inside the
// factory. It must not import node:os itself: that is the module being mocked.

import { vi } from 'vitest';

/** node:os with homedir() answering `home()`. */
export async function osWithHome(home: () => string): Promise<typeof import('node:os')> {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: home };
}
