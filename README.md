<div align="center">

# Botwallet MCP Server

**Let your AI agent send invoices to earn, pay for APIs and manage money, while you stay in control.**

[![npm](https://img.shields.io/npm/v/@botwallet/mcp?color=blue&label=npm)](https://www.npmjs.com/package/@botwallet/mcp)
[![License](https://img.shields.io/badge/license-Apache%202.0-green)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/botwallet-co/mcp?style=social)](https://github.com/botwallet-co/mcp)

Give your AI agent financial autonomy without giving up control. Your agent can create invoices to get paid, spend on other agents and paid APIs, and manage its own USDC wallet. You set the spending limits, approve large transactions, and see everything it does. Works with Claude Desktop, Claude Code, Cursor, Windsurf, Cline, and any MCP-compatible client.

[Website](https://botwallet.co) · [Dashboard](https://app.botwallet.co) · [Docs](https://docs.botwallet.co) · [CLI](https://github.com/botwallet-co/agent-cli) · [npm](https://www.npmjs.com/package/@botwallet/mcp)

</div>

---

Add one JSON block to your MCP client config. That's it.

```json
{
  "mcpServers": {
    "botwallet": {
      "command": "npx",
      "args": ["-y", "@botwallet/mcp"]
    }
  }
}
```

Then tell your agent: *"Create a Botwallet for yourself."*

It runs `botwallet_register`, generates a cryptographic key share locally, and comes back with a deposit address. No setup, no API keys to configure beforehand.

From there:

> "Send $5 to @acme-bot for the data report"

If the amount is within guard rails, the agent signs and submits. If not, it asks the human owner for approval.

> "Create an invoice for $25 for the consulting session"

The agent creates a paylink. When someone pays it, the USDC goes straight to the wallet.

> "Find a speech-to-text API and use it"

The agent searches the x402 catalog, finds a paid API, pays for access, and returns the result.

## How signing works

Every wallet uses FROST 2-of-2 threshold signatures. During wallet creation, a key generation ceremony produces two shares:

- **Key 1** — the agent's share, stored locally at `~/.botwallet/seeds/`
- **Key 2** — the server's share, held by Botwallet

The full private key never exists. Every transaction requires both parties to co-sign. Neither the agent nor Botwallet can move funds alone. Human owners set spending limits and approve anything outside the rules.

Botwallet prepares each transaction; before Key 1 co-signs it, this server decodes it and refuses to sign unless it moves only USDC out of the wallet: the agreed amount into the recipient's associated (standard) USDC account, plus at most the quoted fee (up to a cent more for paid APIs, whose fee is quoted in whole cents), and nothing else. The recipient is checked against the address the agent gave for withdrawals, paid APIs and payments to a Solana address. For payments to a username the address comes from Botwallet's lookup, so only the amount and fee are checked against the agent's request. The [Agent CLI](https://github.com/botwallet-co/agent-cli) and the signing page apply the same rules.

The agent's own amount, recipient and fee are kept in memory, so they are used only while the MCP server process that started the transfer is still running. After a restart, which is common when an owner approves hours later, Key 1 checks the transaction against the amount, recipient and fee Botwallet recorded, and never signs a fee above a fixed ceiling.

If a payment call times out or loses its connection, the result says whether money may have moved. `OUTCOME_UNKNOWN` means check the tool named in its `check_tool` (usually `botwallet_list_payments` or `botwallet_get_withdrawal`, or `botwallet_balance` when Botwallet lists the transfer as failed but it may still have gone through) before paying again; to retry the same payment, pass back its `idempotency_key`.

## Pending, frozen and repeated payments

**Sent, not confirmed yet.** Botwallet waits for Solana to confirm a payment or withdrawal. If the network has not confirmed it in time, the tool returns a normal result, not an error, with `status: "pending"`, `sent: true`, the Solana signature, an explorer link and `check_tool`. It may still go through, so the agent must not pay again: in about a minute, the tool in `check_tool` shows `completed` or `failed`.

**Frozen wallet.** The owner can freeze the wallet in the Botwallet dashboard. A frozen wallet can still receive money but can't send any: new payments, withdrawals and paid API calls are blocked, and a confirm stops with `WALLET_SUSPENDED` before anything is signed or sent. A transfer approved before the freeze is kept: once the owner unfreezes the wallet, the agent finishes it with the same confirm tool and `transaction_id` (for a paid API, `botwallet_x402_pay_and_fetch` with the same `fetch_id`).

**Retrying a request.** `botwallet_pay` and `botwallet_withdraw` return an `idempotency_key`. Calling the tool again with that key returns what became of the first request instead of making a second one. Without one, a new key is made, so the call is a new payment. A key already used for another kind of request, or for one that is still being created, returns `IDEMPOTENCY_KEY_CONFLICT`.

## Installation

### Claude Desktop

Add to your Claude Desktop config file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "botwallet": {
      "command": "npx",
      "args": ["-y", "@botwallet/mcp"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add botwallet -- npx -y @botwallet/mcp
```

This adds it to the current project. To use it in every project, add `--scope user`:

```bash
claude mcp add --scope user botwallet -- npx -y @botwallet/mcp
```

On native Windows (not WSL), `npx` needs a `cmd /c` wrapper: `claude mcp add botwallet -- cmd /c npx -y @botwallet/mcp`.

### Cursor

Go to **Settings > MCP**, click **Add new MCP server**, and add:

```json
{
  "mcpServers": {
    "botwallet": {
      "command": "npx",
      "args": ["-y", "@botwallet/mcp"]
    }
  }
}
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "botwallet": {
      "command": "npx",
      "args": ["-y", "@botwallet/mcp"]
    }
  }
}
```

### Cline

Open the Cline sidebar, click **MCP Servers**, then **Configure**, and add:

```json
{
  "mcpServers": {
    "botwallet": {
      "command": "npx",
      "args": ["-y", "@botwallet/mcp"]
    }
  }
}
```

### Other MCP clients

The config is the same everywhere — `npx -y @botwallet/mcp` as the command.

### Global install (alternative)

```bash
npm install -g @botwallet/mcp
```

If you install globally, use `botwallet-mcp` as the command instead of `npx -y @botwallet/mcp`.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `BOTWALLET_API_KEY` | — | API key (`BW_API_KEY` also works, as in the CLI). When set, it decides the wallet. On its own it is enough for read-only use; payments, withdrawals and paid API calls also need that wallet's key share (Key 1) in `~/.botwallet/seeds/<wallet>.seed`. Signing uses the wallet in `config.json` that has this key; if it isn't in `config.json`, set `BOTWALLET_WALLET` to the seed file's name |
| `BOTWALLET_WALLET` | — | Which wallet to use (if you have several). The server won't start if no wallet has this name. MCP only: the CLI uses `--wallet` |
| `BOTWALLET_API_URL` | `https://api.botwallet.co/v1` | API endpoint, the same variable the CLI reads. `BOTWALLET_BASE_URL`, used by older versions, still works. When neither is set, `base_url` in `~/.botwallet/config.json` is used, as in the CLI |

All optional. The server reads `~/.botwallet/config.json` (shared with the [CLI](https://github.com/botwallet-co/agent-cli)) and figures out the rest. Without these variables it uses the default wallet; registering or importing a wallet makes it the default.

## Tools

36 tools across 8 groups.

### Wallet management
| Tool | What it does |
|------|-------------|
| `botwallet_ping` | Check API connectivity |
| `botwallet_register` | Create a new wallet (FROST key generation) |
| `botwallet_info` | Wallet metadata and status |
| `botwallet_balance` | On-chain balance and remaining budget |
| `botwallet_update_owner` | Set owner email |
| `botwallet_rename` | Change display name |
| `botwallet_wallet_list` | List local wallets |
| `botwallet_wallet_use` | Switch active wallet |

### Payments
| Tool | What it does |
|------|-------------|
| `botwallet_lookup` | Check if a recipient exists |
| `botwallet_can_i_afford` | Pre-flight check before paying |
| `botwallet_pay` | Pay someone (auto-signs if within limits) |
| `botwallet_confirm_payment` | Complete a payment after owner approval |
| `botwallet_list_payments` | List outgoing payments |
| `botwallet_cancel_payment` | Cancel a pending payment |

### Earning
| Tool | What it does |
|------|-------------|
| `botwallet_create_paylink` | Create a payment request or invoice |
| `botwallet_send_paylink` | Send a paylink via email or bot inbox |
| `botwallet_get_paylink` | Check paylink status |
| `botwallet_list_paylinks` | List your paylinks |
| `botwallet_cancel_paylink` | Cancel a pending paylink |

### Funding
| Tool | What it does |
|------|-------------|
| `botwallet_get_deposit_address` | Get the USDC deposit address |
| `botwallet_request_funds` | Ask the human owner for funds |
| `botwallet_list_fund_requests` | List past fund requests |

### Withdrawals
| Tool | What it does |
|------|-------------|
| `botwallet_withdraw` | Withdraw USDC to an external Solana address |
| `botwallet_confirm_withdrawal` | Complete a withdrawal after approval |
| `botwallet_get_withdrawal` | Check withdrawal status |

### x402 paid APIs
| Tool | What it does |
|------|-------------|
| `botwallet_x402_discover` | Search for paid APIs |
| `botwallet_x402_fetch` | Probe a URL for payment requirements |
| `botwallet_x402_pay_and_fetch` | Pay and retrieve content from an x402 API |

### History and guard rails
| Tool | What it does |
|------|-------------|
| `botwallet_transactions` | Full transaction ledger |
| `botwallet_my_limits` | View spending limits set by the owner |
| `botwallet_pending_approvals` | List actions waiting for approval |
| `botwallet_approval_status` | Check a specific approval |
| `botwallet_events` | Wallet notifications |

### Wallet transfer
| Tool | What it does |
|------|-------------|
| `botwallet_wallet_export` | Export wallet to an encrypted .bwlt file (importable for 24 hours, 5 times at most) |
| `botwallet_wallet_import` | Import wallet from a .bwlt file under a new local name |
| `botwallet_wallet_backup` | Reveal Key 1 (12 words) for the owner's backup, in two calls with a one-time code |

## Resources

| URI | What it returns |
|-----|-----------------|
| `botwallet://status` | Wallet summary — balance, budget, seed file status, and the claim link while no owner has claimed the wallet |

## Architecture

```
┌─────────────────┐     stdio (JSON-RPC)     ┌──────────────────┐
│   AI Client     │◄────────────────────────►│  Botwallet MCP   │
│ (Claude/Cursor) │                          │     Server       │
└─────────────────┘                          └────────┬─────────┘
                                                      │
                                              ┌───────┴───────┐
                                              │               │
                                     ~/.botwallet/     api.botwallet.co
                                     (seeds, config)        (API)
                                                              │
                                                        ┌─────┴─────┐
                                                        │  Solana   │
                                                        │ (mainnet) │
                                                        └───────────┘
```

The server runs locally on the agent's machine. Key shares are stored in `~/.botwallet/seeds/` and are never sent to Botwallet. The server talks to the Botwallet API for co-signing and submits the combined signature to Solana.

## Security

The agent can't bypass spending limits. Those are enforced server-side. Transactions above the auto-approve threshold go to the human owner for approval. There is no full private key anywhere in the system.

Every tool carries MCP tool annotations. Balance, history and lookups are marked read-only, so clients that support annotations can run them without asking. Tools that move money (`botwallet_pay`, `botwallet_withdraw`, the confirm tools, `botwallet_x402_pay_and_fetch`), touch Key 1 (`botwallet_wallet_backup`, `botwallet_wallet_export`, `botwallet_wallet_import`) or change the owner are marked destructive, so clients can keep asking before those. Allowing the read-only tools is safer than "always allow" for the whole server.

Key 1 (the agent's key share) is stored only on the agent's machine and is never sent to Botwallet. Registering saves the API key to `~/.botwallet/config.json` without showing it. Two things do reveal key material, so use them only when the owner asks:

- `botwallet_wallet_backup` shows Key 1 (12 words) to the agent so it can pass them to the owner, who needs them to withdraw and to recover the wallet. The words then sit in the AI conversation, so treat that conversation as sensitive. As in the CLI, it takes two calls: the first returns a one-time code, valid for 30 seconds, and the second, with that code, reveals the words. This guards against revealing Key 1 by accident; it does not stop an agent that is set on revealing it.
- `botwallet_wallet_export` writes a `.bwlt` file with Key 1 and the API key. Anyone holding the file can import the wallet within 24 hours.

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## CLI interop

This MCP server and the [Botwallet CLI](https://github.com/botwallet-co/agent-cli) share the same local files:

- Config: `~/.botwallet/config.json`
- Seeds: `~/.botwallet/seeds/*.seed`
- Export format: `.bwlt` (encrypted, works both directions; holds Key 1 and the API key, so keep it private)

A wallet created with the CLI works in the MCP server, and vice versa.

## Development

```bash
git clone https://github.com/botwallet-co/mcp.git
cd mcp
npm install
npm run build
npm test                # unit + integration tests, offline
npm run test:e2e        # E2E tests against the live API (no payments)
npm run inspect         # Open in MCP Inspector
```

## License

[Apache 2.0](LICENSE)
