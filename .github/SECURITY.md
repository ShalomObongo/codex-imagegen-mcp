# Security policy

codex-imagegen-mcp holds ChatGPT OAuth tokens and writes files on your machine, so security reports are taken seriously.

## Supported versions

Only the [latest release](https://github.com/ShalomObongo/codex-imagegen-mcp/releases/latest) receives security fixes. Please upgrade before reporting.

## Reporting a vulnerability

**Please don't open a public issue.** Report privately through GitHub:

**[Report a vulnerability →](https://github.com/ShalomObongo/codex-imagegen-mcp/security/advisories/new)**

Include:

- what an attacker can do, and under which conditions;
- steps to reproduce, or a proof of concept;
- the version (`codex-imagegen-mcp --version`), your OS and the MCP client involved.

> [!WARNING]
> Never include real tokens or the contents of any `auth.json` in a report. If you believe a token has leaked, sign out with `codex-imagegen-mcp logout`, which revokes this tool's refresh token.

The maintainer aims to acknowledge reports within a week, and to keep you updated until a fix is released. You'll be credited in the advisory unless you'd rather not be.

## Security model

What the server does, so you can judge what counts as a vulnerability:

- **It runs locally** as a stdio MCP server, started by your MCP client. It opens no network port, except a loopback-only (`127.0.0.1`) callback server on port 1455 or 1457 while a browser sign-in is in progress.
- **Sign-in** uses OAuth 2.0 authorization code with PKCE (S256) and a random `state`, or OpenAI's device-code flow, both against `auth.openai.com` with the Codex CLI's public client.
- **Its own tokens** are stored in `~/.local/share/codex-imagegen-mcp/auth.json`, written atomically with mode `0600` in a `0700` directory. Refreshes are serialized across processes with a lock file, because refresh tokens are single-use.
- **Borrowed sign-ins** (Codex's `~/.codex/auth.json`, opencode's ChatGPT sign-in) are read-only: never refreshed and never written.
- **Tokens are never logged.** Logs record events only.
- **Network traffic** goes only to `auth.openai.com` and `chatgpt.com`, plus downloads of any `http(s)` input-image URLs a caller passes to `edit_image`. Downloads are rejected unless they are PNG, JPEG or WebP (checked by magic bytes) and at most 15 MB. There is no telemetry.
- **Files** are written only where a caller asks, or into the image library, and existing files are never overwritten unless `overwrite: true` is passed.

Things that are **out of scope** here:

- vulnerabilities in OpenAI's services: report them through [OpenAI's security program](https://openai.com/security/);
- vulnerabilities in MCP clients (opencode, Claude Code, Cursor, …): report them to those projects;
- an agent being instructed by a malicious prompt to generate or save images where you didn't intend. The server enforces its own limits (no overwrites, validated inputs), but it acts on the tool calls your client sends.
