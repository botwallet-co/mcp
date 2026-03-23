import type { BotWallet } from '../sdk/index.js';
import type { ConfigContext } from '../types.js';
import { seedExists } from '../config/index.js';
import { formatUsd } from '../utils/format.js';

/**
 * Build the botwallet://status resource content.
 * Combines wallet info + balance into agent-readable context.
 */
export async function getWalletStatus(
  sdk: BotWallet,
  config: ConfigContext,
): Promise<string> {
  try {
    const [info, bal] = await Promise.all([
      sdk.info(),
      sdk.balance(),
    ]);

    const balance = (bal as Record<string, unknown>).balance as number ?? 0;
    const budget = (bal as Record<string, unknown>).budget as number | undefined;
    const spentThisPeriod = (bal as Record<string, unknown>).spent_this_period as number | undefined;
    const remainingBudget = (bal as Record<string, unknown>).remaining_budget as number | undefined;
    const budgetPeriod = (bal as Record<string, unknown>).budget_period as string | undefined;

    const lines: string[] = [
      `Wallet: ${(info as Record<string, unknown>).name || (info as Record<string, unknown>).username} (@${(info as Record<string, unknown>).username})`,
      `Status: ${(info as Record<string, unknown>).status} | Owner: ${(info as Record<string, unknown>).is_claimed ? 'claimed' : 'unclaimed'}`,
      `Balance: ${formatUsd(balance)} USDC`,
    ];

    if (budget != null) {
      lines.push(
        `Budget: ${formatUsd(budget)}/${budgetPeriod || 'daily'} | ` +
        `Spent: ${formatUsd(spentThisPeriod ?? 0)} | ` +
        `Remaining: ${formatUsd(remainingBudget ?? budget)}`,
      );
    }

    lines.push(`Deposit Address: ${(info as Record<string, unknown>).deposit_address}`);

    if (config.walletName) {
      const hasSeed = seedExists(config.walletName);
      lines.push(
        `Local Key Share: ~/.botwallet/seeds/${config.walletName}.seed (${hasSeed ? 'present' : 'MISSING'})`,
      );
    } else {
      lines.push('Local Key Share: not configured (env-only mode)');
    }

    if ((bal as Record<string, unknown>).low_balance) {
      lines.push(`⚠ Low balance — fund via: ${(info as Record<string, unknown>).funding_url}`);
    }

    return lines.join('\n');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Wallet status unavailable: ${msg}`;
  }
}
