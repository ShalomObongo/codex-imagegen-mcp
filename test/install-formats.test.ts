import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parse as parseJsonc } from "jsonc-parser";
import { parse as smolParse } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { ConfigEditError, editConfig, parseConfig, renderSnippet } from "../src/install/formats.js";

/** smol-toml returns null-prototype objects; compare as plain JSON. */
const parseToml = (text: string) => JSON.parse(JSON.stringify(smolParse(text)));

const ENTRY = { command: "/usr/local/bin/node", args: ["/opt/pkg/dist/src/cli.js", "serve"] };

describe("JSON/JSONC edits", () => {
  const original = `{
  // my settings — comments must survive
  "theme": "dark",
  "mcpServers": {
    "other": { "command": "x" }, // keep me
  },
}
`;

  test("adds an entry without disturbing comments, order or trailing commas", () => {
    const next = editConfig("json", original, ["mcpServers", "imagegen"], ENTRY);
    assert.match(next, /\/\/ my settings — comments must survive/);
    assert.match(next, /\/\/ keep me/);
    const cfg = parseJsonc(next, [], { allowTrailingComma: true });
    assert.deepEqual(cfg.mcpServers.imagegen, ENTRY);
    assert.deepEqual(cfg.mcpServers.other, { command: "x" });
    assert.ok(next.indexOf('"theme"') < next.indexOf('"mcpServers"'));
  });

  test("updates and removes in place", () => {
    const added = editConfig("json", original, ["mcpServers", "imagegen"], ENTRY);
    const updated = editConfig("json", added, ["mcpServers", "imagegen"], { ...ENTRY, env: { A: "1" } });
    assert.deepEqual(parseJsonc(updated, [], { allowTrailingComma: true }).mcpServers.imagegen.env, { A: "1" });
    const removed = editConfig("json", updated, ["mcpServers", "imagegen"], undefined);
    const cfg = parseJsonc(removed, [], { allowTrailingComma: true });
    assert.equal(cfg.mcpServers.imagegen, undefined);
    assert.match(removed, /keep me/);
  });

  test("keys containing dots (Amp's \"amp.mcpServers\") and tab indentation", () => {
    const tabbed = '{\n\t"amp.mcpServers": {}\n}\n';
    const next = editConfig("json", tabbed, ["amp.mcpServers", "imagegen"], ENTRY);
    assert.deepEqual(JSON.parse(next)["amp.mcpServers"].imagegen, ENTRY);
    assert.match(next, /\n\t\t"imagegen"/);
  });

  test("new and empty files", () => {
    const created = editConfig("json", undefined, ["mcp", "imagegen"], { type: "local" }, { $schema: "https://opencode.ai/config.json" });
    assert.deepEqual(JSON.parse(created), { $schema: "https://opencode.ai/config.json", mcp: { imagegen: { type: "local" } } });
    assert.deepEqual(JSON.parse(editConfig("json", "   \n", ["servers", "imagegen"], ENTRY)), { servers: { imagegen: ENTRY } });
  });

  test("broken files are reported, not overwritten", () => {
    assert.throws(() => editConfig("json", '{ "a": 1, ', ["mcpServers", "imagegen"], ENTRY), ConfigEditError);
    assert.throws(() => parseConfig("json", "[1, 2]"), /does not contain a JSON object/);
  });
});

describe("TOML edits (Codex)", () => {
  const original = `# Codex config — comments must survive
model = "gpt-5.5"

[mcp_servers.other]
command = "other" # inline comment

# settings for projects
[projects."/Users/me/app"]
trust_level = "trusted"
`;

  test("appends a table and leaves everything else byte-identical", () => {
    const next = editConfig("toml", original, ["mcp_servers", "imagegen"], { ...ENTRY, tool_timeout_sec: 300 });
    assert.ok(next.startsWith(original.trimEnd()));
    assert.match(next, /\n\n\[mcp_servers\.imagegen\]\ncommand = "\/usr\/local\/bin\/node"\n/);
    const cfg = parseToml(next) as Record<string, any>;
    assert.equal(cfg.mcp_servers.imagegen.tool_timeout_sec, 300);
    assert.equal(cfg.projects["/Users/me/app"].trust_level, "trusted");
  });

  test("replaces the table and its subtables in place, keeping neighbouring comments", () => {
    const withOurs = `${original}
[mcp_servers.imagegen]
command = "old"
args = ["serve"]

[mcp_servers.imagegen.env]
OLD = "1"

# trailing section
[profiles.fast]
model = "mini"
`;
    const next = editConfig("toml", withOurs, ["mcp_servers", "imagegen"], { ...ENTRY, env: { NEW: "2" } });
    const cfg = parseToml(next) as Record<string, any>;
    assert.deepEqual(cfg.mcp_servers.imagegen.env, { NEW: "2" });
    assert.equal(cfg.profiles.fast.model, "mini");
    assert.match(next, /# trailing section\n\[profiles\.fast\]/);
    assert.doesNotMatch(next, /OLD/);
    assert.ok(next.indexOf("[mcp_servers.imagegen]") < next.indexOf("[profiles.fast]"));

    const removed = editConfig("toml", next, ["mcp_servers", "imagegen"], undefined);
    assert.equal((parseToml(removed) as Record<string, any>).mcp_servers.imagegen, undefined);
    assert.match(removed, /\[mcp_servers\.other\]/);
    assert.match(removed, /# trailing section/);
    assert.doesNotMatch(removed, /\n\n\n/);
  });

  test("CRLF line endings are preserved", () => {
    const crlf = original.replace(/\n/g, "\r\n");
    const next = editConfig("toml", crlf, ["mcp_servers", "imagegen"], ENTRY);
    assert.doesNotMatch(next.replace(/\r\n/g, ""), /\n/);
  });

  test("a header-like line inside a multi-line string is not treated as a table", () => {
    const tricky = `instructions = """
[mcp_servers.imagegen]
this is prose
"""
`;
    const next = editConfig("toml", tricky, ["mcp_servers", "imagegen"], ENTRY);
    const cfg = parseToml(next) as Record<string, any>;
    assert.match(cfg.instructions, /\[mcp_servers\.imagegen\]\nthis is prose/);
    assert.deepEqual(cfg.mcp_servers.imagegen, ENTRY);
  });

  test("inline tables and dotted keys are refused rather than rewritten", () => {
    assert.throws(() => editConfig("toml", `[mcp_servers]\nimagegen = { command = "x" }\n`, ["mcp_servers", "imagegen"], ENTRY), /inline or with dotted keys/);
    assert.throws(() => editConfig("toml", `mcp_servers.imagegen.command = "x"\n`, ["mcp_servers", "imagegen"], ENTRY), /inline or with dotted keys/);
    assert.throws(() => editConfig("toml", `a = [\n`, ["mcp_servers", "imagegen"], ENTRY), /invalid TOML/);
  });

  test("Windows paths are escaped", () => {
    const next = editConfig("toml", "", ["mcp_servers", "imagegen"], { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\x\\cli.js"] });
    assert.equal((parseToml(next) as Record<string, any>).mcp_servers.imagegen.command, "C:\\Program Files\\nodejs\\node.exe");
  });
});

describe("YAML edits (Goose)", () => {
  const original = `# goose config
GOOSE_PROVIDER: openai # provider
extensions:
  developer:
    enabled: true
    type: builtin # keep
`;
  const goose = { enabled: true, type: "stdio", name: "imagegen", cmd: "/usr/local/bin/node", args: ["/opt/pkg/dist/src/cli.js", "serve"], envs: {}, timeout: 300 };

  test("adds an extension, keeping comments and other extensions", () => {
    const next = editConfig("yaml", original, ["extensions", "imagegen"], goose);
    assert.match(next, /# goose config/);
    assert.match(next, /type: builtin # keep/);
    const cfg = parseYaml(next);
    assert.deepEqual(cfg.extensions.imagegen, goose);
    assert.equal(cfg.extensions.developer.type, "builtin");
    assert.match(next, /args:\n\s+- \/opt\/pkg\/dist\/src\/cli\.js\n\s+- serve/);
  });

  test("null parents, updates, removal and errors", () => {
    const fromNull = editConfig("yaml", "extensions:\n", ["extensions", "imagegen"], goose);
    assert.deepEqual(parseYaml(fromNull).extensions.imagegen, goose);
    const removed = editConfig("yaml", fromNull, ["extensions", "imagegen"], undefined);
    assert.equal(parseYaml(removed)?.extensions?.imagegen, undefined);
    assert.throws(() => editConfig("yaml", "a: [1, 2\n", ["extensions", "imagegen"], goose), /invalid YAML/);
    assert.throws(() => editConfig("yaml", "extensions: [1]\n", ["extensions", "imagegen"], goose), /not a mapping/);
  });
});

test("snippets render the entry under its key path", () => {
  assert.deepEqual(JSON.parse(renderSnippet("json", ["mcpServers", "imagegen"], ENTRY)), { mcpServers: { imagegen: ENTRY } });
  assert.match(renderSnippet("toml", ["mcp_servers", "imagegen"], ENTRY), /^\[mcp_servers\.imagegen\]\n/);
  assert.match(renderSnippet("yaml", ["extensions", "imagegen"], ENTRY), /^extensions:\n  imagegen:\n/);
});
