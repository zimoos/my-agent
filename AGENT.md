# Agent Instructions

## MA Next runtime and dependencies

- The MA Next execution runtime is Node 22.23.2; `.node-version` pins development and acceptance. The package minimum is Node 22.19.0, as required by the pinned Pi SDK. Do not substitute Bun or another Node version for runtime acceptance.
- Keep `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` at 0.86.1, `@modelcontextprotocol/sdk` at 1.30.0, and `typebox` at 1.3.27. Preserve exact direct versions and review the lockfile for unintended changes to existing dependencies.
- Dependency setup for the current `$dev` work uses the verified Node executable to run npm with `--ignore-scripts --no-audit --no-fund`; include optional platform packages. Do not run prepare/postinstall, read user model profiles or benchmark credentials, or invoke a model as part of dependency checks.
- Verify package integrity and real Node ESM imports separately from SDK behavior. Import success is not a conversation, tool execution or product acceptance result. Independent QA owns tests and fixtures; feature developers must not edit them.
- Pi 0.86.1 publishes five nested dependencies without shrinkwrap integrity. Their approved SHA-512 values live in the root lockfile; npm can discard these values in its internal install tree. After controlled installation and before building or packaging, run `npm run verify:pi-dependencies`. The build command enforces this gate before TypeScript compilation.
- `scripts/verify-pi-dependencies.mjs` compares all five installed packages with approved official archives. It accepts `--root`, `--archive-dir`, and `--offline`; archive cache filenames are the approved SHA-512 hexadecimal digest plus `.tgz`. Every cached archive is rehashed. An offline build must supply the verified archive cache; do not refresh missing approval values from registry metadata or ignore a failed comparison.
- This is an installation/build/distribution gate only. Do not invoke archive verification, network freshness checks, or expiration checks during normal MA startup or conversations. It does not change prices, balances, or service readiness. Changes to the verifier remain separate from QA-owned tests.
- The verifier excludes only npm-managed dependencies at the verified package root that the root lock explicitly registers. It rejects unregistered root dependencies, links and extra files; deeper paths such as `dist/node_modules` remain part of the exact package-file comparison.
- Run MA Next acceptance with the fixed Node 22.23.2 on PATH: first `npm run verify:pi-dependencies -- --archive-dir /path/to/archive-cache` to populate the SHA-512 hex-named cache, then `MA_PI_APPROVED_ARCHIVE_DIR=/path/to/archive-cache npm run test:ma-next`. This command includes runtime, real Pi contract and dependency-integrity tests owned by QA. The archive cache has no age or expiry policy; cached bytes are checked against the approved lock digest.

## Benchmark Work

- Do not call a benchmark authoritative from dry-run, unit tests, or mocked adapters alone.
- For benchmark changes, run at least:
  - `npx tsx test/benchmark/runner/index.ts --dry-run`
  - `npx tsx --test test/benchmark/runner/__tests__/*.test.ts`
  - `npm run build`
- For L3 claims, use a real CLI adapter plus a real judge:
  - `npm run benchmark -- --level L3 --task <task-id> --adapter test/benchmark/adapters/<adapter>.yaml --runs 1`
- Judge defaults are read from `~/.my-agent/benchmark.env`:
  - `MA_BENCH_JUDGE_KEY`
  - `MA_BENCH_JUDGE_BASE_URL`
  - `MA_BENCH_JUDGE_MODEL`
  - `MA_BENCH_MA_CONFIG` for the tested MA CLI config used by `test/benchmark/adapters/ma.yaml`
  - CLI flags still override these defaults when explicitly passed.
  - With DeepSeek, `flash` and `pro` are accepted aliases for the API model names.
- Do not mock the tested agent, do not mock the judge, and do not treat `echo-mock.yaml` as evidence of agent quality.
- Do not modify task tests to pass a benchmark task. L3 tasks must include objective checks that protect test files or other forbidden files.
- Preserve `summary.md`, per-task reports, and `l3-details.json` when reporting a real L3 run.
- New benchmark tasks should use real fixture code with an initial failing state, objective checks, and clear rubric points.

See `test/benchmark/README.md` for benchmark-specific commands and evidence requirements.

## Real E2E Work

- `npm test` only proves unit-level behavior.
- `npm run e2e` and `npm run e2e:real` run real CLI smoke through the built dist CLI; run `npm run build` first.
- `ma run` smoke proves provider/main-loop/tool plumbing, not TUI behavior.
- TUI PTY smoke proves startup/input/progress/completion/quit only; it is not a task-quality benchmark.
- ZimoOS MCP e2e is real only when the local mteam backend is reachable. If it is skipped, say it was skipped; do not replace it with a mock OSFrame.
- Report failures by layer: harness, provider, tool routing, context slot, TUI, ZimoOS backend, or task quality.
