import type { ResourceDefinition } from '../types.js';
import { getWalletStatus } from './wallet-status.js';

export { getWalletStatus };

export const ALL_RESOURCES: ResourceDefinition[] = [
  {
    name: 'wallet-status',
    uri: 'botwallet://status',
    description: 'Current wallet status: balance, limits, deposit address, local key share status, ' +
      'and the claim link while no human owner has claimed the wallet.',
    read: getWalletStatus,
  },
];
