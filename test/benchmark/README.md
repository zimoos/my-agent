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
- `ma run` smoke only proves provider/main-loop/tool plumbing.
- TUI PTY smoke only proves interactive startup/input/progress/completion/quit.
- ZimoOS MCP e2e only counts when it reaches the real local mteam backend; an unavailable backend must be reported as skipped, not mocked.
- A real L3 claim requires `summary.md`, per-task reports, and `l3-details.json` under `test/benchmark/reports/<run-id>/`.
- Report the tested adapter, underlying model, judge model, task IDs, objective check failures, and judge reasoning.
- Report real-user failures by layer: harness, provider, tool routing, context slot, TUI, ZimoOS backend, or task quality.

## Real Scenario E2E Rules

When validating user-facing agent quality, use prompt-driven real scenarios rather
than only unit scripts. A real scenario task is one user prompt that asks the
agent to deliver a product result end to end: inspect the workspace, design docs,
implementation when needed, validation, and final handoff.

Required ladder:

- Start with a small real case that is easy to pass but still requires the LLM to
  decide what to inspect and what to write.
- Add medium and hard cases that require real implementation plus docs and tests.
- Include at least one extreme case that is harder than the latest reported
  user failure. For the Agora timeout/regression case, the reference extreme task
  is `L3-015-real-extreme-open-world-game.yaml`.

Execution rules:

- The agent under test must be a real CLI adapter, not a mocked in-process model.
- A judge model or human reviewer acts as the judge after the run and evaluates
  the final answer, workspace diff, and objective check results.
- Demo workspaces must be temporary and cleaned up after the run. If a live test
  intentionally creates an external demo resource, such as a GitHub repository,
  the test owner must delete that resource after scoring.
- Passing `npm test` or dry-run alone is not enough to claim real user readiness.

## Real E2E Commands

Run the built CLI smoke suite:

```bash
npm run build
npm run e2e
npm run e2e:real
```

`npm run e2e:real` uses `MA_E2E_CONFIG`, then `MA_BENCH_MA_CONFIG`, then `~/.my-agent/benchmark.env`, then `~/.my-agent/benchmark-ma-config.json`.

Run the optional ZimoOS integration directly:

```bash
npm run e2e:zimoos
```

Set `MTEAM_HUB_URL` and `MTEAM_BACKEND_DIR` when the mteam backend is not at the local defaults.

## Task Authoring Rules

- Use real fixture code under `test/benchmark/fixtures/`.
- The fixture should start in a failing or incomplete state.
- Include objective checks such as `npm test`, direct behavior checks, and no-modify checks for tests or forbidden files.
- Do not rely only on judge text for correctness when a deterministic check is possible.
- Keep benchmark prompts realistic: implement a feature, fix a bug, diagnose logs, refactor safely, or preserve context across turns.
