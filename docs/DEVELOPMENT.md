# Development

## Setup

```bash
npm install
npm run build        # tsc → dist/, marks dist/src/cli.js executable
npm test             # build + node:test suite (Node ≥ 22 for the glob runner)
npm run typecheck
```

`npm link` exposes `codex-imagegen-mcp` globally for manual testing.

## Layout

```
src/            TypeScript sources (see docs/ARCHITECTURE.md)
test/           node:test suites; test/helpers/mock-openai.ts is a scriptable mock of
                auth.openai.com + the ChatGPT backend
skill/imagegen  the Agent Skill shipped with the server
upstream/       byte-exact copy of the Codex skill it was adapted from
docs/           documentation
```

## Tests

The suite never talks to OpenAI. `test/helpers/mock-openai.ts` implements:

- **OAuth:**
  - authorization-code exchange that verifies the PKCE `code_verifier` against the challenge and the `redirect_uri`;
  - **rotating, single-use refresh tokens**: reuse returns `refresh_token_reused`, just like the real service;
  - revoke;
  - device-code usercode and polling, with a configurable number of pending polls.
- **Backend:** `images/generations`, `images/edits` (bearer checks, transparent PNGs when requested, rate-limit headers) and `wham/usage`.
- **Scripting:** queue scripted responses (`state.imageQueue`) to simulate 401, 429, 5xx, policy and Cloudflare errors, plus delays.

`test/helpers/env.ts` builds an isolated `CODEX_IMAGEGEN_*` environment in a temp directory, so tests never read or write your real credentials. The installer tests also point `HOME` and `XDG_CONFIG_HOME` at temp dirs.

| Suite | Covers |
|---|---|
| `auth-primitives` | JWT claims, PKCE, authorize URL, 0600 store, cross-process lock, stale locks |
| `auth-manager` | refresh (incl. 3 concurrent processes → 1 refresh), permanent vs transient failures, borrowed sources, 401 recovery, revoke |
| `login-flows` | browser round-trip, state mismatch, authorize errors, failed exchange, cancel, timeout, device code |
| `images-client` | exact request body/headers, edits, retries, usage limits, policy/invalid/Cloudflare mapping, usage API |
| `image-processing` | codec, previews, chroma key, output planning, no-overwrite, input validation |
| `install` | JSONC-preserving opencode edits, backups, idempotency, conflict protection, uninstall, snippets |
| `server` | full MCP over stdio: tools, resources, prompts, progress, errors, sign-in via tool, then generation |
| `cli` | commands end-to-end against the mock |

## Live testing

These use your real ChatGPT quota.

```bash
node dist/src/cli.js status                       # auth + usage, no quota
node dist/src/cli.js generate "a red apple" -o tmp/live/apple.png
node dist/src/cli.js install opencode && opencode mcp list
opencode run -m openai/gpt-5.5 "make a transparent sticker of a cactus, save to assets/cactus.png"
opencode run -m github-copilot/claude-sonnet-5 "…"   # Copilot providers take a different media path in opencode
```

The `tmp/` directory is git-ignored. `CODEX_IMAGEGEN_LOG_LEVEL=debug` plus `~/.local/share/codex-imagegen-mcp/server.log` show what the server did inside a client.

## Conventions

- **Output:** never write to stdout in server code paths; stdout is the protocol.
- **Errors:** raise `ImagegenError(kind, message)` with an actionable message. The kinds map to the next steps in `describeError`.
- **Constraints:** keep limits in tool descriptions too, because some clients strip schema constraints.
- **Backend fidelity:** backend behavior claims must be measured. Record measurements in `docs/BACKEND.md` with the date.
- **Skill changes:** diff against `upstream/codex-imagegen-skill/` and keep the prompting guidance aligned with upstream.

## Updating from upstream Codex

1. Extract the current skill:

   ```bash
   CODEX_HOME=$(mktemp -d) /Applications/ChatGPT.app/Contents/Resources/codex debug prompt-input hi >/dev/null
   ```

   It installs the embedded system skills into `$CODEX_HOME/skills/.system/`.
2. Diff that `imagegen/` against `upstream/codex-imagegen-skill/`, update the copy, and port relevant guidance into `skill/imagegen/`.
3. Check `codex-rs/ext/image-generation/src/tool.rs` upstream for changes to the request body, model id or limits.

## Release checklist

1. `npm test` passes; `npm run typecheck` is clean.
2. Live smoke: `status`, one `generate`, one `edit` with `-b transparent`, `doctor`.
3. opencode: `install opencode`, `opencode mcp list`, one `opencode run`.
4. Bump the `version` in `package.json` and add a `CHANGELOG.md` entry.
5. `npm pack --dry-run` includes `dist/src`, `skill`, `docs`, `README.md`, `LICENSE`, `NOTICE`.
