<div align="center">

# BotWallet MCP Server

**Let your AI agent pay for APIs, send invoices, and manage money — you set the rules.**

[![npm](https://img.shields.io/npm/v/@botwallet/mcp?color=blue&label=npm)](https://www.npmjs.com/package/@botwallet/mcp)
[![License](https://img.shields.io/badge/license-Apache%202.0-green)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/botwallet-co/mcp?style=social)](https://github.com/botwallet-co/mcp)

Give your AI agent financial autonomy without giving up control. Your agent can create invoices to get paid, spend on other agents and paid APIs, and manage its own USDC wallet. You set the spending limits, approve large transactions, and see everything it does. Works with Claude Desktop, Cursor, Windsurf, Cline, and any MCP-compatible client.

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

Then tell your agent: *"Create a BotWallet for yourself."*

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

- **S1** — the agent's share, stored locally at `~/.botwallet/seeds/`
- **S2** — the server's share, held by BotWallet

The full private key never exists. Every transaction requires both parties to co-sign. Neither the agent nor BotWallet can move funds alone. Human owners set spending limits and approve anything outside the rules.

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
| `BOTWALLET_API_KEY` | — | API key (alternative to config file) |
| `BOTWALLET_WALLET` | — | Which wallet to use (if you have several) |
| `BOTWALLET_BASE_URL` | `https://api.botwallet.co/v1` | Custom API endpoint |

All optional. The server reads `~/.botwallet/config.json` (shared with the [CLI](https://github.com/botwallet-co/agent-cli)) and figures out the rest.

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
| `botwallet_wallet_export` | Export wallet to an encrypted .bwlt file |
| `botwallet_wallet_import` | Import wallet from a .bwlt file |
| `botwallet_wallet_backup` | Reveal the mnemonic backup phrase |

## Resources

| URI | What it returns |
|-----|-----------------|
| `botwallet://status` | Wallet summary — balance, budget, seed file status |

## Architecture

```
┌─────────────────┐     stdio (JSON-RPC)     ┌──────────────────┐
│   AI Client     │◄────────────────────────►│  BotWallet MCP   │
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

The server runs locally on the agent's machine. Key shares stay in `~/.botwallet/seeds/` and are never sent over the network. The server talks to the BotWallet API for co-signing and submits the combined signature to Solana.

## Security

The agent can't bypass spending limits. Those are enforced server-side. Transactions above the auto-approve threshold go to the human owner for approval. Key shares are stored locally and never leave the machine. There is no full private key anywhere in the system.

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## CLI interop

This MCP server and the [BotWallet CLI](https://github.com/botwallet-co/agent-cli) share the same local files:

- Config: `~/.botwallet/config.json`
- Seeds: `~/.botwallet/seeds/*.seed`
- Export format: `.bwlt` (encrypted, works both directions)

A wallet created with the CLI works in the MCP server, and vice versa.

## Development

```bash
git clone https://github.com/botwallet-co/mcp.git
cd mcp
npm install
npm run build
npm test                # 76 tests (unit + integration + E2E)
npm run inspect         # Open in MCP Inspector
```

## License

[Apache 2.0](LICENSE)
