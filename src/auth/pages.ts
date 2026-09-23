function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

function page(title: string, heading: string, body: string, ok: boolean): string {
  const accent = ok ? "#10a37f" : "#d9534f";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         background: Canvas; color: CanvasText; }
  main { max-width: 34rem; padding: 2.5rem; border-radius: 16px; border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); }
  .badge { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center;
           background: ${accent}; color: white; font-size: 24px; margin-bottom: 1rem; }
  h1 { font-size: 1.35rem; margin: 0 0 .5rem; }
  p { margin: .5rem 0; opacity: .85; }
  code { font-size: .9em; }
</style>
</head>
<body><main>
  <div class="badge">${ok ? "&#10003;" : "!"}</div>
  <h1>${escapeHtml(heading)}</h1>
  ${body}
</main></body>
</html>`;
}

export function successPage(email: string | undefined): string {
  const who = email ? `<p>Signed in as <strong>${escapeHtml(email)}</strong>.</p>` : "";
  return page(
    "Signed in — Codex ImageGen MCP",
    "You're signed in to Codex ImageGen MCP",
    `${who}<p>Image generation will use your ChatGPT plan. You can close this tab and return to your coding tool.</p>`,
    true,
  );
}

export function errorPage(message: string): string {
  return page(
    "Sign-in failed — Codex ImageGen MCP",
    "Sign-in failed",
    `<p>${escapeHtml(message)}</p><p>Return to your terminal or coding tool and try again.</p>`,
    false,
  );
}
