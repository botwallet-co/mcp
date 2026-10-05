# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| Latest release | Yes |
| Older versions | No — please upgrade |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

If you discover a security vulnerability in the Botwallet MCP server, please report it responsibly:

**Email:** security@botwallet.co

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## What to Expect

- **Acknowledgment** within 48 hours
- **Assessment** within 5 business days
- **Fix or mitigation** timeline communicated after assessment
- **Credit** in the release notes (unless you prefer anonymity)

## Scope

This policy covers the Botwallet MCP server (`@botwallet/mcp`) and its npm package.

Vulnerabilities in the following are in scope:
- FROST threshold signing implementation
- Local credential storage and key management (`~/.botwallet/`)
- Wallet export/import encryption (`.bwlt` files)
- API communication and request handling
- Key material handling in memory
- x402 payment flow and private network validation

Out of scope:
- The Botwallet backend API (report separately to security@botwallet.co)
- Third-party dependencies (report upstream, but let us know)
- Social engineering attacks
- MCP client vulnerabilities (Claude Desktop, Cursor, etc.)

## Security Design

- **FROST 2-of-2 threshold signing** — neither the MCP server nor the Botwallet API can sign transactions alone. Both key shares are required.
- **Transaction check before Key 1 signs** — Botwallet builds every transaction. The MCP server decodes it and signs only a USDC transfer out of the wallet: the agreed amount into the recipient's associated (standard) USDC account, plus at most the quoted fee from the same account (up to a cent more for paid APIs, whose fee is quoted in whole cents) and never more than a fixed fee ceiling, and nothing else. The Agent CLI and the signing page apply the same rules. The agent's own amount, recipient and fee are kept in memory only, so they are used only while the MCP server process that started the transfer is still running. After a restart (for example while an owner approval is pending), the amount and recipient come from Botwallet's records, and only the shape of the transaction and the fee ceiling are checked independently.
- **No second payment by mistake** — a payment or withdrawal that was sent but is not confirmed on Solana yet is reported as pending, with its Solana signature and the tool that shows how it ends, never as a failure. A lost or unclear answer after Key 1 signed is reported as `OUTCOME_UNKNOWN`, with the tool to check first. `botwallet_pay` and `botwallet_withdraw` send an idempotency key, so a retry with the same key returns the first request instead of making a second one.
- **Frozen wallets can't send** — while the owner has frozen the wallet, Botwallet refuses to build or co-sign any payment, withdrawal or paid API call (`WALLET_SUSPENDED`), including ones approved before the freeze.
- **Local key shares** — mnemonics are stored in `~/.botwallet/seeds/` with 0600 permissions and never transmitted to the server. The only tool that returns one is `botwallet_wallet_backup`, which shows Key 1 to the agent so it can pass the words to the owner; that puts them in the AI conversation. Registering saves the API key to `~/.botwallet/config.json` and does not return it.
- **Encrypted wallet export** — `.bwlt` files use AES-256-GCM. The decryption key is held server-side and retrieved only during import.
- **No telemetry** — the MCP server does not phone home or collect usage data.
- **Minimal network access** — only communicates with `api.botwallet.co` (configurable) and user-specified x402 URLs.
- **Private network blocking** — x402 tools block requests to localhost, private, link-local (cloud metadata) and other non-public addresses, including host names that resolve to them and redirects that lead to them.
- **HTTPS-only x402 payments** — a signed x402 payment is sent only over HTTPS, only to the URL that was prepared, and never follows a redirect.
- **Guard rails enforced server-side** — spending limits, approval thresholds, and recipient restrictions cannot be bypassed by the agent.
