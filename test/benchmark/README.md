# Benchmark Guide

This benchmark is a regression and capability gate for coding agents. It is not authoritative until a real agent CLI and a real independent judge have both run.

## Levels

- L0-L2: in-process MA benchmark for connectivity, stable tools, multi-turn behavior, context pressure, and optional vision.
- L3: universal CLI-agent benchmark. The runner creates a temporary git workspace, runs a real adapter, collects git diff, executes objective checks, then sends the result to an independent judge model.

## Required Commands

Judge defaults are loaded from `~/.my-agent/benchmark.env` when present:

```bash
MA_BENCH_JUDGE_KEY=...
MA_BENCH_JUDGE_BASE_URL=https://api.deepseek.com
MA_BENCH_JUDGE_MODEL=deepseek-v4-flash
MA_BENCH_MA_CONFIG=/Users/zhuqingyu/.my-agent/benchmark-ma-config.json
```

Command-line flags such as `--judge-key`, `--judge-base-url`, and `--judge-model` override those defaults. For DeepSeek, the runner also accepts `flash`/`pro` as aliases for `deepseek-v4-flash`/`deepseek-v4-pro`.

Validate task definitions and runner tests:

```bash
npx tsx test/benchmark/runner/index.ts --dry-run
npx tsx --test test/benchmark/runner/__tests__/*.test.ts
npm run build
```

Run one real L3 task:

```bash
npm run benchmark -- --level L3 --task L3-009 --adapter test/benchmark/adapters/ma.yaml --runs 1
```

Use another adapter when needed:

```bash
npm run benchmark -- --level L3 --task L3-009 --adapter test/benchmark/adapters/codex.yaml --runs 1
npm run benchmark -- --level L3 --task L3-009 --adapter test/benchmark/adapters/claude-code.yaml --runs 1
```

## Evidence Rules

- Dry-run only proves YAML/schema validity.
- Unit tests only prove the runner implementation.
- `echo-mock.yaml` only proves adapter plumbing.
- A real L3 claim requires `summary.md`, per-task reports, and `l3-details.json` under `test/benchmark/reports/<run-id>/`.
- Report the tested adapter, underlying model, judge model, task IDs, objective check failures, and judge reasoning.

## Task Authoring Rules

- Use real fixture code under `test/benchmark/fixtures/`.
- The fixture should start in a failing or incomplete state.
- Include objective checks such as `npm test`, direct behavior checks, and no-modify checks for tests or forbidden files.
- Do not rely only on judge text for correctness when a deterministic check is possible.
- Keep benchmark prompts realistic: implement a feature, fix a bug, diagnose logs, refactor safely, or preserve context across turns.
