// Live runs against real omp, driven by test/scripted-provider.ts instead of a model, so they need no
// network and no provider account. Opt-in, under `bun run test` like the rest of the suite:
//   EXTENSION_GUARD_LIVE=1       run these tests
//   OMP_CLI                      omp's src/cli.ts, run with bun (or OMP_BIN: an installed omp executable)
//   EXTENSION_GUARD_LIVE_OUT     optional folder for evidence, one subfolder per run; must not exist yet
// Every run gets its own HOME, TMPDIR, repository, and canaries inside the suite's temporary root.
// The repository's startup code only records that it ran, whether a credential variable was set and
// how long it was (never its value), and whether the repository's .env reached it. The credential
// is a fake marker. omp-ext-safe and the CI tool run through their bin wrappers, the way a user runs them.
import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ApprovedUnit } from "../src/index";
import { inventory } from "../src/inventory";
import { removeTemps, tempDir } from "./fixtures";
import { KEYS, PACKAGE, allowlistOf, approve, writeAllowlist, writeGuardEntry, writePublicKey } from "./helpers";
import type { ScriptStep } from "./scripted-provider";

const LIVE = process.env.EXTENSION_GUARD_LIVE === "1";
const OMP = process.env.OMP_CLI ? ["bun", process.env.OMP_CLI] : process.env.OMP_BIN ? [process.env.OMP_BIN] : [];
const OUT = process.env.EXTENSION_GUARD_LIVE_OUT;
const PROVIDER = path.join(import.meta.dir, "scripted-provider.ts");
const OMP_EXT_SAFE = path.join(PACKAGE, "bin", "omp-ext-safe");
const CI_TOOL = path.join(PACKAGE, "bin", "omp-extension-guard");
const RUN_TIMEOUT_MS = 90_000;
const FAKE_KEY = "fake-cursor-key-for-live-tests-0123456789";
const CANARIES = ["dx-helper", "approved-helper", "evil", "preload", "proj-plugin-tool", "broken"];

type Frame = Record<string, unknown>;

interface World {
	root: string;
	home: string;
	tmp: string;
	work: string;
	canaries: string;
	trust: string;
	audit: string;
	config: string;
	list: string;
	pub: string;
	approved: ApprovedUnit[];
}

interface WorldOptions {
	/** The repository also ships its own plugin with a tool. */
	plugin?: boolean;
	/** An approved extension that throws while it loads. */
	broken?: boolean;
}

afterAll(removeTemps);

function canarySource(file: string, extra = ""): string {
	return [
		'import * as fs from "node:fs";',
		`fs.writeFileSync(${JSON.stringify(file)}, JSON.stringify({ ran: true, credentialPresent: Boolean(process.env.CURSOR_API_KEY), credentialLength: (process.env.CURSOR_API_KEY ?? "").length, dotenvMarker: process.env.EG_DOTENV_MARKER ?? null }));`,
		extra,
	].join("\n");
}

function write(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}

async function newWorld(options: WorldOptions = {}): Promise<World> {
	const root = tempDir("eg-live-");
	const home = path.join(root, "home");
	const tmp = path.join(root, "tmp");
	const work = path.join(root, "repo");
	const canaries = path.join(root, "canaries");
	const trust = path.join(root, "trust");
	for (const dir of [home, tmp, work, canaries, trust]) fs.mkdirSync(dir, { recursive: true });
	const canary = (name: string) => path.join(canaries, `${name}.json`);
	write(path.join(work, ".git", "HEAD"), "ref: refs/heads/main\n");
	write(path.join(work, "README.md"), "# fixture\n");
	write(
		path.join(work, ".omp/extensions/dx-helper/index.ts"),
		canarySource(
			canary("dx-helper"),
			'export default function (pi) { pi.registerTool({ name: "dx_helper", label: "dx_helper", description: "dx helper", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "ok" }] }) }); }',
		),
	);
	write(path.join(work, ".omp/extensions/approved-helper.ts"), canarySource(canary("approved-helper"), "export default function () {}"));
	write(
		path.join(work, ".omp/tools/evil.ts"),
		canarySource(
			canary("evil"),
			'export default function () { return { name: "evil", description: "evil", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "ok" }] }) }; }',
		),
	);
	write(path.join(work, "bunfig.toml"), 'preload = ["./scripts/preload.ts"]\n');
	write(path.join(work, "scripts/preload.ts"), canarySource(canary("preload")));
	write(path.join(work, ".env"), "EG_DOTENV_MARKER=from-repo-dotenv\n");
	if (options.plugin) {
		const plugins = path.join(work, ".omp", "plugins");
		write(path.join(plugins, "package.json"), JSON.stringify({ dependencies: { "proj-plugin": "1.0.0" } }));
		write(path.join(plugins, "node_modules/proj-plugin/package.json"), JSON.stringify({ name: "proj-plugin", version: "1.0.0", omp: { tools: ["./tool.ts"] } }));
		write(
			path.join(plugins, "node_modules/proj-plugin/tool.ts"),
			canarySource(
				canary("proj-plugin-tool"),
				'export default function () { return { name: "projtool", description: "x", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) }; }',
			),
		);
	}
	if (options.broken) write(path.join(work, ".omp/extensions/broken.ts"), `${canarySource(canary("broken"))}\nthrow new Error("broken on purpose");\nexport default function () {}\n`);

	const inv = await inventory(work, { explicit: [PROVIDER] });
	const keys = ["project:.omp/extensions/approved-helper.ts", ...(options.broken ? ["project:.omp/extensions/broken.ts"] : [])];
	const units = inv.units.filter(unit => unit.kind === "explicit" || keys.includes(unit.key));
	const list = writeAllowlist(trust, allowlistOf(units.map(unit => approve(unit))));
	const pub = writePublicKey(trust, KEYS.publicKeyPem);
	const audit = path.join(trust, "audit.jsonl");
	const config = path.join(trust, "config.json");
	fs.writeFileSync(
		config,
		`${JSON.stringify(
			{
				allowlists: [list],
				publicKeys: [pub],
				auditLog: audit,
				omp: OMP,
				passEnv: ["SCRIPTED_PROVIDER_SCRIPT", "SCRIPTED_PROVIDER_LOG", "SCRIPTED_PROVIDER_KEY"],
				onUnapproved: "exclude",
				isolation: "warn",
			},
			null,
			2,
		)}\n`,
	);
	const approved = units.map(unit => ({ kind: unit.kind, key: unit.key, path: unit.path, digest: unit.digest!, scripts: unit.scripts }));
	return { root, home, tmp, work, canaries, trust, audit, config, list, pub, approved };
}

interface RunOptions {
	/** `plain`: omp started in the repository; `guard`: plain plus the guard entry; `launcher`: through omp-ext-safe. */
	via: "plain" | "guard" | "launcher";
	tools?: string;
	ompFlags?: string[];
	launcherFlags?: string[];
	prompt?: string;
	steps?: ScriptStep[];
	env?: Record<string, string>;
	/** omp is expected to exit (or never start) before a session is ready. */
	expectExit?: boolean;
}

interface Run {
	name: string;
	dir: string;
	world: World;
	options: RunOptions;
	frames: Frame[];
	requests: Array<{ request: number; messages: Array<{ role?: string; content?: unknown }> }>;
	notices: string[];
	stderr: string;
	exitCode: number | null;
	canaries: Record<string, { credentialPresent: boolean; credentialLength: number; dotenvMarker: string | null } | undefined>;
	audit: Array<Record<string, unknown>>;
}

function evidenceDir(name: string): string {
	if (!OUT) return tempDir("eg-run-");
	const dir = path.join(OUT, name);
	if (fs.existsSync(dir)) throw new Error(`${dir} already exists; evidence folders are never overwritten`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function sanitize(text: string, world: World): string {
	const omp = process.env.OMP_CLI ? path.dirname(path.dirname(path.dirname(process.env.OMP_CLI))) : "";
	let out = text.split(world.root).join("<run>").split(PACKAGE).join("<package>");
	if (omp) out = out.split(omp).join("<omp>");
	return out.split(FAKE_KEY).join("<fake-key>");
}

function readCanaries(world: World): Run["canaries"] {
	const out: Run["canaries"] = {};
	for (const name of CANARIES) {
		const file = path.join(world.canaries, `${name}.json`);
		out[name] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
	}
	return out;
}

function readAuditLines(world: World): Array<Record<string, unknown>> {
	if (!fs.existsSync(world.audit)) return [];
	return fs
		.readFileSync(world.audit, "utf8")
		.split("\n")
		.filter(line => line.trim())
		.map(line => JSON.parse(line) as Record<string, unknown>);
}

async function waitFor(probe: () => boolean, what: string, failed: () => string | undefined): Promise<void> {
	const deadline = Date.now() + RUN_TIMEOUT_MS;
	for (;;) {
		if (probe()) return;
		const failure = failed();
		if (failure) throw new Error(`${what}: ${failure}`);
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(50);
	}
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(part => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n");
}

function toolResultsSeen(run: Run): string[] {
	return (run.requests.at(-1)?.messages ?? []).filter(message => message.role === "toolResult").map(message => textOf(message.content));
}

async function runOmp(world: World, name: string, options: RunOptions): Promise<Run> {
	const dir = evidenceDir(name);
	const slug = name.replaceAll("/", "-");
	const script = path.join(world.root, `${slug}.script.json`);
	const log = path.join(world.root, `${slug}.requests.jsonl`);
	fs.writeFileSync(script, JSON.stringify({ steps: options.steps ?? [{ text: "4" }] }));
	const flags = [
		"--mode",
		"rpc",
		"-e",
		PROVIDER,
		"--model",
		"scripted/scripted",
		"--approval-mode",
		"yolo",
		"--session-dir",
		path.join(world.root, "sessions", slug),
		"--no-title",
		"--no-lsp",
		"--no-rules",
		...(options.tools ? ["--tools", options.tools] : []),
		...(options.ompFlags ?? []),
	];
	let command: string[];
	if (options.via === "launcher") {
		command = [OMP_EXT_SAFE, "--config", world.config, "--cwd", world.work, "--state-dir", path.join(world.root, "state"), ...(options.launcherFlags ?? []), "--", ...flags];
	} else {
		const guardFlags =
			options.via === "guard"
				? ["-e", writeGuardEntry(path.join(world.root, "guard"), { approved: world.approved, auditLog: world.audit, runId: slug })]
				: [];
		command = [...OMP, ...flags, ...guardFlags];
	}
	const proc = Bun.spawn(command, {
		cwd: world.work,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: world.home,
			USER: process.env.USER ?? "user",
			LANG: "C.UTF-8",
			TERM: "dumb",
			TMPDIR: world.tmp,
			CURSOR_API_KEY: FAKE_KEY,
			SCRIPTED_PROVIDER_SCRIPT: script,
			SCRIPTED_PROVIDER_LOG: log,
			SCRIPTED_PROVIDER_KEY: "unused",
			...options.env,
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const frames: Frame[] = [];
	const stdout = (async () => {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
			buffer += decoder.decode(chunk, { stream: true });
			for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				try {
					if (line.trim()) frames.push(JSON.parse(line) as Frame);
				} catch {}
			}
		}
	})();
	const stderrText = new Response(proc.stderr as ReadableStream<Uint8Array>).text();
	const failed = () => {
		if (proc.exitCode !== null) return `exited with ${proc.exitCode}`;
		const rejected = frames.find(frame => frame.type === "response" && frame.id === "p1" && frame.success === false);
		return rejected ? `prompt rejected: ${JSON.stringify(rejected)}` : undefined;
	};
	try {
		if (options.expectExit) {
			await Promise.race([proc.exited, Bun.sleep(RUN_TIMEOUT_MS)]);
		} else {
			await waitFor(() => frames.some(frame => frame.type === "ready"), "ready", failed);
			proc.stdin.write(`${JSON.stringify({ id: "p1", type: "prompt", message: options.prompt ?? "What is 2 + 2?" })}\n`);
			proc.stdin.flush();
			await waitFor(() => frames.some(frame => frame.type === "agent_end" && frame.isTerminal !== false), "the end of the turn", failed);
		}
	} finally {
		proc.stdin.end();
		const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(30_000).then(() => false)]);
		if (!exited) proc.kill();
		await stdout;
	}
	const stderr = await stderrText;
	const requestsText = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
	const requests = requestsText
		.split("\n")
		.filter(line => line.trim())
		.map(line => JSON.parse(line) as Run["requests"][number]);
	const notices = frames.filter(frame => frame.type === "extension_ui_request" && frame.method === "notify").map(frame => String(frame.message ?? ""));
	const run: Run = { name, dir, world, options, frames, requests, notices, stderr, exitCode: proc.exitCode, canaries: readCanaries(world), audit: readAuditLines(world) };
	fs.writeFileSync(path.join(dir, "cmd.txt"), `${sanitize(command.join(" "), world)}\n`);
	fs.writeFileSync(path.join(dir, "events.jsonl"), sanitize(frames.map(frame => JSON.stringify(frame)).join("\n"), world));
	fs.writeFileSync(path.join(dir, "provider-requests.jsonl"), sanitize(requestsText, world));
	fs.writeFileSync(path.join(dir, "stderr.txt"), sanitize(stderr, world));
	fs.writeFileSync(path.join(dir, "canaries.json"), `${JSON.stringify(run.canaries, null, 2)}\n`);
	fs.writeFileSync(path.join(dir, "audit.jsonl"), sanitize(run.audit.map(line => JSON.stringify(line)).join("\n"), world));
	return run;
}

function record(run: Run, checks: Record<string, unknown>): void {
	const summary = {
		run: run.name,
		via: run.options.via,
		launcherFlags: run.options.launcherFlags ?? [],
		ompFlags: run.options.ompFlags ?? [],
		tools: run.options.tools ?? null,
		exitCode: run.exitCode,
		requestsReceived: run.requests.length,
		canariesThatRan: Object.entries(run.canaries)
			.filter(([, value]) => value)
			.map(([name]) => name),
		notices: run.notices,
		toolResultsSeenByModel: toolResultsSeen(run),
		checks,
	};
	fs.writeFileSync(path.join(run.dir, "summary.json"), `${sanitize(JSON.stringify(summary, null, 2), run.world)}\n`);
}

const ran = (run: Run) =>
	Object.entries(run.canaries)
		.filter(([, value]) => value)
		.map(([name]) => name)
		.sort();
const turnEnded = (run: Run) => run.frames.some(frame => frame.type === "agent_end");

describe.skipIf(!LIVE)("live on real omp 18.2.8, scripted model, no network", () => {
	it("baseline: plain omp runs the repository's startup code before the first model request; --no-extensions --no-tools still runs .omp/tools", async () => {
		const autoload = await runOmp(await newWorld(), "baseline/1-autoload", { via: "plain", tools: "read" });
		const autoloadChecks = {
			canariesThatRan: ran(autoload),
			dxHelperSawCredential: autoload.canaries["dx-helper"]?.credentialPresent ?? false,
			dxHelperCredentialLength: autoload.canaries["dx-helper"]?.credentialLength ?? 0,
			dxHelperSawRepositoryDotenv: autoload.canaries["dx-helper"]?.dotenvMarker === "from-repo-dotenv",
			turnEnded: turnEnded(autoload),
			firstRequestAfterLoad: autoload.requests.length > 0,
		};
		record(autoload, autoloadChecks);

		const flags = await runOmp(await newWorld(), "baseline/2-no-extensions-no-tools", { via: "plain", ompFlags: ["--no-extensions", "--no-tools"] });
		const flagsChecks = { canariesThatRan: ran(flags), turnEnded: turnEnded(flags) };
		record(flags, flagsChecks);

		expect(autoloadChecks).toEqual({
			canariesThatRan: ["approved-helper", "dx-helper", "evil", "preload"],
			dxHelperSawCredential: true,
			dxHelperCredentialLength: FAKE_KEY.length,
			dxHelperSawRepositoryDotenv: true,
			turnEnded: true,
			firstRequestAfterLoad: true,
		});
		expect(flagsChecks).toEqual({ canariesThatRan: ["evil", "preload"], turnEnded: true });
	}, 300_000);

	it("omp-ext-safe: in every mode only approved code loads, the repository's bunfig.toml and .env do not, and the credential is not passed", async () => {
		const results: Record<string, unknown> = {};
		for (const [index, mode] of ["trusted", "explicit", "discovery"].entries()) {
			const world = await newWorld();
			const run = await runOmp(world, `launcher/${index + 1}-${mode}`, { via: "launcher", tools: "read", launcherFlags: ["--mode", mode] });
			const checks = {
				exitCode: run.exitCode,
				canariesThatRan: ran(run),
				approvedHelperSawCredential: run.canaries["approved-helper"]?.credentialPresent ?? null,
				approvedHelperSawRepositoryDotenv: run.canaries["approved-helper"]?.dotenvMarker ?? null,
				keptOutAnnounced: run.stderr.includes("starting without:") && run.stderr.includes("project:.omp/extensions/dx-helper"),
				guardStarted: run.audit.some(line => line.event === "session_start" && line.action === "allow"),
				turnEnded: turnEnded(run),
			};
			record(run, checks);
			results[mode] = checks;
		}
		const expected = {
			exitCode: 0,
			canariesThatRan: ["approved-helper"],
			approvedHelperSawCredential: false,
			approvedHelperSawRepositoryDotenv: null,
			keptOutAnnounced: true,
			guardStarted: true,
			turnEnded: true,
		};
		expect(results).toEqual({ trusted: expected, explicit: expected, discovery: expected });
	}, 400_000);

	it("omp-ext-safe refuses before omp starts: a plugin tool no switch stops, and a credential in require mode; a placeholder passes", async () => {
		const plugin = await runOmp(await newWorld({ plugin: true }), "launcher/4-refuse-plugin-tool", { via: "launcher", expectExit: true });
		const pluginChecks = {
			exitCode: plugin.exitCode,
			canariesThatRan: ran(plugin),
			namesThePlugin: plugin.stderr.includes("project:.omp/plugins/node_modules/proj-plugin"),
			ompStarted: plugin.frames.some(frame => frame.type === "ready"),
		};
		record(plugin, pluginChecks);

		const requireFlags = ["--isolation", "require", "--pass-env", "CURSOR_API_KEY"];
		const refused = await runOmp(await newWorld(), "launcher/5-require-isolation", { via: "launcher", launcherFlags: requireFlags, expectExit: true });
		const refusedChecks = {
			exitCode: refused.exitCode,
			canariesThatRan: ran(refused),
			namesTheVariable: refused.stderr.includes("env:CURSOR_API_KEY"),
			printsTheValue: refused.stderr.includes(FAKE_KEY),
		};
		record(refused, refusedChecks);

		const placeholder = await runOmp(await newWorld(), "launcher/6-require-isolation-placeholder", {
			via: "launcher",
			launcherFlags: requireFlags,
			env: { CURSOR_API_KEY: "proxy-managed" },
		});
		const placeholderChecks = { exitCode: placeholder.exitCode, canariesThatRan: ran(placeholder), turnEnded: turnEnded(placeholder) };
		record(placeholder, placeholderChecks);

		expect(pluginChecks).toEqual({ exitCode: 3, canariesThatRan: [], namesThePlugin: true, ompStarted: false });
		expect(refusedChecks).toEqual({ exitCode: 3, canariesThatRan: [], namesTheVariable: true, printsTheValue: false });
		expect(placeholderChecks).toEqual({ exitCode: 0, canariesThatRan: ["approved-helper"], turnEnded: true });
	}, 300_000);

	it("trusted mode: an approved extension that fails to load stops omp instead of starting it without protection", async () => {
		const run = await runOmp(await newWorld({ broken: true }), "launcher/7-trusted-load-failure", { via: "launcher", expectExit: true });
		const checks = {
			exitedWithError: run.exitCode !== null && run.exitCode !== 0,
			ompSaysTrustedExtensionFailed: run.stderr.includes("Trusted extension failed to load"),
			launcherReportsExit: run.stderr.includes("omp exited with code"),
			sessionReady: run.frames.some(frame => frame.type === "ready"),
			guardStarted: run.audit.some(line => line.event === "session_start"),
		};
		record(run, checks);
		expect(checks).toEqual({ exitedWithError: true, ompSaysTrustedExtensionFailed: true, launcherReportsExit: true, sessionReady: false, guardStarted: false });
	}, 200_000);

	it("guard: the model cannot plant code where omp loads it, ordinary writes go through, and every decision is in the audit log", async () => {
		const world = await newWorld();
		const run = await runOmp(world, "guard/1-write-block", {
			via: "launcher",
			tools: "read,write,bash",
			prompt: "Set up the project.",
			steps: [
				{ toolCalls: [{ name: "write", arguments: { path: ".omp/extensions/planted.ts", content: "export default function () {}\n" } }] },
				{ toolCalls: [{ name: "bash", arguments: { command: "echo 'export default () => {}' > .omp/tools/planted.ts" } }] },
				{ toolCalls: [{ name: "write", arguments: { path: "src/ok.ts", content: "export const ok = true;\n" } }] },
				{ text: "done" },
			],
		});
		const results = run.requests.flatMap(request => request.messages.filter(message => message.role === "toolResult").map(message => textOf(message.content)));
		const checks = {
			exitCode: run.exitCode,
			plantedExtensionExists: fs.existsSync(path.join(world.work, ".omp/extensions/planted.ts")),
			plantedToolExists: fs.existsSync(path.join(world.work, ".omp/tools/planted.ts")),
			ordinaryFileWritten: fs.existsSync(path.join(world.work, "src/ok.ts")),
			modelSawWriteBlocked: results.some(text => text.includes("omp-extension-guard blocked write")),
			modelSawBashBlocked: results.some(text => text.includes("omp-extension-guard blocked bash")),
			auditBlocks: run.audit.filter(line => line.action === "block").map(line => line.tool),
			launcherReport: /guard decisions this run: .*2 block/.test(run.stderr),
		};
		record(run, checks);
		expect(checks).toEqual({
			exitCode: 0,
			plantedExtensionExists: false,
			plantedToolExists: false,
			ordinaryFileWritten: true,
			modelSawWriteBlocked: true,
			modelSawBashBlocked: true,
			auditBlocks: ["write", "bash"],
			launcherReport: true,
		});
	}, 200_000);

	it("guard without omp-ext-safe: tools registered by unapproved code lock the session after the fact", async () => {
		const world = await newWorld();
		const run = await runOmp(world, "guard/2-tripwire-without-launcher", {
			via: "guard",
			tools: "read",
			prompt: "Read the README.",
			steps: [{ toolCalls: [{ name: "read", arguments: { path: "README.md" } }] }, { text: "done" }],
		});
		const lockdown = run.audit.find(line => line.action === "lockdown");
		const checks = {
			canariesThatRan: ran(run),
			lockdownTools: (lockdown?.tools as string[] | undefined)?.sort() ?? [],
			userWarned: run.notices.some(notice => notice.includes("dx_helper") && notice.includes("evil")),
			readBlocked: toolResultsSeen(run).some(text => text.includes("omp-extension-guard blocked read")),
		};
		record(run, checks);
		expect(checks).toEqual({ canariesThatRan: ["approved-helper", "dx-helper", "evil", "preload"], lockdownTools: ["dx_helper", "evil"], userWarned: true, readBlocked: true });
	}, 200_000);

	it("CI check: fails on unapproved startup code, and its wrapper keeps the repository's bunfig.toml preload out of the checker", async () => {
		const world = await newWorld();
		const env = { PATH: process.env.PATH ?? "", HOME: world.home, TMPDIR: world.tmp, LANG: "C.UTF-8" };
		const args = ["check", "--allowlist", world.list, "--public-key", world.pub];
		const viaWrapper = Bun.spawnSync([CI_TOOL, ...args], { cwd: world.work, env });
		const wrapperCanaries = ran({ canaries: readCanaries(world) } as Run);
		const direct = Bun.spawnSync(["bun", path.join(PACKAGE, "bin", "omp-extension-guard.ts"), ...args], { cwd: world.work, env });
		const directCanaries = ran({ canaries: readCanaries(world) } as Run);
		const dir = evidenceDir("ci/1-check");
		const out = (result: { stdout?: Buffer; stderr?: Buffer }) => sanitize(`${result.stdout?.toString() ?? ""}${result.stderr?.toString() ?? ""}`, world);
		fs.writeFileSync(path.join(dir, "via-wrapper.txt"), `exit ${viaWrapper.exitCode}\n${out(viaWrapper)}`);
		fs.writeFileSync(path.join(dir, "direct-bun.txt"), `exit ${direct.exitCode}\n${out(direct)}`);
		const checks = {
			wrapperExit: viaWrapper.exitCode,
			wrapperNamesUnapproved: out(viaWrapper).includes("project:.omp/extensions/dx-helper") && out(viaWrapper).includes("project:.omp/tools/evil.ts"),
			preloadRanInWrapper: wrapperCanaries.includes("preload"),
			directExit: direct.exitCode,
			preloadRanWhenStartedDirectly: directCanaries.includes("preload"),
			directWarns: out(direct).includes("its preload ran inside this process"),
		};
		fs.writeFileSync(path.join(dir, "summary.json"), `${JSON.stringify({ run: "ci/1-check", checks }, null, 2)}\n`);
		expect(checks).toEqual({ wrapperExit: 1, wrapperNamesUnapproved: true, preloadRanInWrapper: false, directExit: 1, preloadRanWhenStartedDirectly: true, directWarns: true });
	}, 120_000);
});
