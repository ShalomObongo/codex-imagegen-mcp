# Authentication

This document explains how the Codex image tool authenticates, how this MCP server reproduces that, and how a user signs in before using it. Every protocol detail was checked against the Codex source at tag `rust-v0.155.0-alpha.16`, the build shipped in the Codex desktop app 26.917.51856, and against the live service.

## TL;DR

- Image requests go to `https://chatgpt.com/backend-api/codex/images/{generations,edits}` with two headers:
  - `Authorization: Bearer <ChatGPT access token>`
  - `ChatGPT-Account-ID: <workspace id>`
- The access token comes from **OpenAI's OAuth server** (`auth.openai.com`) via the **Codex CLI's public client**. Browser sign-in uses authorization code + PKCE; headless sign-in uses OpenAI's device-code variant.
- Access tokens last about 10 days and are renewed with **single-use, rotating refresh tokens**.
- This server can use its **own** sign-in, or **borrow** an existing Codex/opencode ChatGPT sign-in **read-only**.

## Credential sources and order

At every request, the server uses the first source that yields a valid token:

| # | Source | File | Refreshed by this server? |
|---|---|---|---|
| 1 | **Own sign-in** (`codex-imagegen-mcp login` / `sign_in` tool) | `$CODEX_IMAGEGEN_HOME/auth.json` (default `~/.local/share/codex-imagegen-mcp/auth.json`) | **Yes**, automatically, under a cross-process lock |
| 2 | **Codex** CLI / desktop app | `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`) | **No**, read-only |
| 3 | **opencode** "ChatGPT Plus/Pro" provider | `~/.local/share/opencode/auth.json` → `openai` entry | **No**, read-only |

To pin one source, set `CODEX_IMAGEGEN_CREDENTIALS=own|codex|opencode`; the default is `auto`. Both `codex-imagegen-mcp status` and the `auth_status` tool show every source and which one is active.

### Why borrowed sign-ins are read-only

OpenAI refresh tokens are **single-use**. Every refresh returns a new refresh token and invalidates the old one. The server's error for reuse is `refresh_token_reused`, and Codex handles it at `codex-rs/login/src/auth/manager.rs`.

If this server refreshed Codex's or opencode's token, that app would later present an already-used refresh token and be signed out. So borrowed tokens are used only while their access token is valid, which is checked from the JWT `exp` claim with a 60-second margin. After that the server moves on to the next source.

The owning app renews its token the next time it runs; Codex refreshes when its token has less than 5 minutes left. Borrowed files are never written.

Codex users on the `keyring` credential store have no `auth.json`, so for them the borrowing source reports "not signed in". Use `login` instead.

## Signing in

### Browser (default)

```bash
codex-imagegen-mcp login
```

1. The CLI generates PKCE (64 random bytes as a base64url verifier; the S256 challenge) and a random `state`.
2. It starts a loopback server on `127.0.0.1:1455` (fallback `1457`). These ports are required: OpenAI allow-lists exactly `http://localhost:1455/auth/callback` and `…:1457/…` for this client. If a stale Codex or codex-imagegen login server holds the port, it is asked to `GET /cancel`, as Codex does.
3. It opens the authorize URL:

   ```
   https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann
     &redirect_uri=http://localhost:1455/auth/callback&scope=openid%20profile%20email%20offline_access
     &code_challenge=…&code_challenge_method=S256&id_token_add_organizations=true
     &codex_cli_simplified_flow=true&state=…&originator=codex-imagegen-mcp
   ```

4. You sign in to ChatGPT and approve. The browser is redirected to `/auth/callback?code=…&state=…`.
   - A wrong `state` is answered with 400, and the login keeps waiting.
   - An `error` parameter ends the login with a readable message. `missing_codex_entitlement` means Codex isn't enabled for the workspace.
5. The code is exchanged for tokens with `POST https://auth.openai.com/oauth/token` (form-encoded): `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `code_verifier`.
6. The tokens are saved and the browser shows "You're signed in". If an older sign-in of this tool existed, its refresh token is revoked.

The whole flow times out after 10 minutes, and Ctrl+C cancels it. The `sign_in` MCP tool runs the same flow inside the server process: it returns the link to the agent immediately (and tries to open it), then completes in the background.

**Scopes:** `openid profile email offline_access`. Codex additionally requests `api.connectors.read api.connectors.invoke`, but the image endpoints don't need them, so this server asks for less.

**Remote machines:** the browser must run on the same machine as the server, because the redirect goes to `localhost`. Over SSH, either use device code, or forward the port with `ssh -L 1455:localhost:1455 host` and open the printed URL locally.

### Device code (headless)

```bash
codex-imagegen-mcp login --device
```

1. `POST https://auth.openai.com/api/accounts/deviceauth/usercode` with `{client_id}` returns `{device_auth_id, user_code, interval}`.
2. You open **https://auth.openai.com/codex/device** on any device and enter the code. It is valid for 15 minutes.
3. The CLI polls `POST …/api/accounts/deviceauth/token` with `{device_auth_id, user_code}`. HTTP 403/404 means approval is still pending.
4. Once approved, the response contains `{authorization_code, code_verifier}`, where the server supplies the PKCE pair. The code is exchanged at `/oauth/token` with `redirect_uri=https://auth.openai.com/deviceauth/callback`.

A 404 on step 1 means device codes are disabled for your account. Enable "device code authorization for Codex" in **ChatGPT → Settings → Security**; on a workspace, an admin may need to allow it.

## Token storage

Our own file, `auth.json`, is written atomically (temp file, then rename) with mode `0600` in a `0700` directory:

```json
{
  "version": 1,
  "auth_mode": "chatgpt",
  "tokens": {
    "id_token": "<JWT>",
    "access_token": "<JWT, ~10 day lifetime>",
    "refresh_token": "<opaque, single-use>",
    "account_id": "<chatgpt_account_id from the id_token>"
  },
  "last_refresh": "2026-09-23T01:02:03.000Z",
  "login_method": "browser",
  "created_at": "2026-09-23T01:02:03.000Z"
}
```

The field names inside `tokens` match Codex's `auth.json`. Tokens are never logged; the log file contains only events.

## Refresh

- **When:** our own access token is refreshed when its `exp` is within **5 minutes**, as in Codex. If the token has no `exp`, it is refreshed once `last_refresh` is 8 days old. A refresh is also attempted once after any **401** from the backend.
- **How:** `POST https://auth.openai.com/oauth/token` with a JSON body `{"client_id": "…", "grant_type": "refresh_token", "refresh_token": "…"}`. There is no `scope`, exactly like Codex.
- **Concurrency:** MCP clients may run several server processes at once; opencode, for example, runs one per open project. The refresh runs under an exclusive lock file (`auth.lock`, with stale-lock detection).
  - After taking the lock, the file is **re-read**. If another process already rotated the tokens, its result is adopted instead of spending the refresh token a second time.
  - Tests verify that three concurrent processes produce exactly one refresh call.
- **Failures:**
  - `refresh_token_expired`, `refresh_token_reused`, `refresh_token_invalidated`, any 401, and 400 `invalid_grant` are **permanent**. You're asked to sign in again.
  - Anything else is transient: the current token is kept while still valid, and the refresh is retried on the next use.

## Headers sent to the ChatGPT backend

| Header | Value |
|---|---|
| `Authorization` | `Bearer <access_token>` |
| `ChatGPT-Account-ID` | `tokens.account_id` (the workspace to bill) |
| `originator` | `codex-imagegen-mcp` (override with `CODEX_IMAGEGEN_ORIGINATOR`) |
| `User-Agent` | `codex-imagegen-mcp/<version> (<os> <release>; <arch>) node/<version>` |
| `X-OpenAI-Fedramp` | `true` only when the token's `chatgpt_account_is_fedramp` claim is true |

## Plans and workspaces

- **Plan:** the plan comes from the JWT claim `chatgpt_plan_type`. The Codex client hides image generation on **Free**; this server allows the request and reports the backend's answer clearly.
- **Workspace:** the workspace used is the `chatgpt_account_id` claim of the sign-in. To use a different workspace, sign in again and choose it on the consent screen; `sign_in` with `force: true` does this from the agent.
- **Quota:** usage is metered against your ChatGPT plan's Codex limits. `status` and `auth_status` read `GET https://chatgpt.com/backend-api/wham/usage`, which costs nothing, to show the 5-hour and weekly windows.

## Signing out

```bash
codex-imagegen-mcp logout            # revoke our refresh token at /oauth/revoke and delete auth.json
codex-imagegen-mcp logout --no-revoke
```

Borrowed Codex and opencode sign-ins are never touched; sign out of those apps separately.

## Troubleshooting

| Message | Cause | Fix |
|---|---|---|
| `Not signed in to ChatGPT … (Checked — …)` | No source has a valid token | `login`, or open Codex/opencode once so their sign-in refreshes |
| `Your sign-in was invalidated because its refresh token was already used` | Another machine or process used the same refresh token (e.g. a copied auth.json) | `login` again; don't share `auth.json` between machines |
| `ports 1455 and 1457 are busy` | Another Codex/opencode login is waiting | Finish or close it, or use `--device` |
| `Device-code sign-in is not enabled for this account` | Device codes disabled | Enable in ChatGPT → Settings → Security, or use the browser flow |
| `Codex is not enabled for your ChatGPT workspace` | Workspace policy (`missing_codex_entitlement`) | Ask the workspace admin |
| `ChatGPT rejected the … (HTTP 401)` | Token revoked or expired server-side | `login` again |
| `Access denied (HTTP 403)` | Plan or workspace without Codex image generation (e.g. Free) | Upgrade, or switch workspace |
| `blocked by Cloudflare` | Network flagged by Cloudflare | Retry later or from another network |

## Security notes

- **The OAuth client:** `app_EMoamEEZ73f0CkXaXp7hrann` is OpenAI's public native client for the Codex CLI. It has no client secret; PKCE protects the flow. opencode's ChatGPT sign-in uses the same client. This project identifies itself honestly via `originator` and `User-Agent`.
- **The tokens:** tokens grant access to your ChatGPT account's Codex features. Treat `auth.json` like a password; it is `0600` for that reason.
- **What leaves the machine:** nothing but requests to `auth.openai.com` and `chatgpt.com`, plus downloads of any http(s) input image URLs you pass. There is no telemetry.
- **Terms of use:** this is an unofficial integration of an internal API. Use it within OpenAI's Terms of Use.
