/**
 * Checks a version on the npm registry after the release pipeline published it:
 *
 *   node dist/scripts/verify-published.js --version X.Y.Z [--dist-tag latest] [--wait 20] [--provenance] [--integrity]
 *
 * --wait <minutes>  Waits until npm serves the version in both its full metadata and the
 *                   abbreviated metadata that npm install and npx read. The abbreviated copy can
 *                   lag minutes behind, and that's when installs fail with ETARGET.
 * --provenance      Its SLSA provenance must name this repository's release workflow, the vX.Y.Z
 *                   tag and that tag's commit, and cover the exact bytes npm serves.
 * --integrity       The npm tarball must be byte-identical to the one attached to the GitHub release.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { repositoryUrl } from "./release.js";

const REGISTRY = "https://registry.npmjs.org";
/** What npm install and npx ask for. */
const INSTALL_ACCEPT = "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";

class VerifyError extends Error {
  override name = "VerifyError";
}

interface Packument {
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, { dist?: { integrity?: string; tarball?: string } }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (line: string) => console.log(line);

function summary(line: string): void {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { headers: { "user-agent": "codex-imagegen-mcp-release-verify", ...headers } });
  if (!res.ok) throw new VerifyError(`GET ${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function waitForRegistry(name: string, version: string, distTag: string | undefined, minutes: number): Promise<Packument> {
  const started = Date.now();
  let last = "";
  for (let attempt = 1; ; attempt++) {
    const docs = await Promise.all([
      getJson<Packument>(`${REGISTRY}/${name}`, { accept: "application/json" }).catch(() => undefined),
      getJson<Packument>(`${REGISTRY}/${name}`, { accept: INSTALL_ACCEPT }).catch(() => undefined),
    ]);
    const state = docs.map((doc, i) => {
      const which = i === 0 ? "full" : "install";
      if (!doc?.versions?.[version]) return `${which} metadata lacks ${version}`;
      if (distTag && doc["dist-tags"]?.[distTag] !== version) return `${which} metadata has ${distTag} → ${doc["dist-tags"]?.[distTag]}`;
      return "";
    });
    const pending = state.filter(Boolean).join(", ");
    const elapsed = Math.round((Date.now() - started) / 1000);
    if (!pending) {
      log(`✓ npm serves ${name}@${version}${distTag ? ` as ${distTag}` : ""} in both metadata documents (waited ${elapsed}s)`);
      summary(`- ✅ npm serves \`${name}@${version}\`${distTag ? ` as \`${distTag}\`` : ""} to \`npm install\` and \`npx\` (after ${elapsed}s)`);
      return docs[0]!;
    }
    if (Date.now() - started > minutes * 60_000) throw new VerifyError(`After ${minutes} min npm still doesn't serve ${name}@${version}: ${pending}`);
    if (pending !== last || attempt % 8 === 0) log(`… ${pending} (${elapsed}s)`);
    last = pending;
    await sleep(15_000);
  }
}

function integrityToHex(integrity: string): string {
  const m = /^sha512-(.+)$/.exec(integrity);
  if (!m) throw new VerifyError(`unexpected integrity ${integrity}`);
  return Buffer.from(m[1]!, "base64").toString("hex");
}

async function tagCommit(repo: string, tag: string): Promise<string> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const res = await fetch(`https://api.github.com/repos/${repo}/commits/${tag}`, {
    headers: { accept: "application/vnd.github.sha", "user-agent": "codex-imagegen-mcp-release-verify", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) throw new VerifyError(`Can't look up ${tag} on GitHub: HTTP ${res.status}`);
  return (await res.text()).trim();
}

interface Statement {
  subject: { name: string; digest: { sha512?: string } }[];
  predicate: {
    buildDefinition?: {
      externalParameters?: { workflow?: { ref?: string; repository?: string; path?: string } };
      resolvedDependencies?: { uri?: string; digest?: { gitCommit?: string } }[];
    };
  };
}

async function verifyProvenance(name: string, version: string, repoUrl: string, integrity: string, commit: string): Promise<void> {
  const { attestations } = await getJson<{ attestations: { predicateType: string; bundle: { dsseEnvelope?: { payload: string } } }[] }>(
    `${REGISTRY}/-/npm/v1/attestations/${name}@${version}`,
  );
  const slsa = attestations.find((a) => a.predicateType === "https://slsa.dev/provenance/v1");
  if (!slsa?.bundle.dsseEnvelope) throw new VerifyError(`${name}@${version} has no SLSA provenance on npm`);
  const statement = JSON.parse(Buffer.from(slsa.bundle.dsseEnvelope.payload, "base64").toString("utf8")) as Statement;
  const tag = `v${version}`;
  const workflow = statement.predicate.buildDefinition?.externalParameters?.workflow;
  const source = statement.predicate.buildDefinition?.resolvedDependencies?.[0];
  const subject = statement.subject.find((s) => s.name === `pkg:npm/${name}@${version}`);
  const checks: [string, unknown, unknown][] = [
    ["repository", workflow?.repository, repoUrl],
    ["workflow", workflow?.path, ".github/workflows/release.yml"],
    ["ref", workflow?.ref, `refs/tags/${tag}`],
    ["commit", source?.digest?.gitCommit, commit],
    ["tarball sha512", subject?.digest.sha512, integrityToHex(integrity)],
  ];
  const wrong = checks.filter(([, actual, wanted]) => actual !== wanted);
  if (wrong.length > 0) throw new VerifyError(`Provenance mismatch: ${wrong.map(([what, actual, wanted]) => `${what} is ${String(actual)}, expected ${String(wanted)}`).join("; ")}`);
  log(`✓ npm provenance: built by release.yml from ${tag} (${commit.slice(0, 7)}), covering the exact tarball npm serves`);
  summary(`- ✅ npm provenance: built by \`release.yml\` from \`${tag}\` (\`${commit.slice(0, 7)}\`), covering the exact tarball npm serves`);
}

async function verifyIntegrity(name: string, version: string, repo: string, integrity: string): Promise<void> {
  const url = `https://github.com/${repo}/releases/download/v${version}/${name}-${version}.tgz`;
  const res = await fetch(url, { headers: { "user-agent": "codex-imagegen-mcp-release-verify" } });
  if (!res.ok) throw new VerifyError(`GET ${url}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const ours = `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`;
  if (ours !== integrity) throw new VerifyError(`The GitHub release tarball (${ours.slice(0, 24)}…) differs from npm's (${integrity.slice(0, 24)}…)`);
  log(`✓ The GitHub release tarball and the npm package are byte-identical (${bytes.length} bytes, ${integrity.slice(0, 20)}…)`);
  summary(`- ✅ The GitHub release tarball and the npm package are byte-identical (\`${integrity.slice(0, 20)}…\`)`);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      version: { type: "string" },
      "dist-tag": { type: "string" },
      wait: { type: "string" },
      provenance: { type: "boolean" },
      integrity: { type: "boolean" },
      commit: { type: "string" },
    },
    strict: true,
  });
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { name: string; repository?: string | { url?: string } };
  const version = values.version?.replace(/^v/, "");
  if (!version) {
    console.error("Usage: verify-published.js --version X.Y.Z [--dist-tag latest] [--wait MINUTES] [--provenance] [--integrity] [--commit SHA]");
    return 2;
  }
  const repoUrl = repositoryUrl(pkg);
  const repo = repoUrl.replace("https://github.com/", "");
  try {
    const doc = await waitForRegistry(pkg.name, version, values["dist-tag"], Number(values.wait ?? "0"));
    const integrity = doc.versions?.[version]?.dist?.integrity;
    if (!integrity) throw new VerifyError(`npm lists no integrity for ${pkg.name}@${version}`);
    if (values.provenance) await verifyProvenance(pkg.name, version, repoUrl, integrity, values.commit ?? (await tagCommit(repo, `v${version}`)));
    if (values.integrity) await verifyIntegrity(pkg.name, version, repo, integrity);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(process.env.GITHUB_ACTIONS ? `::error title=Published package check failed::${message}` : `✗ ${message}`);
    return 1;
  }
}

process.exitCode = await main();
