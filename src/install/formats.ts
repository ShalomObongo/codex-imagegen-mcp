import { isDeepStrictEqual } from "node:util";
import { applyEdits, modify, parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import { parse as parseToml, stringify as stringifyToml, TomlError } from "smol-toml";
import { isMap, isScalar, parseDocument } from "yaml";

export type ConfigFormat = "json" | "toml" | "yaml";

/** A config file can't be read or safely edited. The message is shown to the user as-is. */
export class ConfigEditError extends Error {
  override name = "ConfigEditError";
}

type Obj = Record<string, unknown>;

export function isPlainObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

export function getIn(value: unknown, keyPath: readonly string[]): unknown {
  let cur = value;
  for (const key of keyPath) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function nest(keyPath: readonly string[], value: unknown): Obj {
  let out: unknown = value;
  for (let i = keyPath.length - 1; i >= 0; i--) out = { [keyPath[i]!]: out };
  return out as Obj;
}

/** Copy of `value` without `keyPath`, pruning objects left empty along the path. */
function without(value: unknown, keyPath: readonly string[]): unknown {
  if (keyPath.length === 0 || !isPlainObject(value)) return value;
  const [key, ...rest] = keyPath as [string, ...string[]];
  if (!(key in value)) return value;
  const copy: Obj = { ...value };
  if (rest.length === 0) delete copy[key];
  else {
    // A null parent (`extensions:` with nothing under it) counts as empty.
    const child = copy[key] === null ? {} : without(copy[key], rest);
    if (isPlainObject(child) && Object.keys(child).length === 0) delete copy[key];
    else copy[key] = child;
  }
  return copy;
}

/** Plain-JSON form for comparisons (dates to strings, undefined dropped). */
function normalize(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function sameValue(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(normalize(a), normalize(b));
}

function lineCol(text: string, offset: number): string {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  return `line ${line}, column ${offset - before.lastIndexOf("\n")}`;
}

interface Adapter {
  /** Whole document as plain data. Throws ConfigEditError on syntax errors. */
  parse(text: string): Obj;
  /** New text with `keyPath` set to `value`, or removed when `value` is undefined. */
  update(text: string, keyPath: readonly string[], value: unknown): string;
  /** Text of a new file containing `value` at `keyPath`, after `template`'s keys. */
  create(keyPath: readonly string[], value: unknown, template?: Obj): string;
}

// ---------------------------------------------------------------------------------------------
// JSON / JSONC: jsonc-parser edits only the affected range, so comments, key order and
// indentation survive.
// ---------------------------------------------------------------------------------------------

function detectFormatting(text: string): { insertSpaces: boolean; tabSize: number; eol: string } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indented = /^([ \t]+)\S/m.exec(text)?.[1];
  if (indented?.startsWith("\t")) return { insertSpaces: false, tabSize: 1, eol };
  return { insertSpaces: true, tabSize: indented ? Math.min(8, indented.length) : 2, eol };
}

const json: Adapter = {
  parse(text) {
    if (!text.trim()) return {};
    const errors: ParseError[] = [];
    const value: unknown = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
    const first = errors[0];
    if (first) throw new ConfigEditError(`invalid JSON (${printParseErrorCode(first.error)} at ${lineCol(text, first.offset)})`);
    if (!isPlainObject(value)) throw new ConfigEditError("the file does not contain a JSON object");
    return value;
  },
  update(text, keyPath, value) {
    const base = text.trim() ? text : "{}\n";
    return applyEdits(base, modify(base, [...keyPath], value, { formattingOptions: detectFormatting(base) }));
  },
  create(keyPath, value, template) {
    return `${JSON.stringify({ ...template, ...nest(keyPath, value) }, null, 2)}\n`;
  },
};

// ---------------------------------------------------------------------------------------------
// TOML (Codex): TOML libraries drop comments when they re-serialize, so the table is replaced
// textually. Only the `[a.b]` table and its `[a.b.*]` subtables are touched; the result is
// re-parsed and compared with the original before anything is written.
// ---------------------------------------------------------------------------------------------

/** Split a dotted TOML key (`a."b.c".d`) into its parts. */
function parseDottedKey(raw: string): string[] | undefined {
  const parts: string[] = [];
  let i = 0;
  const s = raw.trim();
  while (i < s.length) {
    while (s[i] === " " || s[i] === "\t") i++;
    let part = "";
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i]!;
      i++;
      while (i < s.length && s[i] !== q) {
        if (q === '"' && s[i] === "\\" && i + 1 < s.length) {
          const next = s[i + 1]!;
          part += next === "n" ? "\n" : next === "t" ? "\t" : next;
          i += 2;
          continue;
        }
        part += s[i];
        i++;
      }
      if (s[i] !== q) return undefined;
      i++;
    } else {
      while (i < s.length && /[A-Za-z0-9_-]/.test(s[i]!)) part += s[i++];
      if (!part) return undefined;
    }
    parts.push(part);
    while (s[i] === " " || s[i] === "\t") i++;
    if (i < s.length) {
      if (s[i] !== ".") return undefined;
      i++;
    }
  }
  return parts;
}

interface TomlSection {
  start: number;
  /** Exclusive. */
  end: number;
  path: string[];
}

/** Table sections (`[x]` / `[[x]]` header to the next header), skipping multi-line strings. */
function tomlSections(lines: string[]): TomlSection[] {
  const headers: { index: number; path: string[] }[] = [];
  let open: '"""' | "'''" | undefined;
  lines.forEach((line, index) => {
    if (!open) {
      const m = /^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/.exec(line);
      const keyPath = m ? parseDottedKey(m[1]!) : undefined;
      if (keyPath) {
        headers.push({ index, path: keyPath });
        return;
      }
    }
    // Track multi-line strings so a "[x]" line inside one is not mistaken for a header.
    let rest = open ? line : line.slice(line.indexOf("=") + 1 || line.length);
    for (;;) {
      if (open) {
        const close = rest.indexOf(open);
        if (close < 0) break;
        rest = rest.slice(close + 3);
        open = undefined;
      } else {
        const d = rest.indexOf('"""');
        const l = rest.indexOf("'''");
        if (d < 0 && l < 0) break;
        const [pos, delim] = l < 0 || (d >= 0 && d < l) ? [d, '"""' as const] : [l, "'''" as const];
        rest = rest.slice(pos + 3);
        open = delim;
      }
    }
  });
  return headers.map((h, i) => ({ start: h.index, end: headers[i + 1]?.index ?? lines.length, path: h.path }));
}

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((part, i) => path[i] === part);
}

const toml: Adapter = {
  parse(text) {
    try {
      return parseToml(text) as Obj;
    } catch (err) {
      const where = err instanceof TomlError ? ` at line ${err.line}, column ${err.column}` : "";
      throw new ConfigEditError(`invalid TOML${where} (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`);
    }
  },
  update(text, keyPath, value) {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    const ours = tomlSections(lines).filter((s) => startsWith(s.path, keyPath));
    if (ours.length === 0 && getIn(toml.parse(text), keyPath) !== undefined) {
      throw new ConfigEditError(`[${keyPath.join(".")}] is written inline or with dotted keys, which can't be edited safely; change it by hand`);
    }
    if (ours.length === 0 && value === undefined) return text;
    let insertAt = -1;
    for (const section of [...ours].reverse()) {
      // Trailing blank/comment lines: a comment block sitting above the next header belongs to that
      // header and stays. Blank lines go too when a blank line already precedes the section.
      let tail = section.end;
      while (tail > section.start + 1 && /^\s*(#.*)?$/.test(lines[tail - 1]!)) tail--;
      let firstComment = tail;
      while (firstComment < section.end && lines[firstComment]!.trim() === "") firstComment++;
      const precededByBlank = section.start === 0 || lines[section.start - 1]!.trim() === "";
      lines.splice(section.start, (precededByBlank ? firstComment : tail) - section.start);
      insertAt = section.start;
    }
    if (value !== undefined) {
      const block = stringifyToml(nest(keyPath, value)).trimEnd().split("\n");
      if (insertAt < 0) {
        while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
        if (lines.length > 0) lines.push("");
        lines.push(...block);
      } else {
        if (insertAt > 0 && lines[insertAt - 1]!.trim() !== "") lines.splice(insertAt++, 0, "");
        lines.splice(insertAt, 0, ...block);
        const next = insertAt + block.length;
        if (next < lines.length && lines[next]!.trim() !== "") lines.splice(next, 0, "");
      }
    } else if (insertAt > 0 && insertAt < lines.length && lines[insertAt - 1]!.trim() === "" && lines[insertAt]!.trim() === "") {
      lines.splice(insertAt, 1);
    }
    while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
    return lines.length > 0 ? `${lines.join(eol)}${eol}` : "";
  },
  create(keyPath, value, template) {
    const head = template && Object.keys(template).length ? `${stringifyToml(template).trimEnd()}\n\n` : "";
    return `${head}${stringifyToml(nest(keyPath, value)).trimEnd()}\n`;
  },
};

// ---------------------------------------------------------------------------------------------
// YAML (Goose): the yaml Document API keeps comments and the layout of untouched nodes.
// ---------------------------------------------------------------------------------------------

const yaml: Adapter = {
  parse(text) {
    const doc = parseDocument(text);
    const error = doc.errors[0];
    if (error) throw new ConfigEditError(`invalid YAML (${error.message.split("\n")[0]})`);
    const value: unknown = doc.toJS();
    if (value === null || value === undefined) return {};
    if (!isPlainObject(value)) throw new ConfigEditError("the file does not contain a YAML mapping");
    return value;
  },
  update(text, keyPath, value) {
    const doc = parseDocument(text);
    if (value === undefined) {
      if (doc.hasIn(keyPath)) doc.deleteIn(keyPath);
    } else {
      for (let i = 1; i < keyPath.length; i++) {
        const node: unknown = doc.getIn(keyPath.slice(0, i), true);
        if (node === undefined || node === null || (isScalar(node) && node.value === null)) doc.setIn(keyPath.slice(0, i), doc.createNode({}));
        else if (!isMap(node)) throw new ConfigEditError(`"${keyPath.slice(0, i).join(".")}" is not a mapping`);
      }
      doc.setIn(keyPath, doc.createNode(value));
    }
    return doc.toString({ lineWidth: 0 });
  },
  create(keyPath, value, template) {
    const doc = parseDocument("");
    for (const [k, v] of Object.entries(template ?? {})) doc.set(k, v);
    doc.setIn(keyPath, doc.createNode(value));
    return doc.toString({ lineWidth: 0 });
  },
};

const ADAPTERS: Record<ConfigFormat, Adapter> = { json, toml, yaml };

export function parseConfig(format: ConfigFormat, text: string): Obj {
  return ADAPTERS[format].parse(text);
}

/**
 * Set (or with `value === undefined`, remove) `keyPath` in a config file's text. The result is
 * re-parsed: the key must hold exactly `value` and every other key must be unchanged, otherwise
 * ConfigEditError is thrown and nothing should be written.
 */
export function editConfig(format: ConfigFormat, text: string | undefined, keyPath: readonly string[], value: unknown, template?: Obj): string {
  const adapter = ADAPTERS[format];
  if (text === undefined && value === undefined) return "";
  const creating = text === undefined || (text.trim() === "" && value !== undefined);
  const before = creating ? {} : adapter.parse(text);
  const next = creating ? adapter.create(keyPath, value, template) : adapter.update(text, keyPath, value);
  const after = adapter.parse(next);
  const expectedRest = creating ? without({ ...template }, keyPath) : without(before, keyPath);
  if (!sameValue(getIn(after, keyPath), value) || !sameValue(without(after, keyPath), expectedRest)) {
    throw new ConfigEditError("the edit could not be verified, so nothing was written");
  }
  return next;
}

/** A standalone snippet (for manual setup): `value` nested under `keyPath`. */
export function renderSnippet(format: ConfigFormat, keyPath: readonly string[], value: unknown): string {
  return ADAPTERS[format].create(keyPath, value);
}
