import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { PACKAGE_ROOT } from "../src/constants.js";
import {
  bumpVersion,
  checkChangelog,
  compareVersions,
  parseChangelog,
  plan,
  prepare,
  promoteUnreleased,
  releaseNotes,
  releaseSummary,
  repositoryUrl,
  sectionBody,
} from "../scripts/release.js";
import { tempDir } from "./helpers/env.js";

const REPO = "https://github.com/acme/widget";

const CHANGELOG = `# Changelog

Intro text.

## [Unreleased]

Faster widgets.

### Added
- A thing.

## [1.2.0] - 2026-09-01

### Fixed
- An older thing.

## [1.1.0] - 2026-08-01

First.

[Unreleased]: ${REPO}/compare/v1.2.0...HEAD
[1.2.0]: ${REPO}/compare/v1.1.0...v1.2.0
[1.1.0]: ${REPO}/releases/tag/v1.1.0
`;

describe("versions", () => {
  test("bumps follow npm version's rules", () => {
    const cases: [string, Parameters<typeof bumpVersion>[1], string][] = [
      ["1.2.3", "patch", "1.2.4"],
      ["1.2.3", "minor", "1.3.0"],
      ["1.2.3", "major", "2.0.0"],
      ["0.2.0", "patch", "0.2.1"],
      ["1.2.3", "prepatch", "1.2.4-rc.0"],
      ["1.2.3", "preminor", "1.3.0-rc.0"],
      ["1.2.3", "premajor", "2.0.0-rc.0"],
      ["1.2.3", "prerelease", "1.2.4-rc.0"],
      ["1.3.0-rc.0", "prerelease", "1.3.0-rc.1"],
      ["1.3.0-beta.2", "prerelease", "1.3.0-rc.0"],
      // Finishing a pre-release: the matching bump drops the pre-release part.
      ["1.2.4-rc.1", "patch", "1.2.4"],
      ["1.3.0-rc.1", "minor", "1.3.0"],
      ["2.0.0-rc.1", "major", "2.0.0"],
      ["1.3.1-rc.0", "minor", "1.4.0"],
    ];
    for (const [from, bump, to] of cases) assert.equal(bumpVersion(from, bump), to, `${from} ${bump}`);
    assert.throws(() => bumpVersion("1.2", "patch"), /not a version/);
  });

  test("SemVer precedence", () => {
    const sorted = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.10.0", "2.0.0"];
    for (let i = 0; i + 1 < sorted.length; i++) {
      assert.ok(compareVersions(sorted[i]!, sorted[i + 1]!) < 0, `${sorted[i]} < ${sorted[i + 1]}`);
      assert.ok(compareVersions(sorted[i + 1]!, sorted[i]!) > 0);
    }
    assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  });

  test("repository URLs", () => {
    assert.equal(repositoryUrl({ repository: { url: "git+https://github.com/acme/widget.git" } }), REPO);
    assert.equal(repositoryUrl({ repository: "github.com:acme/widget" }), REPO);
    assert.throws(() => repositoryUrl({}), /no repository/);
  });
});

describe("changelog", () => {
  test("sections and bodies", () => {
    const cl = parseChangelog(CHANGELOG);
    assert.deepEqual(cl.sections.map((s) => s.name), ["Unreleased", "1.2.0", "1.1.0"]);
    assert.equal(sectionBody(cl, "Unreleased"), "Faster widgets.\n\n### Added\n- A thing.");
    assert.equal(sectionBody(cl, "1.1.0"), "First.", "the last section stops at the links");
    assert.equal(releaseSummary(sectionBody(cl, "Unreleased")!), "Faster widgets");
    assert.equal(releaseSummary("### Added\n- x"), undefined);
    assert.equal(releaseSummary("- x"), undefined);
  });

  test("the repository's own changelog passes the check", async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
    const text = await fs.readFile(path.join(PACKAGE_ROOT, "CHANGELOG.md"), "utf8");
    assert.deepEqual(checkChangelog(text, { repoUrl: repositoryUrl(pkg), packageVersion: pkg.version }), []);
  });

  test("the check catches what would break a release", () => {
    const ok = { repoUrl: REPO, packageVersion: "1.2.0" };
    assert.deepEqual(checkChangelog(CHANGELOG, ok), []);
    const broken = (from: string, to: string) => checkChangelog(CHANGELOG.replace(from, to), ok).join("\n");
    assert.match(broken("## [1.2.0] - 2026-09-01", "## [1.2.0] - 2026-9-1"), /not a valid YYYY-MM-DD date/);
    assert.match(broken("## [1.2.0] - 2026-09-01", "## [1.2.0]"), /has no date/);
    assert.match(broken("## [1.2.0] - 2026-09-01", "## 1.2.0 - 2026-09-01"), /should be "## \[Unreleased\]"/);
    assert.match(broken("## [Unreleased]", "## [1.3.0] - 2026-09-10"), /first section must be/);
    assert.match(broken(`[1.2.0]: ${REPO}/compare/v1.1.0...v1.2.0`, `[1.2.0]: ${REPO}/compare/v1.0.0...v1.2.0`), /\[1\.2\.0\] should link to/);
    assert.match(broken(`[Unreleased]: ${REPO}/compare/v1.2.0...HEAD\n`, ""), /Missing link at the bottom: \[Unreleased\]/);
    assert.match(broken("## [1.1.0] - 2026-08-01", "## [1.3.0] - 2026-08-01"), /newest first/);
    assert.match(checkChangelog(CHANGELOG, { ...ok, packageVersion: "1.2.1" }).join("\n"), /no "## \[1\.2\.1\]" section/);
    assert.deepEqual(checkChangelog(CHANGELOG, { ...ok, packageVersion: "1.3.0-rc.0" }), [], "a pre-release of an unreleased version is fine");
    assert.match(checkChangelog(CHANGELOG, { ...ok, packageVersion: "1.2.0-rc.0" }).join("\n"), /already released/);
  });

  test("promoting [Unreleased] moves the notes and updates the links", () => {
    const next = promoteUnreleased(CHANGELOG, "1.3.0", "2026-09-24", REPO);
    assert.ok(next.includes("## [Unreleased]\n\n## [1.3.0] - 2026-09-24\n\nFaster widgets.\n\n### Added\n- A thing.\n\n## [1.2.0] - 2026-09-01"));
    assert.ok(next.includes(`[Unreleased]: ${REPO}/compare/v1.3.0...HEAD\n[1.3.0]: ${REPO}/compare/v1.2.0...v1.3.0\n[1.2.0]:`));
    assert.deepEqual(checkChangelog(next, { repoUrl: REPO, packageVersion: "1.3.0" }), []);
    // Everything else is untouched.
    assert.equal(next.replace(/## \[1\.3\.0\] - 2026-09-24\n\n/, "").replace(`[Unreleased]: ${REPO}/compare/v1.3.0...HEAD\n[1.3.0]: ${REPO}/compare/v1.2.0...v1.3.0`, `[Unreleased]: ${REPO}/compare/v1.2.0...HEAD`), CHANGELOG);
    const crlf = promoteUnreleased(CHANGELOG.replace(/\n/g, "\r\n"), "1.3.0", "2026-09-24", REPO);
    assert.ok(crlf.includes("\r\n## [1.3.0] - 2026-09-24\r\n"));
    assert.doesNotMatch(crlf, /[^\r]\n/, "CRLF line endings are kept");
    assert.throws(() => promoteUnreleased(CHANGELOG.replace("Faster widgets.\n\n### Added\n- A thing.\n", ""), "1.3.0", "2026-09-24", REPO), /Nothing to release/);
    assert.throws(() => promoteUnreleased(CHANGELOG, "1.2.0", "2026-09-24", REPO), /already has a section/);
  });

  test("the first release links to its tag", () => {
    const first = promoteUnreleased("# Changelog\n\n## [Unreleased]\n\n- Hello.\n", "0.1.0", "2026-01-02", REPO);
    assert.match(first, /\n## \[0\.1\.0\] - 2026-01-02\n\n- Hello\.\n/);
    assert.match(first, new RegExp(`\\[0\\.1\\.0\\]: ${REPO}/releases/tag/v0\\.1\\.0\\n$`));
    assert.deepEqual(checkChangelog(first, { repoUrl: REPO, packageVersion: "0.1.0" }), []);
  });

  test("release notes", () => {
    const stable = releaseNotes({ version: "1.3.0", body: "Faster.", repo: "acme/widget", packageName: "widget" });
    assert.match(stable, /^Faster\.\n\n---\n\n### Install/);
    assert.match(stable, /npx -y widget@1\.3\.0 install/);
    assert.match(stable, /gh attestation verify widget-1\.3\.0\.tgz --repo acme\/widget/);
    assert.doesNotMatch(stable, /pre-release/);
    assert.match(releaseNotes({ version: "1.3.0-rc.0", body: "Faster.", repo: "acme/widget", packageName: "widget" }), /^> \[!NOTE\]\n> A pre-release, published to npm under the `next` tag/);
  });
});

describe("prepare and plan", () => {
  async function repo(version = "1.2.0") {
    const root = await tempDir("release-script-");
    await fs.writeFile(path.join(root, "package.json"), `${JSON.stringify({ name: "widget", version, repository: { type: "git", url: `git+${REPO}.git` } }, null, 2)}\n`);
    await fs.writeFile(path.join(root, "package-lock.json"), `${JSON.stringify({ name: "widget", version, lockfileVersion: 3, packages: { "": { name: "widget", version } } }, null, 2)}\n`);
    await fs.writeFile(path.join(root, "CHANGELOG.md"), CHANGELOG);
    return root;
  }
  const read = async (root: string, file: string) => fs.readFile(path.join(root, file), "utf8");

  test("a stable release bumps both package files and promotes the changelog; plan then accepts the tag", async () => {
    const root = await repo();
    const r = prepare(root, { bump: "minor", date: "2026-09-24" });
    assert.deepEqual([r.previous, r.version, r.prerelease, r.summary], ["1.2.0", "1.3.0", false, "Faster widgets"]);
    assert.equal(JSON.parse(await read(root, "package.json")).version, "1.3.0");
    const lock = JSON.parse(await read(root, "package-lock.json"));
    assert.deepEqual([lock.version, lock.packages[""].version], ["1.3.0", "1.3.0"]);
    assert.match(await read(root, "CHANGELOG.md"), /## \[Unreleased\]\n\n## \[1\.3\.0\] - 2026-09-24\n/);
    assert.match(r.notes, /^Faster widgets\.\n\n### Added\n- A thing\.\n\n---/);

    const p = plan(root, "v1.3.0");
    assert.deepEqual([p.version, p.prerelease, p.npmTag], ["1.3.0", false, "latest"]);
    assert.equal(p.notes, r.notes);
    assert.throws(() => plan(root, "v1.2.0"), /doesn't match package\.json/);
    assert.throws(() => plan(root, "1.3.0"), /look like v1\.2\.3/);
    // Nothing left to release.
    assert.throws(() => prepare(root, { bump: "patch", date: "2026-09-25" }), /Nothing to release/);
  });

  test("a pre-release keeps its notes under [Unreleased] and publishes under next", async () => {
    const root = await repo();
    const r = prepare(root, { bump: "preminor", date: "2026-09-24" });
    assert.equal(r.version, "1.3.0-rc.0");
    assert.equal(await read(root, "CHANGELOG.md"), CHANGELOG);
    const p = plan(root, "v1.3.0-rc.0");
    assert.deepEqual([p.prerelease, p.npmTag], [true, "next"]);
    assert.match(p.notes, /^> \[!NOTE\]/);
    // Finishing it promotes the notes as usual.
    assert.equal(prepare(root, { bump: "minor", date: "2026-09-30" }).version, "1.3.0");
  });

  test("explicit versions must move forward; a broken changelog stops the release early", async () => {
    const root = await repo();
    assert.throws(() => prepare(root, { version: "1.2.0", date: "2026-09-24" }), /not newer/);
    assert.equal(prepare(root, { version: "v2.0.0", date: "2026-09-24" }).version, "2.0.0");
    const broken = await repo();
    await fs.writeFile(path.join(broken, "CHANGELOG.md"), CHANGELOG.replace("2026-09-01", "Sept 1"));
    assert.throws(() => prepare(broken, { bump: "patch", date: "2026-09-24" }), /Fix CHANGELOG\.md first/);
    assert.equal(JSON.parse(await read(broken, "package.json")).version, "1.2.0", "nothing written");
  });
});
