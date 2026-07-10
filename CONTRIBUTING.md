# Contributing to MA

Thanks for helping improve MA. The project is an alpha terminal coding agent, so reproducible reports and small, well-tested changes are especially valuable.

## Before you start

1. Search existing issues and discussions before opening a new one.
2. For bugs, include the provider, model id, MA version, operating system, a minimal prompt or command, expected behavior, and actual behavior. Never include API keys or private workspace contents.
3. Discuss large product, provider, or runtime changes in a GitHub Discussion or issue before writing a large pull request.

## Development workflow

```bash
npm install
npm test
npm run build
```

Keep pull requests focused. Add or update tests for behavioral changes, and explain any provider-specific verification you ran. Do not commit generated release bundles, API credentials, sessions, model weights, or local runtime data.

## Pull requests

- Use a clear title that describes the user-visible change.
- Explain the problem, the solution, and validation in the pull request body.
- Preserve behavior for providers you did not change.
- Follow the repository's [Code of Conduct](CODE_OF_CONDUCT.md).

By contributing, you agree that your contribution is licensed under the repository's license.
