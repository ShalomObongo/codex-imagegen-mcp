# Contributing

Thanks for helping improve codex-imagegen-mcp. Bug reports, docs fixes, support for more MCP clients, tests and backend measurements are all welcome.

## Before you start

- **Small fixes** (typos, docs, clear bugs): open a pull request directly.
- **Larger changes** (new tools, new clients, behaviour changes): open an [issue](https://github.com/ShalomObongo/codex-imagegen-mcp/issues/new/choose) or a [discussion](https://github.com/ShalomObongo/codex-imagegen-mcp/discussions) first, so we can agree on the approach before you spend time on it.
- **Security issues**: report them privately; see [SECURITY.md](SECURITY.md).

## Development setup

```bash
git clone https://github.com/ShalomObongo/codex-imagegen-mcp.git
cd codex-imagegen-mcp
npm ci
npm test            # build + the full test suite
npm run typecheck
```

You need Node.js 22 or newer. [docs/DEVELOPMENT.md](../docs/DEVELOPMENT.md) covers the layout, the mock-backed test suite, live testing, the artwork pipeline and releases.

> [!IMPORTANT]
> The test suite never talks to OpenAI. Live testing (`generate`, or running the server inside a client) uses **your** ChatGPT quota. `status`, `doctor` and the `auth_status` tool are free.

## Making a change

1. **Branch** from `main`.
2. **Keep it focused.** One logical change per pull request is easier to review and to revert.
3. **Test it.** Add or update tests in `test/` for any behaviour change. Tests run against `test/helpers/mock-openai.ts` and an isolated temp home, so they never touch real credentials.
4. **Update the docs.** README, `docs/`, and the skill in `skill/imagegen/` if behaviour, options or output change. Keep limits in tool descriptions too, because some clients strip JSON-Schema constraints.
5. **Add a `CHANGELOG.md` entry** that describes the change from the user's side.

### Conventions

- **stdout is the MCP protocol.** Never write to it from server code paths; log with the logger (stderr and `server.log`).
- **Errors carry the next step.** Raise `ImagegenError(kind, message)`; every kind maps to an actionable hint in `describeError`.
- **Backend claims are measured, not assumed.** Record new findings in [docs/BACKEND.md](../docs/BACKEND.md) with the date.
- **The skill tracks upstream.** When changing prompting guidance, diff against `upstream/codex-imagegen-skill/`.
- **Artwork is generated with the tool itself**, following [docs/assets/README.md](../docs/assets/README.md). Commit only the composed assets, never raw generations.

### Commit messages

The history uses [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `ci:`, `chore:`, with an optional scope such as `fix(auth):`. Explain *why* in the body when it isn't obvious.

## Pull requests

- CI must pass: tests on Node 22, 24 and 26 (Linux) plus macOS and Windows, and a package-and-install check.
- Fill in the pull request template, including how you tested.
- Never include tokens, `auth.json` contents or personal data in code, tests, logs or screenshots.

## Releases

Maintainers bump `version` in `package.json`, add the `CHANGELOG.md` entry and push a `vX.Y.Z` tag. The [release workflow](workflows/release.yml) then tests, packs, attests and publishes the GitHub release with the changelog notes.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating, you agree to uphold it.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](../LICENSE), the same license as the project.
