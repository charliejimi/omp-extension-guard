import { afterAll, afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { runCli } from "../src/cli";
import { type Project, fullUserLevel, makeProject, removeTemps, resetUserLevel, tempDir } from "./fixtures";

afterAll(removeTemps);
afterEach(resetUserLevel);

async function run(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runCli(argv, { out: line => out.push(line), err: line => err.push(line) });
	return { code, out: out.join("\n"), err: err.join("\n") };
}

function smallProject(): Project {
	const p = makeProject();
	p.write(".omp/extensions/dx-helper/index.ts", p.extension("dx-helper"));
	p.write(".omp/extensions/dx-helper/scripts/setup.sh", "#!/bin/sh\n", 0o755);
	p.write(".omp/tools/fmt.ts", p.tool("fmt"));
	return p;
}

const approvals = {
	items: {
		"project:.omp/extensions/dx-helper": {
			kind: "extension",
			source: "https://example.test/dx-helper",
			version: "1.2.0",
			reviewer: "platform-team",
			scripts: ["scripts/setup.sh"],
		},
		"project:.omp/tools/fmt.ts": { kind: "tool", source: "https://example.test/fmt", commit: "0123abcd", reviewer: "platform-team" },
	},
};

async function signedList(p: Project): Promise<{ list: string; pub: string; key: string }> {
	const keys = tempDir("eg-keys-");
	expect((await run("keygen", keys)).code).toBe(0);
	const approvalsFile = path.join(p.root, "approvals.json");
	fs.writeFileSync(approvalsFile, JSON.stringify(approvals));
	const list = path.join(p.root, "extensions.allow.json");
	expect((await run("allowlist", "--approvals", approvalsFile, "--out", list, "--cwd", p.cwd, "--expires-in-days", "30")).code).toBe(0);
	const key = path.join(keys, "extension-guard.key.pem");
	expect((await run("sign", "--key", key, list)).code).toBe(0);
	return { list, pub: path.join(keys, "extension-guard.pub.pem"), key };
}

describe("keygen", () => {
	it("writes a private key only its owner can read, and does not overwrite one", async () => {
		const dir = tempDir("eg-keys-");
		expect((await run("keygen", dir)).code).toBe(0);
		expect(fs.statSync(path.join(dir, "extension-guard.key.pem")).mode & 0o777).toBe(0o600);
		expect(fs.readFileSync(path.join(dir, "extension-guard.pub.pem"), "utf8")).toContain("BEGIN PUBLIC KEY");
		const again = await run("keygen", dir);
		expect(again.code).toBe(1);
		expect(again.err).toMatch(/already exists/);
	});
});

describe("inventory", () => {
	it("prints every unit as JSON, and as text grouped by who wrote it", async () => {
		const p = smallProject();
		fullUserLevel(p);
		const json = await run("inventory", "--cwd", p.cwd, "--json");
		expect(json.code).toBe(0);
		const parsed = JSON.parse(json.out) as { units: Array<{ key: string; status?: string }> };
		expect(parsed.units.map(unit => unit.key)).toEqual(expect.arrayContaining(["project:.omp/extensions/dx-helper", "project:.omp/tools/fmt.ts", "user:extensions/user-ext.ts"]));
		const text = await run("inventory", "--cwd", p.cwd);
		expect(text.code).toBe(0);
		expect(text.out).toMatch(/repository's author/i);
		expect(text.out).toMatch(/project:\.omp\/tools\/fmt\.ts.*no flag stops it/);
		expect(p.ran()).toEqual([]);
	});
});

describe("allowlist, sign, verify", () => {
	it("builds a signed list that verifies, and fails verification after a change or with another key", async () => {
		const p = smallProject();
		const { list, pub } = await signedList(p);
		expect((await run("verify", "--public-key", pub, list)).code).toBe(0);
		const other = tempDir("eg-keys-");
		await run("keygen", other);
		expect((await run("verify", "--public-key", path.join(other, "extension-guard.pub.pem"), list)).code).toBe(1);
		fs.writeFileSync(list, fs.readFileSync(list, "utf8").replace("platform-team", "someone"));
		expect((await run("verify", "--public-key", pub, list)).code).toBe(1);
	});

	it("refuses approvals that miss a reviewer", async () => {
		const p = smallProject();
		const file = path.join(p.root, "approvals.json");
		fs.writeFileSync(file, JSON.stringify({ items: { "project:.omp/tools/fmt.ts": { kind: "tool", source: "x", version: "1" } } }));
		const result = await run("allowlist", "--approvals", file, "--out", path.join(p.root, "out.json"), "--cwd", p.cwd);
		expect(result.code).toBe(1);
		expect(result.err).toMatch(/reviewer/);
		expect(fs.existsSync(path.join(p.root, "out.json"))).toBe(false);
	});
});

describe("check (CI)", () => {
	it("passes when every project unit is approved and fails, naming each problem, when one is new, changed, or moved", async () => {
		const p = smallProject();
		const { list, pub } = await signedList(p);
		const check = () => run("check", "--allowlist", list, "--public-key", pub, "--cwd", p.cwd);
		expect((await check()).code).toBe(0);

		p.write(".omp/hooks/pre/bash.ts", p.extension("new-hook"));
		p.write(".omp/extensions/dx-helper/index.ts", "export default function () { /* changed */ }\n");
		fs.renameSync(path.join(p.cwd, ".omp/tools/fmt.ts"), path.join(p.cwd, ".omp/tools/format.ts"));
		const failed = await check();
		expect(failed.code).toBe(1);
		expect(failed.out).toMatch(/project:\.omp\/hooks\/pre\/bash\.ts.*not approved/);
		expect(failed.out).toMatch(/project:\.omp\/extensions\/dx-helper.*changed since approval/);
		expect(failed.out).toMatch(/project:\.omp\/tools\/format\.ts.*approved at project:\.omp\/tools\/fmt\.ts/);
	});

	it("checks only project units unless asked for all, and treats an unverifiable list as a failure", async () => {
		const p = smallProject();
		const { list, pub } = await signedList(p);
		fullUserLevel(p);
		expect((await run("check", "--allowlist", list, "--public-key", pub, "--cwd", p.cwd)).code).toBe(0);
		expect((await run("check", "--allowlist", list, "--public-key", pub, "--cwd", p.cwd, "--scope", "all")).code).toBe(1);
		fs.rmSync(`${list}.sig`);
		const unsigned = await run("check", "--allowlist", list, "--public-key", pub, "--cwd", p.cwd);
		expect(unsigned.code).toBe(1);
		expect(unsigned.err).toMatch(/signature/);
	});

	it("exits 2 on a usage error", async () => {
		expect((await run("check")).code).toBe(2);
		expect((await run("no-such-command")).code).toBe(2);
	});
});
