/**
 * Release tooling for the CD pipeline (.github/workflows/prepare-release.yml and release.yml).
 *
 * CHANGELOG.md is the single source of release notes. Changes are described under
 * "## [Unreleased]" as they land. `prepare` promotes that section to "## [X.Y.Z] - date", updates
 * the compare links and bumps package.json and package-lock.json. `plan` validates a release tag
 * and writes its GitHub release notes. `check` lints the changelog on every CI run, so a release
 * never fails on a formatting slip.
 *
 *   node dist/scripts/release.js check
 *   node dist/scripts/release.js prepare --bump patch [--version X.Y.Z] [--notes FILE]
 *   node dist/scripts/release.js plan --tag vX.Y.Z [--notes FILE]
 *
 * With GITHUB_OUTPUT set, `prepare` and `plan` also write version, tag, prerelease, npm-tag and
 * summary outputs for the workflow.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export class ReleaseError extends Error {
  override name = "ReleaseError";
}

// ---------------------------------------------------------------------------------------------
// Versions: SemVer 2.0.0 without build metadata.
// ---------------------------------------------------------------------------------------------

export interface Version {
  major: number;
  minor: number;
  patch: number;
  prerelease: (string | number)[];
}

const IDENT = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const VERSION_RE = new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${IDENT}(?:\\.${IDENT})*))?$`);

export function isVersion(text: string): boolean {
  return VERSION_RE.test(text);
}

export function parseVersion(text: string): Version {
  const m = VERSION_RE.exec(text);
  if (!m) throw new ReleaseError(`"${text}" is not a version (expected X.Y.Z or X.Y.Z-rc.N)`);
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [],
  };
}

export function formatVersion(v: Version): string {
  return `${v.major}.${v.minor}.${v.patch}${v.prerelease.length > 0 ? `-${v.prerelease.join(".")}` : ""}`;
}

export function isPrerelease(version: string): boolean {
  return parseVersion(version).prerelease.length > 0;
}

/** SemVer precedence: negative if a < b, 0 if equal, positive if a > b. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (const k of ["major", "minor", "patch"] as const) if (x[k] !== y[k]) return x[k] - y[k];
  if (x.prerelease.length === 0 || y.prerelease.length === 0) return (x.prerelease.length === 0 ? 1 : 0) - (y.prerelease.length === 0 ? 1 : 0);
  for (let i = 0; i < Math.max(x.prerelease.length, y.prerelease.length); i++) {
    const p = x.prerelease[i];
    const q = y.prerelease[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === "number" && typeof q === "number") return p - q;
    if (typeof p === "number") return -1;
    if (typeof q === "number") return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

export const BUMPS = ["patch", "minor", "major", "prepatch", "preminor", "premajor", "prerelease"] as const;
export type Bump = (typeof BUMPS)[number];

/** The next version, with the same rules as `npm version <bump> --preid <preid>`. */
export function bumpVersion(current: string, bump: Bump, preid = "rc"): string {
  const v = parseVersion(current);
  const pre = v.prerelease.length > 0;
  const next = (major: number, minor: number, patch: number, prerelease: (string | number)[] = []) =>
    formatVersion({ major, minor, patch, prerelease });
  switch (bump) {
    case "major":
      // 2.0.0-rc.1 → 2.0.0, 1.4.2 → 2.0.0
      return pre && v.minor === 0 && v.patch === 0 ? next(v.major, 0, 0) : next(v.major + 1, 0, 0);
    case "minor":
      return pre && v.patch === 0 ? next(v.major, v.minor, 0) : next(v.major, v.minor + 1, 0);
    case "patch":
      return pre ? next(v.major, v.minor, v.patch) : next(v.major, v.minor, v.patch + 1);
    case "premajor":
      return next(v.major + 1, 0, 0, [preid, 0]);
    case "preminor":
      return next(v.major, v.minor + 1, 0, [preid, 0]);
    case "prepatch":
      return next(v.major, v.minor, v.patch + 1, [preid, 0]);
    case "prerelease": {
      if (!pre) return next(v.major, v.minor, v.patch + 1, [preid, 0]);
      const last = v.prerelease.at(-1);
      if (v.prerelease[0] === preid && typeof last === "number") return next(v.major, v.minor, v.patch, [...v.prerelease.slice(0, -1), last + 1]);
      return next(v.major, v.minor, v.patch, [preid, 0]);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// CHANGELOG.md (Keep a Changelog 1.1.0)
// ---------------------------------------------------------------------------------------------

export interface Section {
  /** "Unreleased" or a version. */
  name: string;
  date?: string;
  /** Line index of the "## [...]" heading. */
  heading: number;
  /** Line index where the section ends (exclusive). */
  end: number;
}

export interface Changelog {
  lines: string[];
  eol: string;
  sections: Section[];
  /** Section headings that don't follow the "## [X.Y.Z] - YYYY-MM-DD" form: [line index, text]. */
  malformed: [number, string][];
  /** Link reference definitions for sections, e.g. "[0.2.0]: https://…/compare/v0.1.2...v0.2.0". */
  links: Map<string, { line: number; url: string }>;
}

const HEADING_RE = /^## \[([^\]]+)\](?: - (\S+))?\s*$/;
const LINK_RE = /^\[([^\]]+)\]:\s+(\S+)\s*$/;

export function parseChangelog(text: string): Changelog {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const sections: Section[] = [];
  const malformed: [number, string][] = [];
  const links = new Map<string, { line: number; url: string }>();
  const h2: number[] = [];
  lines.forEach((line, i) => {
    if (line.startsWith("## ")) {
      h2.push(i);
      const h = HEADING_RE.exec(line);
      if (h) sections.push({ name: h[1]!, ...(h[2] ? { date: h[2] } : {}), heading: i, end: lines.length });
      else malformed.push([i, line]);
    }
    const l = LINK_RE.exec(line);
    if (l && (l[1] === "Unreleased" || isVersion(l[1]!))) links.set(l[1]!, { line: i, url: l[2]! });
  });
  // A section runs to the next "## " heading, or to the first section link below it.
  const linkLines = [...links.values()].map((l) => l.line);
  for (const s of sections) {
    const nextHeading = h2.find((i) => i > s.heading) ?? lines.length;
    const firstLink = Math.min(...linkLines.filter((i) => i > s.heading), lines.length);
    s.end = Math.min(nextHeading, firstLink);
  }
  return { lines, eol, sections, malformed, links };
}

/** A section's text without surrounding blank lines. */
export function sectionBody(cl: Changelog, name: string): string | undefined {
  const s = cl.sections.find((x) => x.name === name);
  if (!s) return undefined;
  const body = cl.lines.slice(s.heading + 1, s.end);
  while (body.length > 0 && body[0]!.trim() === "") body.shift();
  while (body.length > 0 && body.at(-1)!.trim() === "") body.pop();
  return body.join("\n");
}

/** "https://github.com/owner/repo" from package.json's repository field. */
export function repositoryUrl(pkg: { repository?: string | { url?: string } }): string {
  const raw = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  if (!raw) throw new ReleaseError("package.json has no repository URL");
  const m = /github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?(?:#.*)?$/.exec(raw);
  if (!m) throw new ReleaseError(`package.json's repository (${raw}) is not a GitHub repository`);
  return `https://github.com/${m[1]}/${m[2]}`;
}

const compareUrl = (repo: string, from: string, to: string) => `${repo}/compare/${from}...${to}`;

function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

/** Problems that would break a release or its notes. Empty when the changelog is fine. */
export function checkChangelog(text: string, options: { repoUrl: string; packageVersion?: string }): string[] {
  const errors: string[] = [];
  const cl = parseChangelog(text);
  const at = (line: number) => `CHANGELOG.md:${line + 1}`;
  for (const [line, heading] of cl.malformed) errors.push(`${at(line)}: "${heading}" should be "## [Unreleased]" or "## [X.Y.Z] - YYYY-MM-DD"`);
  if (cl.sections[0]?.name !== "Unreleased") errors.push('The first section must be "## [Unreleased]", where upcoming changes are described.');
  if (cl.sections.filter((s) => s.name === "Unreleased").length > 1) errors.push('There is more than one "## [Unreleased]" section.');

  const released = cl.sections.filter((s) => s.name !== "Unreleased");
  const seen = new Set<string>();
  for (const s of released) {
    if (!isVersion(s.name)) errors.push(`${at(s.heading)}: "${s.name}" is not a version.`);
    else if (isPrerelease(s.name)) errors.push(`${at(s.heading)}: ${s.name} is a pre-release; pre-releases use the [Unreleased] notes and get no section of their own.`);
    if (!s.date) errors.push(`${at(s.heading)}: ${s.name} has no date ("## [${s.name}] - YYYY-MM-DD").`);
    else if (!isValidDate(s.date)) errors.push(`${at(s.heading)}: "${s.date}" is not a valid YYYY-MM-DD date.`);
    if (seen.has(s.name)) errors.push(`${at(s.heading)}: ${s.name} appears twice.`);
    seen.add(s.name);
  }
  const ordered = released.filter((s) => isVersion(s.name));
  for (let i = 0; i + 1 < ordered.length; i++) {
    const [newer, older] = [ordered[i]!, ordered[i + 1]!];
    if (compareVersions(newer.name, older.name) <= 0) errors.push(`${at(older.heading)}: versions must be listed newest first (${older.name} is below ${newer.name}).`);
    if (newer.date && older.date && isValidDate(newer.date) && isValidDate(older.date) && newer.date < older.date) {
      errors.push(`${at(newer.heading)}: ${newer.name} is dated before ${older.name}.`);
    }
  }

  // Compare links: [Unreleased] from the latest release to HEAD, each release from its predecessor.
  const expected = new Map<string, string>();
  if (ordered[0]) expected.set("Unreleased", compareUrl(options.repoUrl, `v${ordered[0].name}`, "HEAD"));
  ordered.forEach((s, i) => {
    const older = ordered[i + 1];
    expected.set(s.name, older ? compareUrl(options.repoUrl, `v${older.name}`, `v${s.name}`) : `${options.repoUrl}/releases/tag/v${s.name}`);
  });
  for (const [label, url] of expected) {
    const link = cl.links.get(label);
    if (!link) errors.push(`Missing link at the bottom: [${label}]: ${url}`);
    else if (link.url !== url) errors.push(`${at(link.line)}: [${label}] should link to ${url}`);
  }
  for (const [label, link] of cl.links) {
    if (!cl.sections.some((s) => s.name === label)) errors.push(`${at(link.line)}: link [${label}] has no section.`);
  }

  if (options.packageVersion) {
    const pv = options.packageVersion;
    if (!isVersion(pv)) errors.push(`package.json's version "${pv}" is not a version.`);
    else if (!isPrerelease(pv)) {
      if (!seen.has(pv)) errors.push(`package.json is at ${pv}, but CHANGELOG.md has no "## [${pv}]" section.`);
    } else {
      const base = pv.replace(/-.*$/, "");
      const later = ordered.find((s) => compareVersions(s.name, base) >= 0);
      if (later) errors.push(`package.json is at pre-release ${pv}, but ${later.name} is already released.`);
    }
  }
  return errors;
}

/** Move the [Unreleased] notes into a new "## [version] - date" section and update the links. */
export function promoteUnreleased(text: string, version: string, date: string, repoUrl: string): string {
  const cl = parseChangelog(text);
  const unreleased = cl.sections.find((s) => s.name === "Unreleased");
  if (!unreleased) throw new ReleaseError('CHANGELOG.md has no "## [Unreleased]" section.');
  if (!sectionBody(cl, "Unreleased")) {
    throw new ReleaseError('Nothing to release: "## [Unreleased]" in CHANGELOG.md is empty. Describe the changes there first.');
  }
  if (cl.sections.some((s) => s.name === version)) throw new ReleaseError(`CHANGELOG.md already has a section for ${version}.`);
  if (isPrerelease(version)) throw new ReleaseError("Pre-releases keep their notes under [Unreleased].");
  const previous = cl.sections.find((s) => s.name !== "Unreleased" && isVersion(s.name))?.name;
  const lines = [...cl.lines];

  // Links live below the sections, so edit them first: the heading insert shifts later lines.
  const versionLink = previous ? compareUrl(repoUrl, `v${previous}`, `v${version}`) : `${repoUrl}/releases/tag/v${version}`;
  const unreleasedLink = cl.links.get("Unreleased");
  const newLinks = [`[Unreleased]: ${compareUrl(repoUrl, `v${version}`, "HEAD")}`, `[${version}]: ${versionLink}`];
  if (unreleasedLink) lines.splice(unreleasedLink.line, 1, ...newLinks);
  else {
    while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
    lines.push("", ...newLinks, "");
  }

  const heading = [``, `## [${version}] - ${date}`];
  if (lines[unreleased.heading + 1]?.trim() !== "") heading.push("");
  lines.splice(unreleased.heading + 1, 0, ...heading);
  return lines.join(cl.eol);
}

/** The first line of a section when it's a one-line summary (not a list or subheading). */
export function releaseSummary(body: string): string | undefined {
  const first = body.split("\n")[0]?.trim();
  if (!first || /^([-*+>#|]|\d+\.)/.test(first) || first.length > 120) return undefined;
  const paragraph = body.split(/\n\s*\n/)[0]!;
  return paragraph.includes("\n") ? undefined : first.replace(/\.$/, "");
}

/** GitHub release notes: the changelog section plus how to install and verify this version. */
export function releaseNotes(o: { version: string; body: string; repo: string; packageName: string }): string {
  const tag = `v${o.version}`;
  const base = `https://github.com/${o.repo}`;
  const lines: string[] = [];
  if (isPrerelease(o.version)) {
    lines.push(
      "> [!NOTE]",
      `> A pre-release, published to npm under the \`next\` tag. Try it with \`npx -y ${o.packageName}@next install\`; \`npx -y ${o.packageName} install\` keeps installing the latest stable release. These changes are listed under [Unreleased] in the changelog until the final release.`,
      "",
    );
  }
  lines.push(
    o.body,
    "",
    "---",
    "",
    "### Install",
    "",
    "```bash",
    `npx -y ${o.packageName}@${o.version} install`,
    "```",
    "",
    `Or install it globally with \`npm install --global ${o.packageName}@${o.version}\`, or from the tarball attached below: \`npm install --global ${base}/releases/download/${tag}/${o.packageName}-${o.version}.tgz\`. Then follow the [quick start](${base}/blob/${tag}/README.md#quick-start). \`${o.packageName}.tgz\` is the same package under a stable name, for \`releases/latest/download/\` links.`,
    "",
    "### Verify",
    "",
    `The npm package and the tarballs below are the same file, built from this tag by the [release workflow](${base}/blob/${tag}/.github/workflows/release.yml) with signed build provenance. \`SHA256SUMS\` lists their checksums.`,
    "",
    "```bash",
    `gh attestation verify ${o.packageName}-${o.version}.tgz --repo ${o.repo}`,
    `npm audit signatures   # in a project that depends on ${o.packageName}`,
    "```",
    "",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

interface PackageJson {
  name: string;
  version: string;
  repository?: string | { url?: string };
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function setOutputs(outputs: Record<string, string>): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  fs.appendFileSync(file, Object.entries(outputs).map(([k, v]) => `${k}=${v.replace(/[\r\n]+/g, " ")}\n`).join(""));
}

function ownerRepo(repoUrl: string): string {
  return repoUrl.replace(/^https:\/\/github\.com\//, "");
}

export function check(root: string): string[] {
  const pkg = readJson<PackageJson>(path.join(root, "package.json"));
  return checkChangelog(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), { repoUrl: repositoryUrl(pkg), packageVersion: pkg.version });
}

export interface PrepareResult {
  version: string;
  previous: string;
  prerelease: boolean;
  notes: string;
  summary?: string;
}

/** Bump the version and promote the changelog in `root` (package.json, package-lock.json, CHANGELOG.md). */
export function prepare(root: string, o: { bump?: Bump; version?: string; date: string; preid?: string }): PrepareResult {
  const pkgFile = path.join(root, "package.json");
  const lockFile = path.join(root, "package-lock.json");
  const changelogFile = path.join(root, "CHANGELOG.md");
  const pkg = readJson<PackageJson & Record<string, unknown>>(pkgFile);
  const repoUrl = repositoryUrl(pkg);
  const changelog = fs.readFileSync(changelogFile, "utf8");
  const before = checkChangelog(changelog, { repoUrl, packageVersion: pkg.version });
  if (before.length > 0) throw new ReleaseError(`Fix CHANGELOG.md first:\n- ${before.join("\n- ")}`);

  let version: string;
  if (o.version) {
    version = o.version.replace(/^v/, "");
    parseVersion(version);
    if (compareVersions(version, pkg.version) <= 0) throw new ReleaseError(`${version} is not newer than the current version, ${pkg.version}.`);
  } else {
    version = bumpVersion(pkg.version, o.bump ?? "patch", o.preid);
  }
  const prerelease = isPrerelease(version);
  const next = prerelease ? changelog : promoteUnreleased(changelog, version, o.date, repoUrl);
  const body = sectionBody(parseChangelog(next), prerelease ? "Unreleased" : version) ?? "";
  if (!body) throw new ReleaseError('Nothing to release: "## [Unreleased]" in CHANGELOG.md is empty. Describe the changes there first.');
  const after = checkChangelog(next, { repoUrl, packageVersion: version });
  if (after.length > 0) throw new ReleaseError(`The updated CHANGELOG.md doesn't check out:\n- ${after.join("\n- ")}`);

  const previous = pkg.version;
  writeJson(pkgFile, { ...pkg, version });
  if (fs.existsSync(lockFile)) {
    const lock = readJson<{ version?: string; packages?: Record<string, { version?: string }> }>(lockFile);
    lock.version = version;
    const rootPackage = lock.packages?.[""];
    if (rootPackage) rootPackage.version = version;
    writeJson(lockFile, lock);
  }
  fs.writeFileSync(changelogFile, next);
  const summary = releaseSummary(body);
  return {
    version,
    previous,
    prerelease,
    notes: releaseNotes({ version, body, repo: ownerRepo(repoUrl), packageName: pkg.name }),
    ...(summary ? { summary } : {}),
  };
}

export interface PlanResult {
  version: string;
  prerelease: boolean;
  npmTag: "latest" | "next";
  notes: string;
  summary?: string;
}

/** Validate a release tag against package.json and CHANGELOG.md, and build its release notes. */
export function plan(root: string, tag: string): PlanResult {
  if (!/^v/.test(tag)) throw new ReleaseError(`Release tags look like v1.2.3 (got "${tag}").`);
  const version = tag.slice(1);
  parseVersion(version);
  const pkg = readJson<PackageJson>(path.join(root, "package.json"));
  if (pkg.version !== version) throw new ReleaseError(`Tag ${tag} doesn't match package.json, which is at ${pkg.version}.`);
  const repoUrl = repositoryUrl(pkg);
  const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  const errors = checkChangelog(changelog, { repoUrl, packageVersion: version });
  if (errors.length > 0) throw new ReleaseError(`CHANGELOG.md isn't ready for ${version}:\n- ${errors.join("\n- ")}`);
  const prerelease = isPrerelease(version);
  const body = sectionBody(parseChangelog(changelog), prerelease ? "Unreleased" : version) ?? "";
  if (!body) throw new ReleaseError(prerelease ? 'Pre-release notes come from "## [Unreleased]", which is empty.' : `The ${version} section of CHANGELOG.md is empty.`);
  const summary = releaseSummary(body);
  return {
    version,
    prerelease,
    npmTag: prerelease ? "next" : "latest",
    notes: releaseNotes({ version, body, repo: ownerRepo(repoUrl), packageName: pkg.name }),
    ...(summary ? { summary } : {}),
  };
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  const root = process.cwd();
  const { values } = parseArgs({
    args: rest,
    options: {
      bump: { type: "string" },
      version: { type: "string" },
      preid: { type: "string" },
      date: { type: "string" },
      tag: { type: "string" },
      notes: { type: "string" },
    },
    strict: true,
  });
  switch (command) {
    case "check": {
      const errors = check(root);
      for (const e of errors) console.error(process.env.GITHUB_ACTIONS ? `::error file=CHANGELOG.md::${e}` : `✗ ${e}`);
      if (errors.length === 0) console.log("✓ CHANGELOG.md is ready for release tooling");
      return errors.length === 0 ? 0 : 1;
    }
    case "prepare": {
      const bump = (values.bump ?? "patch") as Bump;
      if (!BUMPS.includes(bump)) throw new ReleaseError(`--bump must be one of ${BUMPS.join(", ")} (got "${bump}").`);
      const date = values.date ?? new Date().toISOString().slice(0, 10);
      if (!isValidDate(date)) throw new ReleaseError(`--date must be YYYY-MM-DD (got "${date}").`);
      const r = prepare(root, { bump, date, ...(values.version ? { version: values.version } : {}), ...(values.preid ? { preid: values.preid } : {}) });
      if (values.notes) fs.writeFileSync(values.notes, r.notes);
      setOutputs({ version: r.version, tag: `v${r.version}`, previous: r.previous, prerelease: String(r.prerelease), "npm-tag": r.prerelease ? "next" : "latest", summary: r.summary ?? "" });
      console.log(`${r.previous} → ${r.version}${r.prerelease ? " (pre-release)" : ""}${r.summary ? `: ${r.summary}` : ""}`);
      return 0;
    }
    case "plan": {
      if (!values.tag) throw new ReleaseError("plan needs --tag vX.Y.Z");
      const r = plan(root, values.tag);
      if (values.notes) fs.writeFileSync(values.notes, r.notes);
      setOutputs({ version: r.version, prerelease: String(r.prerelease), "npm-tag": r.npmTag, summary: r.summary ?? "" });
      console.log(`Releasing ${r.version}${r.prerelease ? " as a pre-release (npm tag next)" : ""}${r.summary ? `: ${r.summary}` : ""}`);
      return 0;
    }
    default:
      console.error("Usage: release.js check | prepare --bump <patch|minor|major|prepatch|preminor|premajor|prerelease> [--version X.Y.Z] [--notes FILE] | plan --tag vX.Y.Z [--notes FILE]");
      return 2;
  }
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(process.env.GITHUB_ACTIONS ? `::error::${message.replace(/\n/g, "%0A")}` : `✗ ${message}`);
    process.exitCode = 1;
  }
}
