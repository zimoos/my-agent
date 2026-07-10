# Agent Instructions

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
