import { spawn } from "node:child_process";

/**
 * Best-effort: open a URL in the user's default browser. Resolves `true` if a launcher process
 * started. Honors $BROWSER. Never throws.
 */
export function openInBrowser(url: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  let command: string;
  let args: string[];
  const custom = env.BROWSER?.trim();
  if (custom) {
    command = custom;
    args = [url];
  } else if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    // rundll32 avoids cmd.exe re-parsing the `&` characters in OAuth URLs.
    command = "rundll32";
    args = ["url.dll,FileProtocolHandler", url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { detached: true, stdio: "ignore" });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
