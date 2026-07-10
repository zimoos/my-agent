# MA Alpha Launch Playbook

## Positioning

MA is a local-first coding agent for developers who want a terminal tool that feels fast, configurable, and under their control.

Core line:

> A multi-model terminal coding agent that is pleasant to configure, safe with API keys, and useful inside real local projects.

Do not market it as a clone of another TUI. The wedge is better:

- Model freedom: LM Studio local models plus DeepSeek today, more OpenAI-compatible providers next.
- Better setup: `ma init` is interactive, model-aware, and stores remote keys in Keychain.
- Better daily UX: `/model`, slash command completion, session switching, revert, skills.
- Local engineering focus: built-in exec/fs/fs-edit/grep/web MCP tools and AGENT.md project instructions.
- Local benchmark proof: Qwen3-30B through LM Studio passes MA's alpha L0-L2 benchmark at 100% / 98.7% / 95.3%.

## Comparison Angle

Use comparison without defamation:

- "If you tried DeepSeek terminal agents and bounced off setup friction, try MA."
- "Built for people who switch between local models and paid APIs."
- "Keyboard-first, model-switchable, local-first."

Avoid:

- "X is trash."
- Fake benchmark claims.
- Security claims we cannot prove.

## Release Name

`v0.1.2-alpha`

Tagline:

> MA: a local-first multi-model coding agent for your terminal.

## Launch Checklist

- [ ] Clean git status into one release branch.
- [ ] Confirm `npm test` passes.
- [ ] Confirm `npm run build` passes.
- [ ] Confirm `node scripts/package-portable.mjs --out release` creates a runnable bundle.
- [ ] Smoke test bundle:
  - `./ma version`
  - `./ma init`
  - `./ma profiles`
  - `./ma`
- [ ] Record a 30-60 second terminal demo GIF:
  - `ma init`
  - `/model`
  - slash completion
  - ask it to inspect a project
  - show file edit / diff
- [ ] Include benchmark claim with caveat:
  - `Qwen3-30B local via LM Studio: L0 100%, L1 98.7%, L2 95.3% on MA alpha benchmark`
  - Link to `docs/benchmark-results.md`
- [ ] Create GitHub repo description:
  - `Local-first multi-model terminal coding agent. LM Studio + DeepSeek, Keychain secrets, MCP tools, sessions, skills.`
- [ ] Tag release:
- `git tag v0.1.2-alpha`
- `git push origin v0.1.2-alpha`

## Launch Copy

Short:

> I built MA, a local-first terminal coding agent. It works with LM Studio and DeepSeek, stores API keys in macOS Keychain, has `/model` switching, slash command completion, sessions, skills, and built-in MCP tools for real project work.

Long:

> Most terminal AI tools look powerful in a README but feel rough once you actually configure models, switch providers, or work in a local repo. MA is my attempt to make that loop feel good: interactive `ma init`, DeepSeek + LM Studio profiles, secure key storage, `/model` switching, slash-command completion, session switching, revert, skills, and built-in file/shell/search/web tools.
>
> This is `v0.1.2-alpha`: sharp enough to dogfood, honest about rough edges, and shipping with portable binaries so you can try it without a Node setup. On MA's internal alpha benchmark, local Qwen3-30B through LM Studio passes L0-L2 with 100% / 98.7% / 95.3%.

## First Posts

GitHub release title:

> MA v0.1.0-alpha: local-first multi-model terminal coding agent

X / Twitter:

> I was frustrated by terminal coding agents that look good but feel bad in daily use, so I built MA.
>
> - LM Studio local models + DeepSeek
> - interactive `ma init`
> - `/model` switcher
> - slash command completion
> - API keys in macOS Keychain
> - MCP tools: shell, files, grep, web
> - local Qwen3-30B benchmark: 100% / 98.7% / 95.3% on L0-L2
>
> Alpha binaries are up.

Hacker News title:

> Show HN: MA, a local-first multi-model coding agent for the terminal

Reddit title:

> I built a local-first terminal coding agent with LM Studio + DeepSeek support

## Issue Labels

- `bug`
- `provider`
- `model-compat`
- `ux`
- `security`
- `install`
- `good-first-issue`

## Next Provider Targets

1. Qwen official
2. GLM
3. Kimi
4. MiniMax
5. OpenRouter
