import { styleText } from "node:util";

type Style = (text: string) => string;
type Named = Parameters<typeof styleText>[0];

export interface Theme {
  enabled: boolean;
  bold: Style;
  dim: Style;
  italic: Style;
  /** Brand accents (the docs' WPA-poster palette). */
  rust: Style;
  ochre: Style;
  sage: Style;
  /** The package name as a small label. */
  badge: Style;
  ok: Style;
  warn: Style;
  error: Style;
}

/** NO_COLOR (non-empty) disables colour, FORCE_COLOR forces it, otherwise colour follows the TTY. */
export function colorEnabled(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined) return !["0", "false"].includes(env.FORCE_COLOR);
  return Boolean(stream.isTTY) && env.TERM !== "dumb";
}

export function createTheme(enabled: boolean, env: NodeJS.ProcessEnv = process.env): Theme {
  const truecolor = /^(truecolor|24bit)$/i.test(env.COLORTERM ?? "");
  const named =
    (format: Named): Style =>
    (s) =>
      enabled ? styleText(format, s, { validateStream: false }) : s;
  const rgb = (hex: string, fallback: Named): Style => {
    if (!enabled) return (s) => s;
    if (!truecolor) return named(fallback);
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
    return (s) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
  };
  const rust = rgb("#C0643F", "red");
  const ochre = rgb("#D9A05B", "yellow");
  const sage = rgb("#7FA895", "green");
  const badge: Style = !enabled
    ? (s) => s
    : truecolor
      ? (s) => `\x1b[48;2;166;85;59m\x1b[38;2;228;217;198m\x1b[1m ${s} \x1b[0m`
      : (s) => styleText(["inverse", "bold"], ` ${s} `, { validateStream: false });
  return {
    enabled,
    bold: named("bold"),
    dim: named("dim"),
    italic: named("italic"),
    rust,
    ochre,
    sage,
    badge,
    ok: sage,
    warn: ochre,
    error: named("red"),
  };
}

export const plainTheme = createTheme(false);
