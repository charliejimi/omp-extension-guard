import { afterAll, afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { GuardConfig } from "../src/config";
import { inventory, loadSet } from "../src/inventory";
import { EXIT_REFUSED, type LaunchIO, buildCommand, decide, launch, plan, renderOverlay } from "../src/launcher";
import { type Project, fullProject, makeProject, removeTemps, resetUserLevel, tempDir, writeHome } from "./fixtures";
import { allowlistOf, approve, unitByKey, writeAllowlist, writePublicKey } from "./helpers";

afterAll(removeTemps);
afterEach(resetUserLevel);

async function setup(p: Project, keys: string[], extra: Partial<GuardConfig> = {}): Promise<GuardConfig> {
	const { units } = await inventory(p.cwd);
	const trust = path.join(p.root, "trust");
	const list = writeAllowlist(trust, allowlistOf(keys.map(key => approve(unitByKey(units, key)))));
	return { allowlists: [list], publicKeys: [writePublicKey(trust)], isolation: "off", onUnapproved: "exclude", ...extra };
}

const rel = (p: Project) => (file: string) => path.relative(p.cwd, file);

function recordingIO(answer?: string): LaunchIO & { lines: string[]; questions: string[] } {
	const io = {
		lines: [] as string[],
		questions: [] as string[],
		err: (line: string) => io.lines.push(line),
		...(answer === undefined
			? {}
			: {
					ask: async (question: string) => {
						io.questions.push(question);
						return answer;
					},
				}),
	};
	return io;
}

describe("plan: trusted mode (default)", () => {
	it("passes only approved extension entries, disables unapproved tools by id, and keeps the user's disabled ids", async () => {
		const p = fullProject();
		p.write(".omp/config.yml", "extensions:\n  - ./vendor/cfg-ext\ndisabledExtensions:\n  - skill:noisy\n");
		const config = await setup(p, ["project:.omp/extensions/dx-helper", "project:.omp/plugins/node_modules/proj-plugin"]);
		const pl = await plan({ cwd: p.cwd, config });
		expect(pl.refusals).toEqual([]);
		expect(pl.mode).toBe("trusted");
		expect(pl.extensions.map(rel(p))).toEqual([".omp/extensions/dx-helper/index.ts", ".omp/plugins/node_modules/proj-plugin/ext.ts"]);
		expect([...pl.overlay.disabledExtensions].sort()).toEqual(["skill:noisy", "tool:ctool", "tool:evil", "tool:multi", "tool:xtool"]);
		expect(pl.overlay.extensions).toBeUndefined();
		expect(pl.excluded.map(unit => unit.key)).toEqual(
			expect.arrayContaining([
				"project:.omp/extensions/solo.ts",
				"project:vendor/legacy-ext.ts",
				"project:vendor/cfg-ext",
				"project:.omp/hooks/pre/bash.ts",
				"project:.omp/commands/hello",
				"project:.omp/tools/evil.ts",
				"project:scripts/preload.ts",
			]),
		);
		expect(pl.approved.map(unit => unit.key).sort()).toEqual(["project:.omp/extensions/dx-helper", "project:.omp/plugins/node_modules/proj-plugin"]);

		const overlay = path.join(p.root, "overlay.yml");
		fs.writeFileSync(overlay, renderOverlay(pl));
		const truth = await loadSet(p.cwd, { mode: "explicit-only", explicit: pl.extensions, configFiles: [overlay] });
		expect(truth.extensions).toEqual(pl.extensions);
		expect(truth.tools.map(rel(p))).toEqual([".omp/plugins/node_modules/proj-plugin/tool.ts"]);
		expect(p.ran()).toEqual([]);
	});

	it("refuses when an unapproved unit has code no switch can keep out", async () => {
		const p = fullProject();
		const pl = await plan({ cwd: p.cwd, config: await setup(p, ["project:.omp/extensions/dx-helper"]) });
		expect(pl.refusals.join("\n")).toMatch(/project:\.omp\/plugins\/node_modules\/proj-plugin/);
	});

	it("refuses when an unapproved tool shares its id with an approved one", async () => {
		const p = makeProject();
		writeHome(".omp/agent/tools/fmt.ts", p.tool("fmt"));
		const config = await setup(p, ["user:tools/fmt.ts"]);
		p.write(".omp/tools/fmt.ts", p.tool("fmt-imposter"));
		const pl = await plan({ cwd: p.cwd, config });
		expect(pl.refusals.join("\n")).toMatch(/tool:fmt/);
	});

	it("treats extensions named with -e like any other code: in only when approved", async () => {
		const p = makeProject();
		const pkg = path.join(tempDir("eg-pkg-"), "provider.ts");
		fs.writeFileSync(pkg, p.extension("provider"));
		const without = await plan({ cwd: p.cwd, config: await setup(p, []), ompArgs: ["-e", pkg, "--model", "x"] });
		expect(without.extensions).toEqual([]);
		expect(without.excluded.map(unit => unit.kind)).toEqual(["explicit"]);
		const { units } = await inventory(p.cwd, { mode: "explicit-only", explicit: [pkg] });
		const trust = path.join(p.root, "trust2");
		const list = writeAllowlist(trust, allowlistOf([approve(units.find(unit => unit.kind === "explicit")!)]));
		const config: GuardConfig = { allowlists: [list], publicKeys: [writePublicKey(trust)], isolation: "off" };
		const withIt = await plan({ cwd: p.cwd, config, ompArgs: ["-e", pkg, "--model", "x"] });
		expect(withIt.extensions).toEqual([pkg]);
		expect(withIt.passthrough.flags).toEqual(["--model", "x"]);
	});
});

describe("plan: explicit and discovery modes", () => {
	it("explicit mode loads the same set as trusted mode, through --no-extensions and -e", async () => {
		const p = fullProject();
		const config = await setup(p, ["project:.omp/extensions/dx-helper", "project:.omp/plugins/node_modules/proj-plugin"], { mode: "explicit" });
		const pl = await plan({ cwd: p.cwd, config });
		expect(pl.refusals).toEqual([]);
		const command = buildCommand(pl, "/state/run/guard.ts", "/state/run/overlay.yml", config);
		expect(command.slice(0, 6)).toEqual(["omp", "--cwd", p.cwd, "--no-extensions", "-e", path.join(p.cwd, ".omp/extensions/dx-helper/index.ts")]);
		expect(command).not.toContain("--trusted-extension");
		expect(command.indexOf("/state/run/guard.ts")).toBeGreaterThan(command.indexOf(path.join(p.cwd, ".omp/plugins/node_modules/proj-plugin/ext.ts")));
	});

	it("discovery mode keeps auto-discovery and switches off every unapproved unit in the overlay", async () => {
		const p = fullProject();
		const keys = ["project:.omp/extensions/dx-helper", "project:.omp/plugins/node_modules/proj-plugin", "project:.omp/commands/hello"];
		const config = await setup(p, keys, { mode: "discovery" });
		const pl = await plan({ cwd: p.cwd, config });
		expect(pl.refusals).toEqual([]);
		expect(pl.overlay.extensions).toEqual([]);
		expect(pl.overlay.disabledExtensions).toEqual(
			expect.arrayContaining([
				"extension-module:solo",
				"extension-module:legacy-ext",
				"hook:pre:bash:bash.ts",
				"hook:post:write:write.ts",
				"hook:pre:claude-hook.ts:claude-hook.ts",
				"tool:evil",
			]),
		);
		const overlay = path.join(p.root, "overlay.yml");
		fs.writeFileSync(overlay, renderOverlay(pl));
		const truth = await loadSet(p.cwd, { configFiles: [overlay] });
		expect(truth.extensions.map(rel(p)).sort()).toEqual([".omp/extensions/dx-helper/index.ts", ".omp/plugins/node_modules/proj-plugin/ext.ts"]);
	});

	it("discovery mode refuses an unapproved command, which only --no-extensions or --trusted-extension stop", async () => {
		const p = fullProject();
		const config = await setup(p, ["project:.omp/plugins/node_modules/proj-plugin"], { mode: "discovery" });
		expect((await plan({ cwd: p.cwd, config })).refusals.join("\n")).toMatch(/project:\.omp\/commands\/hello/);
	});

	it("discovery mode refuses when an unapproved extension shares its id with an approved one", async () => {
		const p = makeProject();
		writeHome(".omp/agent/extensions/helper.ts", p.extension("user-helper"));
		const config = await setup(p, ["user:extensions/helper.ts"], { mode: "discovery" });
		p.write(".omp/extensions/helper.ts", p.extension("repo-helper"));
		expect((await plan({ cwd: p.cwd, config })).refusals.join("\n")).toMatch(/extension-module:helper/);
	});
});

describe("decide", () => {
	it("asks at a terminal, refuses without one unless the policy says exclude, and never starts over a refusal", async () => {
		const p = fullProject();
		const pl = await plan({
			cwd: p.cwd,
			config: await setup(p, ["project:.omp/extensions/dx-helper", "project:.omp/plugins/node_modules/proj-plugin"]),
		});
		const no = recordingIO("1");
		expect(await decide(pl, "ask", no)).toBe("refuse");
		expect(no.questions[0]).toMatch(/project:\.omp\/extensions\/solo\.ts/);
		expect(await decide(pl, "ask", recordingIO("2"))).toBe("start");
		expect(await decide(pl, "ask", recordingIO())).toBe("refuse");
		expect(await decide(pl, "refuse", recordingIO("2"))).toBe("refuse");
		expect(await decide(pl, "exclude", recordingIO())).toBe("start");
		expect(await decide({ ...pl, refusals: ["no"] }, "exclude", recordingIO("2"))).toBe("refuse");
	});
});

describe("isolation", () => {
	it("in require mode refuses over an unaccepted credential exposure, and passes only allowlisted variables", async () => {
		const p = makeProject();
		const source = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CURSOR_API_KEY: "key-123456789", UNRELATED: "x" };
		const base = await setup(p, [], { isolation: "require", passEnv: ["CURSOR_API_KEY"] });
		const refused = await plan({ cwd: p.cwd, config: base, env: source });
		expect(refused.refusals.join("\n")).toMatch(/env:CURSOR_API_KEY/);
		expect(Object.keys(refused.env).sort()).toEqual(["CURSOR_API_KEY", "HOME", "PATH"]);
		const placeholder = await plan({ cwd: p.cwd, config: base, env: { ...source, CURSOR_API_KEY: "proxy-managed" } });
		expect(placeholder.refusals).toEqual([]);
		const accepted = await plan({ cwd: p.cwd, config: { ...base, accept: ["env:CURSOR_API_KEY"] }, env: source });
		expect(accepted.refusals).toEqual([]);
		const warned = await plan({ cwd: p.cwd, config: { ...base, isolation: "warn" }, env: source });
		expect(warned.refusals).toEqual([]);
		expect(warned.findings.map(f => f.key)).toEqual(["env:CURSOR_API_KEY"]);
	});
});

describe("buildCommand", () => {
	it("starts omp in the project with --cwd, puts the guard last, our overlay after the user's, and omp's own -- last", async () => {
		const p = fullProject();
		const config = await setup(p, ["project:.omp/extensions/dx-helper", "project:.omp/plugins/node_modules/proj-plugin"], { omp: ["omp", "--profile", "x"] });
		const userOverlay = path.join(p.root, "mine.yml");
		fs.writeFileSync(userOverlay, "theme: dark\n");
		const pl = await plan({
			cwd: p.cwd,
			config,
			ompArgs: ["--no-extensions", "--config", userOverlay, "--hook", "/x/hook.ts", "--model", "m", "--", "-e", "is message text"],
		});
		const command = buildCommand(pl, "/state/run/guard.ts", "/state/run/overlay.yml", config);
		expect(command).toEqual([
			"omp",
			"--profile",
			"x",
			"--cwd",
			p.cwd,
			"--trusted-extension",
			path.join(p.cwd, ".omp/extensions/dx-helper/index.ts"),
			"--trusted-extension",
			path.join(p.cwd, ".omp/plugins/node_modules/proj-plugin/ext.ts"),
			"--trusted-extension",
			"/state/run/guard.ts",
			"--config",
			userOverlay,
			"--config",
			"/state/run/overlay.yml",
			"--model",
			"m",
			"--",
			"-e",
			"is message text",
		]);
		expect(pl.excluded.map(unit => unit.kind)).toContain("explicit");
	});
});

describe("launch", () => {
	function fakeOmp(root: string): { command: string[]; record: string } {
		const record = path.join(root, "fake-omp.json");
		const script = path.join(root, "fake-omp.ts");
		fs.writeFileSync(
			script,
			[
				'import * as fs from "node:fs";',
				"const [record, ...args] = process.argv.slice(2);",
				"fs.writeFileSync(record, JSON.stringify({ cwd: process.cwd(), args, env: Object.keys(process.env).sort(), launchDir: fs.readdirSync(process.cwd()) }));",
				'const at = args.lastIndexOf("--trusted-extension");',
				"if (at >= 0) {",
				"\tconst entry = fs.readFileSync(args[at + 1], \"utf8\");",
				'\tconst audit = JSON.parse(entry.slice(entry.indexOf("(") + 1, entry.lastIndexOf(")")));',
				'\tfs.appendFileSync(audit.auditLog, JSON.stringify({ run: audit.runId, event: "tool_call", tool: "write", action: "block", rule: "protected-write" }) + "\\n");',
				"}",
				"process.exit(7);",
			].join("\n"),
		);
		return { command: ["bun", script, record], record };
	}

	it("starts omp from an empty directory with only allowlisted variables, returns its exit code, reports, and cleans up", async () => {
		const p = fullProject();
		const fake = fakeOmp(p.root);
		const state = path.join(p.root, "state");
		const audit = path.join(p.root, "audit.jsonl");
		const config = await setup(p, ["project:.omp/extensions/dx-helper", "project:.omp/plugins/node_modules/proj-plugin"], {
			omp: fake.command,
			auditLog: audit,
		});
		const io = recordingIO();
		const code = await launch({ cwd: p.cwd, config, ompArgs: ["--model", "m"], stateDir: state, io, env: { ...process.env, SECRET_TOKEN: "abcdefghijklmnop" } });
		expect(code).toBe(7);
		const seen = JSON.parse(fs.readFileSync(fake.record, "utf8")) as { cwd: string; args: string[]; env: string[]; launchDir: string[] };
		expect(seen.cwd.startsWith(state)).toBe(true);
		expect(seen.launchDir).toEqual([]);
		expect(seen.args.slice(0, 2)).toEqual(["--cwd", p.cwd]);
		expect(seen.env).not.toContain("SECRET_TOKEN");
		expect(p.ran()).toEqual([]);
		expect(fs.readdirSync(path.join(state, "runs"))).toEqual([]);
		expect(io.lines.join("\n")).toMatch(/guard decisions this run: 1 block/);
	});

	it("does not start omp when it refuses", async () => {
		const p = fullProject();
		const fake = fakeOmp(p.root);
		const config = await setup(p, ["project:.omp/extensions/dx-helper"], { omp: fake.command });
		const io = recordingIO();
		expect(await launch({ cwd: p.cwd, config, stateDir: path.join(p.root, "state"), io })).toBe(EXIT_REFUSED);
		expect(fs.existsSync(fake.record)).toBe(false);
		expect(io.lines.join("\n")).toMatch(/not starting omp/);
	});
});
