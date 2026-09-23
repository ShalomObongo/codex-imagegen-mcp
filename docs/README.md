<p align="center">
  <img src="assets/banner-docs.jpg" width="100%" alt="Documentation — a travel-poster illustration of a wooden signpost with blank arrow boards at a desert crossroads, roads fanning out toward a sun rising behind a peak">
</p>

# Documentation

codex-imagegen-mcp puts the image generation of OpenAI Codex into any MCP client, running on your ChatGPT plan. These pages cover how to use it, how it signs in, where it plugs in, and how it works.

<table>
  <tr>
    <td width="33%" valign="top">
      <a href="TOOLS.md"><img src="assets/thumbs/banner-tools.jpg" alt="Tools"></a><br>
      <b>1 · <a href="TOOLS.md">Tools</a></b><br>
      <sub>Parameters, results, resources, prompts, errors, progress and timeouts.</sub>
    </td>
    <td width="33%" valign="top">
      <a href="AUTH.md"><img src="assets/thumbs/banner-auth.jpg" alt="Authentication"></a><br>
      <b>2 · <a href="AUTH.md">Authentication</a></b><br>
      <sub>Browser and device-code sign-in, token storage and rotation, borrowing, security.</sub>
    </td>
    <td width="33%" valign="top">
      <a href="CLIENTS.md"><img src="assets/thumbs/banner-clients.jpg" alt="Clients"></a><br>
      <b>3 · <a href="CLIENTS.md">Clients</a></b><br>
      <sub>The interactive installer and 25+ tools: config files, timeouts, skill folders, per-tool notes.</sub>
    </td>
  </tr>
  <tr>
    <td width="33%" valign="top">
      <a href="BACKEND.md"><img src="assets/thumbs/banner-backend.jpg" alt="Backend"></a><br>
      <b>4 · <a href="BACKEND.md">Backend</a></b><br>
      <sub>The Codex skill and built-in tool, the HTTP API, and what the service really honors.</sub>
    </td>
    <td width="33%" valign="top">
      <a href="ARCHITECTURE.md"><img src="assets/thumbs/banner-architecture.jpg" alt="Architecture"></a><br>
      <b>5 · <a href="ARCHITECTURE.md">Architecture</a></b><br>
      <sub>Module map, request flow, and the reasoning behind each design decision.</sub>
    </td>
    <td width="33%" valign="top">
      <a href="DEVELOPMENT.md"><img src="assets/thumbs/banner-development.jpg" alt="Development"></a><br>
      <b>6 · <a href="DEVELOPMENT.md">Development</a></b><br>
      <sub>Build, the mock-backed test suite, live testing, artwork, the release pipeline.</sub>
    </td>
  </tr>
</table>

## Where to start

| If you want to… | Read |
|---|---|
| Install it and make a first image | The [README quick start](../README.md#quick-start), then [Tools](TOOLS.md) |
| Know how it signs in, and whether that's safe | [Authentication](AUTH.md) |
| Set it up in your coding tools, or add a new one | [Clients](CLIENTS.md), then [INSTALLER.md](INSTALLER.md) for the design |
| Understand what Codex does under the hood | [Backend](BACKEND.md) |
| Change the code | [Architecture](ARCHITECTURE.md), then [Development](DEVELOPMENT.md) |
| Cut a release, or check how one was built | [Development › Releasing](DEVELOPMENT.md#releasing) and [Release integrity](../.github/SECURITY.md#release-integrity) |

## At a glance

```mermaid
flowchart LR
    agent["Your coding agent<br/>opencode · Claude Code · Cursor · VS Code"]:::ink
    server["codex-imagegen-mcp<br/>local stdio MCP server"]:::rust
    skill["imagegen-mcp skill<br/>how to prompt, where to save"]:::ochre
    oauth["auth.openai.com<br/>ChatGPT sign-in"]:::teal
    backend["chatgpt.com/backend-api/codex<br/>/images/generations · /images/edits"]:::teal
    files[("your workspace<br/>assets/hero.png")]:::cream
    skill -. guides .-> agent
    agent -- "tools/call" --> server
    server -- "OAuth · refresh" --> oauth
    server -- "Bearer token" --> backend
    server -- "PNG, never overwritten" --> files
    classDef ink fill:#2A2523,stroke:#9A8C76,color:#E4D9C6
    classDef rust fill:#A6553B,stroke:#7E3F2B,color:#FFFFFF
    classDef ochre fill:#D9A05B,stroke:#B5813F,color:#2A2523
    classDef teal fill:#4E6E63,stroke:#3A544B,color:#FFFFFF
    classDef cream fill:#E4D9C6,stroke:#A89A80,color:#2A2523
```

## About the artwork

Every picture in these docs was generated **with codex-imagegen-mcp itself**, using the skill it ships: the poster banners, the badges, the logo and the examples. The installer screenshots are real terminal output. The series follows one art direction, a 1930s WPA silkscreen travel poster in five flat inks. [The prompts, the direction record and how to rebuild the assets →](assets/README.md)

---

<p align="center"><a href="../README.md">← Back to the README</a> &nbsp;·&nbsp; <a href="TOOLS.md">Start with Tools →</a></p>
