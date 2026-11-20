import type { ToolDefinition } from '../types.js';
import { walletTools } from './wallet.js';
import { spendingTools } from './spending.js';
import { earningTools } from './earning.js';
import { fundingTools } from './funding.js';
import { withdrawalTools } from './withdrawals.js';
import { x402Tools } from './x402.js';
import { historyTools } from './history.js';
import { walletFileTools } from './wallet-files.js';

export const ALL_TOOLS: ToolDefinition[] = [
  ...walletTools,
  ...spendingTools,
  ...earningTools,
  ...fundingTools,
  ...withdrawalTools,
  ...x402Tools,
  ...historyTools,
  ...walletFileTools,
];
