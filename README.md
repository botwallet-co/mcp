<div align="center">

# BotWallet MCP Server

**Give any AI agent a wallet — via Model Context Protocol.**

[![npm](https://img.shields.io/npm/v/@botwallet/mcp?color=blue&label=npm)](https://www.npmjs.com/package/@botwallet/mcp)
[![License](https://img.shields.io/badge/license-Apache%202.0-green)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/botwallet-co/mcp?style=social)](https://github.com/botwallet-co/mcp)

MCP server that gives AI agents the ability to hold, spend, and earn real money (USDC on Solana).
Works with Claude Desktop, Cursor, Windsurf, Cline, and any MCP-compatible client.

[Website](https://botwallet.co) · [Dashboard](https://app.botwallet.co) · [Docs](https://docs.botwallet.co) · [CLI](https://github.com/botwallet-co/agent-cli)

</div>

---

## What can an agent do with BotWallet?

- **Pay** other agents and merchants
- **Earn** money via invoices and payment links
- **Access paid APIs** through the [x402 protocol](https://www.x402.org/)
- **Request funds** from a human owner
- **Withdraw** USDC to any Solana address
- **Manage** multiple wallets with spending guard rails

Every transaction uses **FROST 2-of-2 threshold signing** — the agent holds one key share locally and the server holds the other. The full private key never exists anywhere. Human owners set guard rails (per-transaction limits, daily budgets, merchant allowlists) and approve anything outside the rules.

## Quick Start

### Claude Desktop

Add to your `claude_desktop_config.json`:

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

Config file location:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

### Cursor

Open **Settings → MCP** and add a new server:

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

### Windsurf / Cline / Other MCP Clients

Same configuration — add the `npx` command to your MCP server settings.

### Global Install (alternative)

```bash
npm install -g @botwallet/mcp
```

Then use `botwallet-mcp` as the command instead of `npx -y @botwallet/mcp`.

## First Run

Once connected, ask your agent:

> "Create a BotWallet for yourself"

The agent will run `botwallet_register`, which:
1. Generates a FROST key share locally (saved to `~/.botwallet/seeds/`)
2. Completes distributed key generation with the server
3. Returns an API key, deposit address, and claim link for the human owner

No pre-configuration needed — the agent bootstraps everything.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `BOTWALLET_API_KEY` | API key (alternative to config file) |
| `BOTWALLET_WALLET` | Wallet name to use (alternative to default) |
| `BOTWALLET_BASE_URL` | Custom API URL (default: `https://api.botwallet.co/v1`) |

These are optional. The MCP server reads `~/.botwallet/config.json` (shared with the [CLI](https://github.com/botwallet-co/agent-cli)) and auto-detects configuration.

## Tools (36)

### Wallet Management
| Tool | Description |
|------|-------------|
| `botwallet_ping` | Check API connectivity |
| `botwallet_register` | Create a new wallet (FROST DKG) |
| `botwallet_info` | Wallet metadata and status |
| `botwallet_balance` | Live on-chain balance and budget |
| `botwallet_update_owner` | Set owner email |
| `botwallet_rename` | Update display name |
| `botwallet_wallet_list` | List local wallets |
| `botwallet_wallet_use` | Switch active wallet |

### Payments (Spending)
| Tool | Description |
|------|-------------|
| `botwallet_lookup` | Verify a recipient exists |
| `botwallet_can_i_afford` | Pre-flight check before paying |
| `botwallet_pay` | Pay a merchant or bot (auto-signs if pre-approved) |
| `botwallet_confirm_payment` | Complete an owner-approved payment |
| `botwallet_list_payments` | List outgoing payment intents |
| `botwallet_cancel_payment` | Cancel a pending payment |

### Earning
| Tool | Description |
|------|-------------|
| `botwallet_create_paylink` | Create a payment request / invoice |
| `botwallet_send_paylink` | Send paylink via email or bot inbox |
| `botwallet_get_paylink` | Check paylink status |
| `botwallet_list_paylinks` | List your payment requests |
| `botwallet_cancel_paylink` | Cancel a pending paylink |

### Funding
| Tool | Description |
|------|-------------|
| `botwallet_get_deposit_address` | Get USDC deposit address |
| `botwallet_request_funds` | Ask human owner for funds |
| `botwallet_list_fund_requests` | List fund request history |

### Withdrawals
| Tool | Description |
|------|-------------|
| `botwallet_withdraw` | Withdraw USDC to external address |
| `botwallet_confirm_withdrawal` | Complete an approved withdrawal |
| `botwallet_get_withdrawal` | Check withdrawal status |

### x402 Paid APIs
| Tool | Description |
|------|-------------|
| `botwallet_x402_discover` | Search for paid APIs |
| `botwallet_x402_fetch` | Probe a URL for payment requirements |
| `botwallet_x402_pay_and_fetch` | Pay and fetch content from x402 API |

### History & Guard Rails
| Tool | Description |
|------|-------------|
| `botwallet_transactions` | Full transaction ledger |
| `botwallet_my_limits` | View owner-set spending limits |
| `botwallet_pending_approvals` | List actions awaiting approval |
| `botwallet_approval_status` | Check a specific approval |
| `botwallet_events` | Wallet notifications |

### Wallet Transfer
| Tool | Description |
|------|-------------|
| `botwallet_wallet_export` | Export wallet to encrypted .bwlt file |
| `botwallet_wallet_import` | Import wallet from .bwlt file |
| `botwallet_wallet_backup` | Reveal mnemonic backup phrase |

## Resources

The server also exposes an MCP resource:

| URI | Description |
|-----|-------------|
| `botwallet://status` | Current wallet status summary (balance, budget, seed status) |

## Security

- **FROST 2-of-2 threshold signing** — neither agent nor server can sign alone
- **Local key shares** stored in `~/.botwallet/seeds/` — never transmitted
- **Guard rails** enforced server-side — agents can't bypass spending limits
- **Owner approvals** for transactions above auto-approve thresholds
- **No full private key** exists anywhere — ever

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
                                     (seeds, config)   (Supabase Edge Fn)
                                                              │
                                                        ┌─────┴─────┐
                                                        │  Solana   │
                                                        │ (mainnet) │
                                                        └───────────┘
```

The MCP server runs **locally** on the agent's machine. It reads key shares from `~/.botwallet/seeds/`, communicates with the BotWallet API for FROST co-signing, and submits transactions to Solana.

## CLI Interop

The MCP server shares configuration with the [BotWallet CLI](https://github.com/botwallet-co/agent-cli):

- **Same config**: `~/.botwallet/config.json`
- **Same seeds**: `~/.botwallet/seeds/*.seed`
- **Same .bwlt format**: Export from CLI, import via MCP (and vice versa)

Wallets created by either tool are usable by both.

## Development

```bash
# Clone
git clone https://github.com/botwallet-co/mcp.git
cd mcp

# Install
npm install

# Build
npm run build

# Test
npm test

# Inspect with MCP Inspector
npm run inspect
```

## License

[Apache 2.0](LICENSE)
