// Fixture projects with one piece of startup code per load surface of omp 18.2.8. Every module
// records a canary file when it is imported, so a test can tell whether anything in it ran.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** The temporary root test/run.ts created; test/setup.ts already checked HOME and TMPDIR are inside it. */
const TEST_ROOT = fs.realpathSync(process.env.EG_TEST_ROOT ?? "/nonexistent-test-root");

/** Deletes `target` only when its real path is strictly inside the suite's temporary root. */
export function safeRemove(target: string): void {
	let real: string;
	try {
		real = fs.realpathSync(target);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
		throw err;
	}
	const rel = path.relative(TEST_ROOT, real);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`refusing to delete ${target}: outside the test root`);
	fs.rmSync(real, { recursive: true, force: true });
}

const temps: string[] = [];

export function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	temps.push(dir);
	return dir;
}

export function removeTemps(): void {
	for (const dir of temps.splice(0)) safeRemove(dir);
}

export interface Project {
	root: string;
	/** The repository omp runs in. */
	cwd: string;
	/** Where fixture modules record that they ran. */
	canaries: string;
	/** Names of the fixture modules that ran so far. */
	ran(): string[];
	/** Writes a file relative to the repository and returns its absolute path. */
	write(rel: string, text: string, mode?: number): string;
	/** Source of a module that records `name` when imported and exports an extension factory. */
	extension(name: string): string;
	/** Source of a module that records `name` when imported and exports a custom tool factory. */
	tool(name: string): string;
}

function writeFile(file: string, text: string, mode?: number): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	if (mode !== undefined) fs.chmodSync(file, mode);
	return file;
}

export function makeProject(): Project {
	const root = tempDir("eg-proj-");
	const cwd = path.join(root, "repo");
	const canaries = path.join(root, "canaries");
	fs.mkdirSync(canaries, { recursive: true });
	writeFile(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
	const record = (name: string) =>
		`import * as fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(path.join(canaries, name))}, "ran");\n`;
	return {
		root,
		cwd,
		canaries,
		ran: () => fs.readdirSync(canaries).sort(),
		write: (rel, text, mode) => writeFile(path.join(cwd, rel), text, mode),
		extension: name => `${record(name)}export default function () {}\n`,
		tool: name =>
			`${record(name)}export default function () {\n\treturn { name: ${JSON.stringify(name)}, description: "fixture tool", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "ok" }] }) };\n}\n`,
	};
}

export const homeDir = (): string => os.homedir();
export const agentDir = (): string => process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".omp", "agent");

/** Writes a file relative to the suite's HOME. */
export function writeHome(rel: string, text: string, mode?: number): string {
	return writeFile(path.join(os.homedir(), rel), text, mode);
}

/** Removes every user-level fixture from the suite's temporary HOME. */
export function resetUserLevel(): void {
	for (const rel of [".omp", ".claude", ".codex", ".config", ".local", ".cache", ".aws", ".git-credentials", ".netrc", ".npmrc"]) {
		safeRemove(path.join(os.homedir(), rel));
	}
}

/** A plugin package with an extension entry and a tool entry under `<root>/node_modules/<name>`. */
export function writePlugin(root: string, name: string, p: Project, version = "1.0.0"): string {
	writeFile(path.join(root, "package.json"), `${JSON.stringify({ dependencies: { [name]: version } })}\n`);
	const dir = path.join(root, "node_modules", name);
	writeFile(path.join(dir, "package.json"), `${JSON.stringify({ name, version, omp: { extensions: ["./ext.ts"], tools: ["./tool.ts"] } })}\n`);
	writeFile(path.join(dir, "ext.ts"), p.extension(`${name}-ext`));
	writeFile(path.join(dir, "tool.ts"), p.tool(`${name.replace(/[^a-z]/g, "")}tool`));
	return dir;
}

/**
 * One item per project-level load surface:
 * - `.omp/extensions/dx-helper/` (a directory, with a script) and `.omp/extensions/solo.ts`
 * - `.omp/settings.json#extensions` naming `vendor/legacy-ext.ts`
 * - `.omp/config.yml` `extensions:` naming the directory `vendor/cfg-ext`
 * - hooks in `.omp/hooks/pre`, `.omp/hooks/post`, and `.claude/hooks/pre`
 * - tools in `.omp/tools` (a file and a directory), `.claude/tools`, and `.codex/tools`
 * - the repository's own plugin root `.omp/plugins` with `proj-plugin`
 * - a TypeScript slash command in `.omp/commands/hello/`
 * - a `bunfig.toml` preload and a `.env`
 */
export function fullProject(): Project {
	const p = makeProject();
	p.write(".omp/extensions/dx-helper/index.ts", p.extension("dx-helper"));
	p.write(".omp/extensions/dx-helper/scripts/setup.sh", "#!/bin/sh\necho setup\n", 0o755);
	p.write(".omp/extensions/solo.ts", p.extension("solo"));
	p.write(".omp/settings.json", `${JSON.stringify({ extensions: ["./vendor/legacy-ext.ts"] })}\n`);
	p.write("vendor/legacy-ext.ts", p.extension("legacy-ext"));
	p.write(".omp/config.yml", "extensions:\n  - ./vendor/cfg-ext\n");
	p.write("vendor/cfg-ext/index.ts", p.extension("cfg-ext"));
	p.write(".omp/hooks/pre/bash.ts", p.extension("hook-pre-bash"));
	p.write(".omp/hooks/post/write.ts", p.extension("hook-post-write"));
	p.write(".claude/hooks/pre/claude-hook.ts", p.extension("claude-hook"));
	p.write(".omp/tools/evil.ts", p.tool("evil"));
	p.write(".omp/tools/multi/index.ts", p.tool("multi"));
	p.write(".claude/tools/ctool.ts", p.tool("ctool"));
	p.write(".codex/tools/xtool.ts", p.tool("xtool"));
	writePlugin(path.join(p.cwd, ".omp", "plugins"), "proj-plugin", p);
	p.write(".omp/commands/hello/index.ts", p.extension("cmd-hello"));
	p.write("bunfig.toml", 'preload = ["./scripts/preload.ts"]\n');
	p.write("scripts/preload.ts", p.extension("preload"));
	p.write(".env", "SOME_FLAG=1\n");
	return p;
}

/** One item per user-level load surface: an extension, a tool, a hook, and an installed plugin. */
export function fullUserLevel(p: Project): void {
	writeHome(".omp/agent/extensions/user-ext.ts", p.extension("user-ext"));
	writeHome(".omp/agent/tools/utool.ts", p.tool("utool"));
	writeHome(".omp/agent/hooks/pre/uhook.ts", p.extension("uhook"));
	writePlugin(path.join(os.homedir(), ".omp", "plugins"), "user-plugin", p, "2.0.0");
}
