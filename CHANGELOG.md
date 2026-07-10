# Changelog

All notable MA changes are documented here. MA is an alpha product; versions may change behavior while the core terminal-agent workflow is being hardened.

## Unreleased

### Added

- Agora provider runtime over MCP stdio, including provider-owned process lifecycle and real loading/generation progress in the TUI.
- Verified Agora MemoryPatch operations for mount, disable, internalization, rollback, and status. Memory state is sourced from Agora response metadata.
- Structured evidence from file read/edit and command tools, including pagination, hashes, diffs, managed-process state, and readiness checks.
- A completion-obligation gate: when a user explicitly requests tests or browser verification, MA cannot report delivery until it has real successful evidence.
- Real scenario benchmark coverage from simple tasks through a browser-verified open-world game delivery flow.

### Changed

- Provider requests now apply explicit serialized-byte budgets, preserve tool-call/result pairs, and summarize historical image payloads safely to prevent oversized requests.
- Long-running local services are managed as background processes with readiness and shutdown handling instead of relying on short foreground tool timeouts.
- Browser-dependent tasks use runner-owned Playwright interaction and observable game/UI state, not HTTP reachability alone.

### Fixed

- DeepSeek request-body limits now remain enforced even when a model capability is pre-populated from the registry.
- Large benchmark workspaces no longer send `node_modules` into the judge context.
- The judge receives bounded, auditable workspace diffs rather than an unbounded project dump.

## v0.1.2-alpha - 2026-05-22

- Improved terminal startup reliability and website previews.
- Shipped portable macOS arm64, Linux x64, and Windows x64 bundles with checksums.

See the [v0.1.2-alpha release](https://github.com/zimoos/my-agent/releases/tag/v0.1.2-alpha) for the complete release notes.
