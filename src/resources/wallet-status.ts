import { BotWalletError, type BotWallet } from '../sdk/index.js';
import type { ConfigContext } from '../types.js';
import { seedExists } from '../config/index.js';
import { formatUsd } from '../utils/format.js';

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Where the wallet's owner stands, and what the agent should do about it.
 * The server answers most calls with WALLET_NOT_CLAIMED or WALLET_ABANDONED
 * until a human owner claims the wallet, so the claim link is the useful part.
 */
function claimLines(info: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const claimUrl = text(info.claim_url);
  const claimCode = text(info.claim_code);
  const pledgedTo = text(info.pledged_to);

  if (claimUrl) lines.push(`Claim URL: ${claimUrl}`);
  if (claimCode) {
    const expires = info.status === 'unclaimed' ? text(info.claim_expires_at) : undefined;
    lines.push(`Claim Code: ${claimCode}${expires ? ` (expires ${expires})` : ''}`);
  }
  if (pledgedTo) lines.push(`Pledged To: ${pledgedTo}`);

  if (info.status === 'abandoned') {
    lines.push(pledgedTo
      ? 'Next Step: the previous owner abandoned this wallet. Share the claim URL and code with your human. ' +
        `If it should go to someone other than ${pledgedTo}, call botwallet_update_owner with their email first.`
      : 'Next Step: the previous owner abandoned this wallet. Ask your human for their email, call ' +
        'botwallet_update_owner with it, then share the claim URL and the new code with them.');
  } else {
    lines.push(`Next Step: ${text(info.claim_instructions) ||
      'Share the claim URL and code with your human owner so they can claim this wallet.'}`);
  }
  lines.push('Most actions, including payments and the live balance, work once your human owner claims the wallet.');
  return lines;
}

/**
 * Build the botwallet://status resource content.
 * Combines wallet info + balance into agent-readable context. The info lines
 * are shown even when the balance can't be read, which is always the case
 * for a wallet nobody has claimed yet.
 */
export async function getWalletStatus(
  sdk: BotWallet,
  config: ConfigContext,
): Promise<string> {
  const [infoResult, balanceResult] = await Promise.allSettled([
    sdk.info(),
    sdk.balance(),
  ]);
  if (infoResult.status === 'rejected') {
    const reason = infoResult.reason;
    const unavailable = `Wallet status unavailable: ${errorMessage(reason)}`;
    return reason instanceof BotWalletError && reason.howToFix
      ? `${unavailable}\nNext Step: ${reason.howToFix}`
      : unavailable;
  }

  const info = infoResult.value as unknown as Record<string, unknown>;
  const bal = balanceResult.status === 'fulfilled'
    ? balanceResult.value as unknown as Record<string, unknown>
    : undefined;
  // is_claimed is true for an abandoned wallet, so go by the status
  const needsOwner = info.status === 'unclaimed' || info.status === 'abandoned';
  const owner = info.status === 'abandoned' ? 'none (abandoned)' : needsOwner ? 'unclaimed' : 'claimed';

  const lines: string[] = [
    `Wallet: ${info.name || info.username} (@${info.username})`,
    `Status: ${info.status} | Owner: ${owner}`,
  ];

  if (bal) {
    const balance = bal.balance as number ?? 0;
    const budget = bal.budget as number | undefined;
    const spentThisPeriod = bal.spent_this_period as number | undefined;
    const remainingBudget = bal.remaining_budget as number | undefined;
    const budgetPeriod = bal.budget_period as string | undefined;

    lines.push(`Balance: ${formatUsd(balance)} USDC`);
    if (budget != null) {
      lines.push(
        `Budget: ${formatUsd(budget)}/${budgetPeriod || 'daily'} | ` +
        `Spent: ${formatUsd(spentThisPeriod ?? 0)} | ` +
        `Remaining: ${formatUsd(remainingBudget ?? budget)}`,
      );
    }
  } else {
    // Never print $0.00 for a balance that wasn't read
    const why = needsOwner
      ? 'the live balance needs a claimed wallet'
      : `live balance unavailable: ${errorMessage((balanceResult as PromiseRejectedResult).reason)}`;
    const cached = typeof info.balance === 'number' && Number.isFinite(info.balance) ? info.balance : undefined;
    const cachedAt = text(info.balance_cached_at);
    lines.push(cached !== undefined
      ? `Balance: ${formatUsd(cached)} USDC (last known${cachedAt ? ` at ${cachedAt}` : ''}; ${why})`
      : `Balance: unknown (${why})`);
  }

  lines.push(`Deposit Address: ${info.deposit_address}`);

  if (config.walletName) {
    const hasSeed = seedExists(config.walletName);
    lines.push(
      `Local Key Share: ~/.botwallet/seeds/${config.walletName}.seed (${hasSeed ? 'present' : 'MISSING'})`,
    );
  } else {
    lines.push('Local Key Share: not configured (env-only mode)');
  }

  if (needsOwner) {
    lines.push(...claimLines(info));
  }

  if (bal ? bal.low_balance : info.low_balance) {
    lines.push(`⚠ Low balance — fund via: ${info.funding_url}`);
  }

  return lines.join('\n');
}
