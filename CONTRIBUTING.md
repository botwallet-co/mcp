# Contributing to BotWallet MCP Server

Thank you for your interest in contributing! This guide will help you get started.

## Development Setup

### Prerequisites

- Node.js 18 or later
- npm or pnpm

### Building

```bash
git clone https://github.com/botwallet-co/mcp.git
cd mcp
npm install
npm run build
```

### Running Tests

```bash
# Unit and integration tests (no API key needed)
npm test

# Full E2E tests against live API (requires API key)
BOTWALLET_E2E_API_KEY=bw_bot_... npm test
```

### Inspecting with MCP Inspector

```bash
npm run inspect
```

## Making Changes

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-change`)
3. Make your changes
4. Run `npm test` and `npm run typecheck`
5. Commit with a clear message
6. Open a Pull Request

## Commit Messages

Use conventional commit style:

- `feat: add new tool` — new features
- `fix: handle edge case in pay flow` — bug fixes
- `docs: update README examples` — documentation
- `refactor: simplify config loading` — code improvements
- `test: add frost signing tests` — test additions

## Code Style

- TypeScript strict mode
- Use Zod for all tool input schemas
- Tool handlers must always return `formatResult()` or `formatToolError()` — never raw values
- Error messages should be actionable — tell the agent what to do, not just what went wrong
- Tool descriptions should include when-to-use guidance and cross-reference related tools

## Architecture

```
src/
├── config/        Local wallet config and key storage (~/.botwallet/)
├── frost/         FROST threshold signing (Ed25519, ported from Go CLI)
├── resources/     MCP resources (wallet status)
├── tools/         MCP tool definitions (one file per domain)
├── utils/         Shared utilities (formatting, errors, x402)
├── server.ts      MCP server factory
├── index.ts       CLI entry point (stdio transport)
└── types.ts       Shared types

tests/
├── unit/          Pure unit tests (no network)
├── integration/   In-memory MCP server tests
└── e2e/           Live API tests (require BOTWALLET_E2E_API_KEY)
```

## Adding a New Tool

1. Add the tool definition in the appropriate file under `src/tools/`
2. Follow the `ToolDefinition` interface: `name`, `description`, `inputSchema`, `handler`
3. Export it from `src/tools/index.ts`
4. Add tests
5. Update README.md tool table

## Reporting Issues

- Use [GitHub Issues](https://github.com/botwallet-co/mcp/issues)
- Include your Node.js version, MCP client (Claude/Cursor/etc.), and OS
- For bugs, include the tool name and the error message

## License

By contributing, you agree that your contributions will be licensed under the Apache 2.0 License.
