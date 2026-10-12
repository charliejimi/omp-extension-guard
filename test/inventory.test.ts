import { afterAll, afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { digestUnit } from "../src/allowlist";
import { type Unit, inventory, loadSet, scopeKey } from "../src/inventory";
import { agentDir, fullProject, fullUserLevel, homeDir, makeProject, removeTemps, resetUserLevel, tempDir } from "./fixtures";
import { unitByKey } from "./helpers";

afterAll(removeTemps);
afterEach(resetUserLevel);

const summary = (unit: Unit) => ({
	kind: unit.kind,
	level: unit.level,
	entries: unit.entries.map(entry => ({
		file: path.basename(entry.path),
		role: entry.role,
		switches: entry.switches as string[],
		...(entry.disableId ? { disableId: entry.disableId } : {}),
	})),
});

describe("inventory", () => {
	it("lists exactly what omp 18.2.8 would load, without running any of it", async () => {
		const p = fullProject();
		fullUserLevel(p);
		const inv = await inventory(p.cwd);
		const truth = await loadSet(p.cwd);
		const listed = inv.units.flatMap(unit => unit.entries.filter(entry => entry.role !== "preload").map(entry => path.resolve(entry.path)));
		const expected = [...truth.extensions, ...truth.tools, ...truth.commands].map(file => path.resolve(file));
		expect([...listed].sort()).toEqual([...new Set(expected)].sort());
		expect(listed.length).toBe(new Set(listed).size);
		expect(p.ran()).toEqual([]);
	});

	it("keys, classifies, and names the switch that stops each unit", async () => {
		const p = fullProject();
		fullUserLevel(p);
		const { units } = await inventory(p.cwd);
		const all = ["trusted-extension", "no-extensions", "disabled-id"];
		expect(summary(unitByKey(units, "project:.omp/extensions/dx-helper"))).toEqual({
			kind: "extension",
			level: "project",
			entries: [{ file: "index.ts", role: "extension", switches: all, disableId: "extension-module:dx-helper" }],
		});
		expect(summary(unitByKey(units, "project:.omp/extensions/solo.ts")).entries[0]?.disableId).toBe("extension-module:solo");
		expect(unitByKey(units, "project:vendor/legacy-ext.ts")).toMatchObject({ kind: "extension", via: ".omp/settings.json" });
		expect(summary(unitByKey(units, "project:vendor/cfg-ext"))).toEqual({
			kind: "configured",
			level: "project",
			entries: [{ file: "index.ts", role: "extension", switches: ["trusted-extension", "no-extensions", "overlay-extensions"] }],
		});
		expect(summary(unitByKey(units, "project:.omp/hooks/pre/bash.ts")).entries[0]).toEqual({
			file: "bash.ts",
			role: "extension",
			switches: all,
			disableId: "hook:pre:bash:bash.ts",
		});
		expect(unitByKey(units, "project:.claude/hooks/pre/claude-hook.ts")).toMatchObject({ kind: "hook", entries: [{ provider: "claude" }] });
		expect(summary(unitByKey(units, "project:.omp/tools/evil.ts"))).toEqual({
			kind: "tool",
			level: "project",
			entries: [{ file: "evil.ts", role: "tool", switches: ["disabled-id"], disableId: "tool:evil" }],
		});
		expect(summary(unitByKey(units, "project:.omp/tools/multi")).entries[0]?.disableId).toBe("tool:multi");
		expect(unitByKey(units, "project:.claude/tools/ctool.ts").entries[0]).toMatchObject({ provider: "claude", disableId: "tool:ctool" });
		expect(unitByKey(units, "project:.codex/tools/xtool.ts").entries[0]).toMatchObject({ provider: "codex", disableId: "tool:xtool" });
		expect(summary(unitByKey(units, "project:.omp/plugins/node_modules/proj-plugin"))).toEqual({
			kind: "plugin",
			level: "project",
			entries: [
				{ file: "ext.ts", role: "extension", switches: all, disableId: "extension-module:ext" },
				{ file: "tool.ts", role: "tool", switches: [] },
			],
		});
		expect(summary(unitByKey(units, "project:.omp/commands/hello"))).toEqual({
			kind: "command",
			level: "project",
			entries: [{ file: "index.ts", role: "command", switches: ["trusted-extension", "no-extensions"] }],
		});
		expect(summary(unitByKey(units, "project:scripts/preload.ts"))).toEqual({
			kind: "preload",
			level: "project",
			entries: [{ file: "preload.ts", role: "preload", switches: ["launch-dir"] }],
		});
		expect(unitByKey(units, "user:extensions/user-ext.ts")).toMatchObject({ kind: "extension", level: "user" });
		expect(unitByKey(units, "user:tools/utool.ts")).toMatchObject({ kind: "tool", level: "user" });
		expect(unitByKey(units, "user:hooks/pre/uhook.ts")).toMatchObject({ kind: "hook", level: "user" });
		expect(unitByKey(units, "home:.omp/plugins/node_modules/user-plugin")).toMatchObject({ kind: "plugin", level: "user" });
	});

	it("pins each unit to the digest of its file or directory and lists its scripts", async () => {
		const p = fullProject();
		const { units, dotenv } = await inventory(p.cwd);
		const dx = unitByKey(units, "project:.omp/extensions/dx-helper");
		expect(dx.path).toBe(path.join(p.cwd, ".omp/extensions/dx-helper"));
		expect(dx.digest).toBe(digestUnit(dx.path));
		expect(Object.keys(dx.scripts)).toEqual(["scripts/setup.sh"]);
		expect(unitByKey(units, "project:.omp/plugins/node_modules/proj-plugin").digest).toBe(
			digestUnit(path.join(p.cwd, ".omp/plugins/node_modules/proj-plugin")),
		);
		expect(dotenv).toEqual([path.join(p.cwd, ".env")]);
	});

	it("reports a unit that cannot be pinned instead of hashing part of it", async () => {
		const p = makeProject();
		p.write(".omp/extensions/leaky/index.ts", p.extension("leaky"));
		const outside = tempDir("eg-outside-");
		fs.writeFileSync(path.join(outside, "lib.ts"), "export {};\n");
		fs.symlinkSync(path.join(outside, "lib.ts"), path.join(p.cwd, ".omp/extensions/leaky/lib.ts"));
		const leaky = unitByKey((await inventory(p.cwd)).units, "project:.omp/extensions/leaky");
		expect(leaky.digest).toBeUndefined();
		expect(leaky.error).toMatch(/leaves the unit/);
	});

	it("sees changes made between two calls", async () => {
		const p = makeProject();
		p.write(".omp/extensions/a.ts", p.extension("a"));
		expect((await inventory(p.cwd)).units.map(unit => unit.key)).toEqual(["project:.omp/extensions/a.ts"]);
		p.write(".omp/tools/late.ts", p.tool("late"));
		expect((await inventory(p.cwd)).units.map(unit => unit.key).sort()).toEqual(["project:.omp/extensions/a.ts", "project:.omp/tools/late.ts"]);
	});

	it("in explicit-only mode lists only the named extensions, their package's tools, and the tools no flag stops", async () => {
		const p = fullProject();
		const pkg = tempDir("eg-pkg-");
		fs.writeFileSync(path.join(pkg, "index.ts"), p.extension("pkg"));
		fs.mkdirSync(path.join(pkg, "tools"));
		fs.writeFileSync(path.join(pkg, "tools", "pkgtool.ts"), p.tool("pkgtool"));
		const inv = await inventory(p.cwd, { mode: "explicit-only", explicit: [pkg] });
		const truth = await loadSet(p.cwd, { mode: "explicit-only", explicit: [pkg] });
		expect(truth.extensions).toEqual([path.join(pkg, "index.ts")]);
		const explicitUnit = unitByKey(inv.units, scopeKey(pkg, { cwd: p.cwd, agentDir: agentDir(), home: homeDir() }));
		expect(explicitUnit.kind).toBe("explicit");
		expect(explicitUnit.entries.map(entry => [path.basename(entry.path), entry.role]).sort()).toEqual([
			["index.ts", "extension"],
			["pkgtool.ts", "tool"],
		]);
		expect(inv.units.map(unit => unit.key)).toContain("project:.omp/tools/evil.ts");
		expect(inv.units.map(unit => unit.key)).not.toContain("project:.omp/extensions/dx-helper");
		expect(p.ran()).toEqual([]);
	});

	it("applies --config overlays the way omp does: a disabled tool id drops the tool", async () => {
		const p = fullProject();
		const overlay = path.join(p.root, "overlay.yml");
		fs.writeFileSync(overlay, 'disabledExtensions: ["tool:evil"]\n');
		const truth = await loadSet(p.cwd, { mode: "explicit-only", configFiles: [overlay] });
		expect(truth.tools.map(file => path.basename(file))).not.toContain("evil.ts");
		expect(truth.tools.map(file => path.basename(file))).toContain("tool.ts");
	});
});

describe("scopeKey", () => {
	it("keys a path by the first of the project, omp's agent directory, HOME, or the filesystem root that holds it", () => {
		const ctx = { cwd: "/work/repo", agentDir: "/home/u/.omp/agent", home: "/home/u" };
		expect(scopeKey("/work/repo/.omp/extensions/x", ctx)).toBe("project:.omp/extensions/x");
		expect(scopeKey("/home/u/.omp/agent/extensions/y.ts", ctx)).toBe("user:extensions/y.ts");
		expect(scopeKey("/home/u/.omp/plugins/node_modules/z", ctx)).toBe("home:.omp/plugins/node_modules/z");
		expect(scopeKey("/opt/omp/guard.ts", ctx)).toBe("abs:/opt/omp/guard.ts");
		expect(scopeKey("/work/repo-other/x.ts", ctx)).toBe("abs:/work/repo-other/x.ts");
	});
});
