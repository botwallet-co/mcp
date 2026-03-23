# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| Latest release | Yes |
| Older versions | No — please upgrade |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

If you discover a security vulnerability in the BotWallet MCP server, please report it responsibly:

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

This policy covers the BotWallet MCP server (`@botwallet/mcp`) and its npm package.

Vulnerabilities in the following are in scope:
- FROST threshold signing implementation
- Local credential storage and key management (`~/.botwallet/`)
- Wallet export/import encryption (`.bwlt` files)
- API communication and request handling
- Key material handling in memory
- x402 payment flow and private network validation

Out of scope:
- The BotWallet backend API (report separately to security@botwallet.co)
- Third-party dependencies (report upstream, but let us know)
- Social engineering attacks
- MCP client vulnerabilities (Claude Desktop, Cursor, etc.)

## Security Design

- **FROST 2-of-2 threshold signing** — neither the MCP server nor the BotWallet API can sign transactions alone. Both key shares are required.
- **Local key shares** — mnemonics are stored in `~/.botwallet/seeds/` with 0600 permissions and never transmitted to the server.
- **Encrypted wallet export** — `.bwlt` files use AES-256-GCM. The decryption key is held server-side and retrieved only during import.
- **No telemetry** — the MCP server does not phone home or collect usage data.
- **Minimal network access** — only communicates with `api.botwallet.co` (configurable) and user-specified x402 URLs.
- **Private network blocking** — x402 tool blocks requests to localhost, private IPs, and link-local addresses.
- **Guard rails enforced server-side** — spending limits, approval thresholds, and recipient restrictions cannot be bypassed by the agent.
