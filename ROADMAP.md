# MA Roadmap

MA is building a terminal coding agent that makes local and remote models practical for real work, not just attractive demos. The roadmap is deliberately outcome-based: each area needs reproducible evidence before it becomes a product claim.

## Now: reliable multi-model agent loops

- Make model selection and first-run configuration simple across local and hosted providers.
- Keep long-running work observable: model state, tool progress, context use, failure summaries, and managed development servers.
- Treat tool evidence, provider request size, and browser verification as delivery requirements rather than optional diagnostics.
- Support Agora as a first-class local runtime with verifiable MemoryPatch state.

## Next: community-ready local workflows

- Expand cross-platform release validation and installation smoke tests.
- Publish reproducible scenario benchmarks that separate infrastructure failures, runtime defects, and model-quality limits.
- Improve provider discovery, model profiles, and guided recovery when a local runtime or model is unavailable.
- Turn high-signal real-world failures into focused regression fixtures and `good first issue` opportunities.

## Later: durable personal-agent workflows

- Better project and session continuity without inflating every provider request.
- More first-class provider integrations where the runtime can expose trustworthy state rather than only text output.
- Community-maintained compatibility reports for models, runtimes, tool calling, and long-context behavior.

## How to influence the roadmap

Open a [Discussion](https://github.com/zimoos/my-agent/discussions) for workflow ideas, or use the issue templates for reproducible defects and product requests. The most valuable reports include the provider, model, operating system, a safe minimal reproduction, and the expected result.
