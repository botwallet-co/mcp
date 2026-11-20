# Contributing to Botwallet MCP Server

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
# Unit and integration tests, offline (no API key needed)
npm test

# E2E tests against the live API (no payments); the authenticated part needs an API key
BOTWALLET_E2E_API_KEY=bw_bot_... npm run test:e2e
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
- Define tools with `defineTool` or `apiTool` (`src/tools/define.ts`): results come from `formatResult()` or the error builders, never raw values, and anything a tool throws becomes a structured error
- Error messages should be actionable — tell the agent what to do, not just what went wrong
- A payment, withdrawal or paid API call that fails says whether money may have moved (`src/transfers/results.ts`)
- Tool descriptions should include when-to-use guidance and cross-reference related tools

## Architecture

```
src/
├── config/        Local wallet files (~/.botwallet/): config.json, key shares, .bwlt exports
├── frost/         FROST threshold signing (Ed25519, ported from the Go CLI)
├── resources/     MCP resources (wallet status)
├── sdk/           Client for the Botwallet API, its errors and types
├── solana/        Decoding and checking a transaction before Key 1 signs it
├── tools/         MCP tool definitions (one file per domain)
├── transfers/     Payments and withdrawals: the agreed figures, signing, results
├── x402/          Paid APIs: probing, 402 parsing, the paid request, the catalog
├── utils/         Shared helpers (tool results, errors, schemas, encodings)
├── server.ts      MCP server factory
├── index.ts       CLI entry point (stdio transport)
└── types.ts       Shared types

tests/
├── unit/          Unit tests (no network)
├── integration/   In-memory MCP server tests
├── helpers/       Shared test setup and fakes
└── e2e/           Live API tests (run with npm run test:e2e)
```

## Adding a New Tool

1. Define it with `defineTool` (or `apiTool` for a plain API call) in the matching file under `src/tools/`, with `annotations` from `src/utils/annotations.ts`
2. Add it to that file's list, which `src/tools/index.ts` collects into `ALL_TOOLS`
3. Add tests, and add its name to the list in `tests/integration/server.test.ts`
4. Add a row to the README.md tool table and update the tool count in README.md and `glama.json` (`tests/integration/tool-docs.test.ts` checks both)

## Reporting Issues

- Use [GitHub Issues](https://github.com/botwallet-co/mcp/issues)
- Include your Node.js version, MCP client (Claude/Cursor/etc.), and OS
- For bugs, include the tool name and the error message

## License

By contributing, you agree that your contributions will be licensed under the Apache 2.0 License.
