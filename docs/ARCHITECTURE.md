# Architecture

```
MCP client (opencode, Claude Code, …)
   │ stdio (JSON-RPC)                                   terminal
   ▼                                                        │
src/server/  McpServer: tools · resources · prompts      src/cli.ts  login/status/generate/install/…
   │            │ progress heartbeats, workspace roots        │
   └────────────┴──────────────┬──────────────────────────────┘
                               ▼
        src/generation.ts · src/remove-background.ts · src/status.ts     (shared engine)
                               │
          ┌────────────────────┼─────────────────────────┐
          ▼                    ▼                         ▼
  src/backend/          src/auth/                   src/images/
  images-client.ts      manager.ts ◄── store.ts      codec (PNG/JPEG), resize, preview,
  ratelimits.ts           │   ▲       (own, 0600)    chroma (remove_chroma_key port),
     │                    │   └─ borrowed.ts          inputs (path/URL/data URL), output
     │                    │      (Codex/opencode,      (plan paths, no-overwrite writes)
     │                    │       read-only)
     │                    ├─ oauth.ts: authorize URL, code exchange, refresh, revoke, device code
     │                    ├─ browser-login.ts: loopback callback 127.0.0.1:1455/1457
     │                    └─ device-login.ts
     ▼
chatgpt.com/backend-api/codex/images/{generations,edits}   ·   /backend-api/wham/usage
auth.openai.com/oauth/{authorize,token,revoke}   ·   /api/accounts/deviceauth/*
```

## Modules

| Path | Responsibility |
|---|---|
| `src/constants.ts` | Protocol constants (issuer, client id, ports, endpoints, limits), with the reason for each |
| `src/config.ts` | Resolves the environment into a `RuntimeConfig` (paths, URLs, mode, timeouts) |
| `src/auth/` | Sign-in flows, token store, refresh, credential source resolution |
| `src/backend/` | ChatGPT image and usage HTTP client, error mapping, rate-limit parsing |
| `src/images/` | Pure-JS image handling: sniffing, codec, resampling, previews, chroma key, I/O |
| `src/generation.ts` | One generate/edit operation: load inputs → n concurrent requests → save → history → previews |
| `src/remove-background.ts` | One chroma-key operation |
| `src/status.ts` | Collects and formats sign-in, source and usage status |
| `src/history.ts` | Append-only `history.jsonl` |
| `src/server/` | MCP wiring: tools, resources, prompts, instructions, progress, roots, background sign-in |
| `src/install/` | opencode installer (JSONC edits, skill copy) and snippets for other clients |
| `src/doctor.ts` | Environment diagnostics |
| `src/cli.ts` | Command-line entry point (`serve` is the MCP entry) |
| `skill/imagegen/` | The Agent Skill shipped with the server |
| `upstream/` | Byte-exact copy of Codex's original skill, for provenance and diffing |

## Request flow: `generate_image`

1. **Handler starts.** The tool handler starts progress heartbeats and resolves the workspace directory: the client's first MCP root, else cwd.
2. **Validate.** `runGeneration` checks the arguments, loads and validates the inputs, adds the aspect-ratio line and plans the output paths.
3. **Request.** `n` concurrent calls go to `ImagesClient.createImage`. Each one:
   - gets credentials from `AuthManager.getCredentials()`, which refreshes our own token if needed, under the lock;
   - POSTs the Codex-identical body;
   - on 401, runs `recoverFromUnauthorized` (refresh, re-read, or move to the next source) and retries once;
   - retries 5xx and network errors twice;
   - maps any other failure to an `ImagegenError`.
4. **Save.** Each result is saved as soon as it arrives (so partial success is kept):
   - converted to JPEG if requested;
   - written without overwriting;
   - transparency verified by decoding;
   - previewed;
   - appended to history.
5. **Return.** The handler returns text plus image previews plus `structuredContent`, or `isError` with the next step.

## Design decisions

- **ChatGPT sign-in only, no API key.** The goal is to use the subscription people already pay for, exactly like Codex. The Platform API needs separate billing and is deliberately out of scope.
- **The same request as Codex.** The body, endpoints and auth match `codex-rs` byte for byte, so the server behaves like Codex does and inherits OpenAI's server-side model upgrades.
- **Borrowing is read-only.** Refresh tokens are single-use, so a second refresher would sign the owner app out. Borrowed tokens are used until they expire and are never refreshed or written.
- **Our own refresh is lock-serialized.** MCP clients spawn several server processes (one per project in opencode). The lock plus a re-read means exactly one refresh per rotation.
- **Honest parameters.** The service ignores model, size, quality, n and format, so the tools don't pretend otherwise:
  - `aspect_ratio` is a prompt line, which the service measurably honors;
  - `n` is fan-out;
  - JPEG is a local conversion.
- **Previews, not full images, in tool results.** Tool results carry a 1024 px JPEG preview; the full-resolution file goes to disk. This keeps results well under the MCP SDK's 10 MB stdio message limit and clients' attachment limits (opencode: 5 MiB, 2000 px), while the model can still verify its work.
- **No `resource_link` content.** Older clients reject unknown content types, and opencode drops them anyway. Paths go in text and `structuredContent` instead.
- **Constraints are repeated in descriptions.** opencode strips `min`, `max` and `default` from JSON Schemas for OpenAI models, so every limit is also written in the parameter description.
- **Progress heartbeats.** opencode resets its per-request timeout on progress, so long generations survive its 60 s default without special configuration.
- **Background sign-in inside the server.** The `sign_in` tool can hand the user a link immediately. MCP elicitation isn't widely supported (opencode lacks it), so returning the link as text is the portable option.
- **Pure-JS image handling** (`pngjs`, `jpeg-js`). No native dependencies means it installs everywhere, which matters because MCP servers are launched from many environments.
- **Never overwrite.** This mirrors the Codex skill's save policy and is enforced in code (`wx` exclusive create with versioned siblings), not just requested of the model.
- **stdout hygiene.** `console.log`, `console.info` and `console.debug` are redirected to stderr in `serve`, and logs go to stderr plus `server.log`. The server exits when stdin closes, because that is how clients stop stdio servers.
