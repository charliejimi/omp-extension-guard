import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	ALLOWLIST_SCHEMA,
	type AllowlistEntry,
	AllowlistError,
	DigestError,
	approvalStatus,
	buildAllowlist,
	digestUnit,
	loadTrustedAllowlists,
	parseAllowlist,
	parseApprovals,
	signAllowlist,
	unitScripts,
	verifyAllowlistSignature,
} from "../src/allowlist";
import type { Unit } from "../src/inventory";
import { removeTemps, tempDir } from "./fixtures";
import { KEYS, OTHER_KEYS, allowlistOf, writeAllowlist, writePublicKey } from "./helpers";

afterAll(removeTemps);

const DIGEST = "sha256:".padEnd(71, "a");

function tree(files: Record<string, string>, order: string[] = Object.keys(files)): string {
	const dir = tempDir("eg-unit-");
	for (const rel of order) {
		fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), files[rel]!);
	}
	return dir;
}

function entry(extra: Partial<AllowlistEntry> = {}): AllowlistEntry {
	return {
		kind: "extension",
		key: "project:.omp/extensions/dx-helper",
		digest: DIGEST,
		scripts: {},
		source: "https://example.test/dx-helper",
		version: "1.2.0",
		reviewer: "platform-team",
		...extra,
	};
}

function unit(dir: string, extra: Partial<Unit> = {}): Unit {
	return {
		kind: "extension",
		key: "project:.omp/extensions/dx-helper",
		path: dir,
		level: "project",
		entries: [],
		digest: digestUnit(dir),
		scripts: unitScripts(dir),
		...extra,
	};
}

describe("digestUnit", () => {
	const files = { "index.ts": "export default () => {}\n", "lib/util.ts": "export const x = 1;\n", "README.md": "hi\n" };

	it("does not depend on the order the files were created in", () => {
		expect(digestUnit(tree(files, ["index.ts", "lib/util.ts", "README.md"]))).toBe(
			digestUnit(tree(files, ["README.md", "lib/util.ts", "index.ts"])),
		);
	});

	it("changes when content, the executable bit, a name, or the file set changes", () => {
		const base = digestUnit(tree(files));
		const content = tree(files);
		fs.writeFileSync(path.join(content, "lib/util.ts"), "export const x = 2;\n");
		const exec = tree(files);
		fs.chmodSync(path.join(exec, "index.ts"), 0o755);
		const renamed = tree({ ...files });
		fs.renameSync(path.join(renamed, "README.md"), path.join(renamed, "README.txt"));
		const added = tree({ ...files, "extra.ts": "" });
		const digests = [base, digestUnit(content), digestUnit(exec), digestUnit(renamed), digestUnit(added)];
		expect(new Set(digests).size).toBe(digests.length);
	});

	it("pins a single-file unit to its content", () => {
		const dir = tree({ "solo.ts": "a\n", "same.ts": "a\n", "other.ts": "b\n" });
		expect(digestUnit(path.join(dir, "solo.ts"))).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(digestUnit(path.join(dir, "solo.ts"))).toBe(digestUnit(path.join(dir, "same.ts")));
		expect(digestUnit(path.join(dir, "solo.ts"))).not.toBe(digestUnit(path.join(dir, "other.ts")));
	});

	it("hashes what a symlinked unit points at", () => {
		const dir = tree(files);
		const link = path.join(tempDir("eg-link-"), "dx-helper");
		fs.symlinkSync(dir, link);
		expect(digestUnit(link)).toBe(digestUnit(dir));
	});

	it("records a symlink that stays inside the unit and refuses one that leaves it", () => {
		const inside = tree(files);
		fs.symlinkSync("lib/util.ts", path.join(inside, "alias.ts"));
		const before = digestUnit(inside);
		fs.rmSync(path.join(inside, "alias.ts"));
		fs.symlinkSync("index.ts", path.join(inside, "alias.ts"));
		expect(digestUnit(inside)).not.toBe(before);

		const outside = tempDir("eg-outside-");
		fs.writeFileSync(path.join(outside, "evil.ts"), "evil\n");
		const relative = tree(files);
		fs.symlinkSync(path.relative(path.join(relative, "lib"), path.join(outside, "evil.ts")), path.join(relative, "lib/evil.ts"));
		expect(() => digestUnit(relative)).toThrow(DigestError);
		const absolute = tree(files);
		fs.symlinkSync(path.join(outside, "evil.ts"), path.join(absolute, "evil.ts"));
		expect(() => digestUnit(absolute)).toThrow(/leaves the unit/);
	});

	it("refuses special files and units beyond the limits", () => {
		const fifo = tree(files);
		Bun.spawnSync(["mkfifo", path.join(fifo, "pipe")]);
		expect(() => digestUnit(fifo)).toThrow(/special file/);
		expect(() => digestUnit(tree(files), { maxFiles: 2 })).toThrow(/more than 2 files/);
	});
});

describe("unitScripts", () => {
	it("lists files under scripts/ and executable files with their digests, and nothing for a file unit", () => {
		const dir = tree({ "index.ts": "", "scripts/setup.sh": "echo setup\n", "bin/run": "#!/bin/sh\n", "lib/a.ts": "" });
		fs.chmodSync(path.join(dir, "bin/run"), 0o755);
		const scripts = unitScripts(dir);
		expect(Object.keys(scripts)).toEqual(["bin/run", "scripts/setup.sh"]);
		expect(scripts["scripts/setup.sh"]).toBe(digestUnit(path.join(dir, "scripts/setup.sh")));
		expect(unitScripts(path.join(dir, "index.ts"))).toEqual({});
	});
});

describe("parseAllowlist", () => {
	const valid = () => allowlistOf([entry()]);
	const text = (value: unknown) => JSON.stringify(value);

	it("accepts a valid list and keeps version or commit", () => {
		const list = parseAllowlist(text(allowlistOf([entry(), entry({ key: "user:extensions/x.ts", version: undefined, commit: "0123abc" })])));
		expect(list.items.map(item => [item.key, item.version, item.commit])).toEqual([
			["project:.omp/extensions/dx-helper", "1.2.0", undefined],
			["user:extensions/x.ts", undefined, "0123abc"],
		]);
	});

	it.each([
		["not JSON", "{", /not valid JSON/],
		["a wrong schema", text({ ...valid(), schema: "other@1" }), /schema must be/],
		["an expired list", text({ ...valid(), expiresAt: "2001-01-01T00:00:00Z" }), /expired/],
		["an unknown kind", text(allowlistOf([entry({ kind: "macro" as never })])), /kind/],
		["a key without a scope", text(allowlistOf([entry({ key: ".omp/extensions/x" })])), /key/],
		["a key that climbs out of its scope", text(allowlistOf([entry({ key: "project:../x" })])), /key/],
		["a malformed digest", text(allowlistOf([entry({ digest: "md5:abc" })])), /digest/],
		["no reviewer", text(allowlistOf([entry({ reviewer: " " })])), /reviewer is missing/],
		["no source", text(allowlistOf([entry({ source: "" })])), /source is missing/],
		["neither version nor commit", text(allowlistOf([entry({ version: undefined })])), /version or commit/],
		["a duplicate key", text(allowlistOf([entry(), entry()])), /duplicate/],
		["a key both approved and revoked", text({ ...valid(), revoked: ["project:.omp/extensions/dx-helper"] }), /both approved and revoked/],
		["a script path outside the unit", text(allowlistOf([entry({ scripts: { "../x.sh": DIGEST } })])), /script path/],
	])("rejects %s", (_name, input, message) => {
		expect(() => parseAllowlist(input)).toThrow(message);
	});
});

describe("signatures", () => {
	const content = `${JSON.stringify(allowlistOf([entry()]))}\n`;

	it("verifies with the matching key only, and not after any change", () => {
		const signature = signAllowlist(content, KEYS.privateKeyPem);
		expect(verifyAllowlistSignature(content, signature, [KEYS.publicKeyPem])).toBe(true);
		expect(verifyAllowlistSignature(content, signature, [OTHER_KEYS.publicKeyPem, KEYS.publicKeyPem])).toBe(true);
		expect(verifyAllowlistSignature(content, signature, [OTHER_KEYS.publicKeyPem])).toBe(false);
		expect(verifyAllowlistSignature(content.replace("platform-team", "someone-else"), signature, [KEYS.publicKeyPem])).toBe(false);
		expect(verifyAllowlistSignature(content, "not base64!", [KEYS.publicKeyPem])).toBe(false);
	});
});

describe("loadTrustedAllowlists", () => {
	it("needs at least one list and one key", () => {
		const dir = tempDir("eg-trust-");
		const file = writeAllowlist(dir, allowlistOf([entry()]));
		expect(loadTrustedAllowlists({ allowlists: [], publicKeys: [writePublicKey(dir)] }).approvals).toBeUndefined();
		expect(loadTrustedAllowlists({ allowlists: [file], publicKeys: [] }).problems.join()).toMatch(/no trusted public key/);
	});

	it("merges every list that verifies and reports the ones that do not, without their content", () => {
		const dir = tempDir("eg-trust-");
		const team = writeAllowlist(dir, allowlistOf([entry()]), KEYS.privateKeyPem, "team.allow.json");
		const personal = writeAllowlist(
			dir,
			allowlistOf([entry({ key: "user:extensions/mine.ts" })], { revoked: ["project:.omp/tools/old.ts"] }),
			KEYS.privateKeyPem,
			"personal.allow.json",
		);
		const forged = writeAllowlist(dir, allowlistOf([entry({ key: "project:.omp/tools/evil.ts", kind: "tool" })]), OTHER_KEYS.privateKeyPem, "forged.allow.json");
		const unsigned = path.join(dir, "unsigned.allow.json");
		fs.writeFileSync(unsigned, JSON.stringify(allowlistOf([entry({ key: "project:.omp/tools/x.ts", kind: "tool" })])));
		const expired = writeAllowlist(dir, allowlistOf([entry({ key: "project:vendor/old" })], { expiresAt: "2001-01-01T00:00:00Z" }), KEYS.privateKeyPem, "expired.allow.json");

		const result = loadTrustedAllowlists({ allowlists: [team, personal, forged, unsigned, expired], publicKeys: [writePublicKey(dir)] });
		expect([...(result.approvals?.entries.keys() ?? [])].sort()).toEqual(["project:.omp/extensions/dx-helper", "user:extensions/mine.ts"]);
		expect([...(result.approvals?.revoked ?? [])]).toEqual(["project:.omp/tools/old.ts"]);
		expect(result.problems).toHaveLength(3);
		expect(result.problems.join("\n")).toMatch(/forged\.allow\.json.*does not verify/);
		expect(result.problems.join("\n")).toMatch(/unsigned\.allow\.json.*signature file/);
		expect(result.problems.join("\n")).toMatch(/expired\.allow\.json.*expired/);
		expect(result.problems.join("\n")).not.toContain("evil.ts");
	});
});

describe("approvalStatus", () => {
	const dir = () => tempDir("eg-status-");

	it("tells approved, modified, not approved, revoked, unreadable, and no allowlist apart", () => {
		const d = dir();
		const list = writeAllowlist(d, allowlistOf([entry(), entry({ key: "project:.omp/tools/t.ts", kind: "tool" })]), KEYS.privateKeyPem, "a.json");
		const other = writeAllowlist(d, allowlistOf([], { revoked: ["project:.omp/tools/t.ts"] }), KEYS.privateKeyPem, "b.json");
		const { approvals } = loadTrustedAllowlists({ allowlists: [list, other], publicKeys: [writePublicKey(d)] });
		const key = "project:.omp/extensions/dx-helper";
		expect(approvalStatus({ kind: "extension", key, digest: DIGEST }, approvals)).toBe("approved");
		expect(approvalStatus({ kind: "extension", key, digest: "sha256:".padEnd(71, "b") }, approvals)).toBe("modified");
		expect(approvalStatus({ kind: "hook", key, digest: DIGEST }, approvals)).toBe("not-approved");
		expect(approvalStatus({ kind: "extension", key: "project:.omp/extensions/other", digest: DIGEST }, approvals)).toBe("not-approved");
		expect(approvalStatus({ kind: "tool", key: "project:.omp/tools/t.ts", digest: DIGEST }, approvals)).toBe("revoked");
		expect(approvalStatus({ kind: "extension", key, digest: undefined }, approvals)).toBe("unreadable");
		expect(approvalStatus({ kind: "extension", key, digest: DIGEST }, undefined)).toBe("no-allowlist");
	});
});

describe("buildAllowlist", () => {
	const approvalsText = (items: Record<string, unknown>, revoked: string[] = []) => JSON.stringify({ items, revoked });
	const reviewed = { kind: "extension", source: "https://example.test/dx-helper", commit: "0123456789abcdef", reviewer: "platform-team", scripts: ["scripts/setup.sh"] };

	it("pins each approved unit to its current digest and scripts", () => {
		const dir = tree({ "index.ts": "x\n", "scripts/setup.sh": "echo\n" });
		const now = new Date("2026-10-12T00:00:00Z");
		const list = buildAllowlist(parseApprovals(approvalsText({ "project:.omp/extensions/dx-helper": reviewed }, ["project:.omp/tools/old.ts"])), [unit(dir)], {
			now,
			expiresInDays: 30,
		});
		expect(list.schema).toBe(ALLOWLIST_SCHEMA);
		expect(list.expiresAt).toBe("2026-11-11T00:00:00.000Z");
		expect(list.items).toEqual([
			{
				kind: "extension",
				key: "project:.omp/extensions/dx-helper",
				digest: digestUnit(dir),
				scripts: { "scripts/setup.sh": digestUnit(path.join(dir, "scripts/setup.sh")) },
				source: reviewed.source,
				commit: reviewed.commit,
				reviewer: "platform-team",
			},
		]);
		expect(list.revoked).toEqual(["project:.omp/tools/old.ts"]);
		expect(() => parseAllowlist(JSON.stringify(list), now)).not.toThrow(AllowlistError);
	});

	it.each([
		["no reviewer", { ...reviewed, reviewer: "" }, /reviewer/],
		["no version or commit", { ...reviewed, commit: undefined }, /version or commit/],
		["a kind that differs from where omp loads it", { ...reviewed, kind: "hook" }, /loads it as extension/],
		["scripts that differ from the unit's", { ...reviewed, scripts: [] }, /scripts/],
	])("refuses an entry with %s", (_name, item, message) => {
		const dir = tree({ "index.ts": "x\n", "scripts/setup.sh": "echo\n" });
		expect(() => buildAllowlist(parseApprovals(approvalsText({ "project:.omp/extensions/dx-helper": item })), [unit(dir)], {})).toThrow(message);
	});

	it("refuses a key omp does not load and a unit that could not be hashed", () => {
		const dir = tree({ "index.ts": "x\n", "scripts/setup.sh": "echo\n" });
		expect(() => buildAllowlist(parseApprovals(approvalsText({ "project:.omp/extensions/gone": reviewed })), [unit(dir)], {})).toThrow(/not found/);
		const broken: Unit = { ...unit(dir), digest: undefined, scripts: {}, error: "a symlink leaves the unit" };
		expect(() => buildAllowlist(parseApprovals(approvalsText({ "project:.omp/extensions/dx-helper": reviewed })), [broken], {})).toThrow(/could not be hashed/);
	});
});
