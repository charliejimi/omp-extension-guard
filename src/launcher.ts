// omp-ext-safe: before omp starts, inventories every unit of code omp would load, checks each
// against the signed allowlists, checks which real credentials the omp process could reach, and
// starts omp with only the approved units: through --trusted-extension (default), --no-extensions
// and -e, or auto-discovery with every unapproved unit switched off in a settings overlay. It
// starts omp from an empty directory, so the project's bunfig.toml preload and .env do not load,
// verifies the result with omp's own discovery, and afterwards reports the guard's decisions.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { getAgentDbPath, getLogsDir } from "@oh-my-pi/pi-utils/dirs";
import { type ApprovalStatus, type UnitKind, approvalStatus, digestUnit, loadTrustedAllowlists } from "./allowlist";
import {
	type GuardConfig,
	ISOLATION_MODES,
	type IsolationMode,
	LOAD_MODES,
	type LoadMode,
	UNAPPROVED_POLICIES,
	type UnapprovedPolicy,
	defaultAuditLog,
	defaultConfigPath,
	defaultStateDir,
	loadConfig,
	resolveConfigPath,
} from "./config";
import type { ApprovedUnit, ExtensionGuardOptions } from "./index";
import { type Unit, inventory, keyPath, loadSet } from "./inventory";
import { type Finding, checkExposure, childEnv } from "./isolation";

export const EXIT_USAGE = 2;
export const EXIT_REFUSED = 3;

const PACKAGE_DIR = path.resolve(import.meta.dir, "..");

export interface LaunchIO {
	/** One line of the launcher's own output. It goes to stderr, so it never mixes with omp's stdout. */
	err(line: string): void;
	/** Asks the person at the terminal; absent when there is none. */
	ask?(question: string): Promise<string | undefined>;
}

export interface UnitStatus extends Unit {
	status: ApprovalStatus;
}

/** omp's own arguments, minus the ones the launcher sets itself. */
export interface Passthrough {
	flags: string[];
	/** omp's `--` and everything after it. */
	rest: string[];
	/** The user's `--config` overlays, absolute; the launcher's overlay goes after them. */
	configFiles: string[];
	/** Extension paths named with `-e`, `--extension`, `--hook`, or `--trusted-extension`. */
	explicit: string[];
	/** A `--cwd` among omp's arguments. */
	cwd?: string;
}

export interface Plan {
	/** The project omp runs in. */
	cwd: string;
	mode: LoadMode;
	/** Everything omp would load if started directly with these arguments, with its approval status. */
	units: UnitStatus[];
	/** Approved extension entries the launcher names on omp's command line. */
	extensions: string[];
	/** Settings for the run's `--config` overlay. */
	overlay: { disabledExtensions: string[]; extensions?: string[] };
	/** Unapproved units the run keeps out. */
	excluded: UnitStatus[];
	/** Approved units, for the guard. */
	approved: ApprovedUnit[];
	/** Why omp cannot start safely; empty when it can. */
	refusals: string[];
	/** Allowlists that were left out, and why. */
	problems: string[];
	findings: Finding[];
	/** The environment omp gets. */
	env: Record<string, string>;
	passthrough: Passthrough;
}

export interface PlanOptions {
	/** The project omp runs in. */
	cwd: string;
	config: GuardConfig;
	ompArgs?: string[];
	/** The environment to start from; the process's own by default. */
	env?: Readonly<Record<string, string | undefined>>;
	now?: Date;
}

function expandHome(value: string): string {
	return value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value;
}

const VALUE_FLAGS = new Map([
	["-e", "explicit"],
	["--extension", "explicit"],
	["--hook", "explicit"],
	["--trusted-extension", "explicit"],
	["--config", "config"],
	["--cwd", "cwd"],
]);

/** Separates the arguments the launcher owns from the ones it passes on; relative paths resolve against `base`. */
export function parseOmpArgs(args: readonly string[], base: string): Passthrough {
	const at = args.indexOf("--");
	const head = at < 0 ? [...args] : args.slice(0, at);
	const rest = at < 0 ? [] : args.slice(at);
	const out: Passthrough = { flags: [], rest, configFiles: [], explicit: [] };
	for (let i = 0; i < head.length; i++) {
		const arg = head[i]!;
		if (arg === "--no-extensions") continue;
		const equals = arg.indexOf("=");
		const name = arg.startsWith("--") && equals > 0 ? arg.slice(0, equals) : arg;
		const role = VALUE_FLAGS.get(name);
		if (!role) {
			out.flags.push(arg);
			continue;
		}
		const value = name === arg ? head[++i] : arg.slice(equals + 1);
		if (value === undefined) throw new Error(`${name} needs a value`);
		const resolved = path.resolve(base, expandHome(value));
		if (role === "explicit") out.explicit.push(resolved);
		else if (role === "config") out.configFiles.push(resolved);
		else out.cwd = resolved;
	}
	return out;
}

function isInside(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The `disabledExtensions` id omp gives a tool or extension unit at `abs`, from its file or directory name. */
function derivedId(kind: UnitKind, abs: string): string | undefined {
	const isDir = fs.statSync(abs).isDirectory();
	const name = isDir ? path.basename(abs) : path.basename(abs).replace(/\.(ts|js|mjs|cjs)$/, "");
	if (kind === "tool") return `tool:${name}`;
	if (kind === "extension") return `extension-module:${name}`;
	return undefined;
}

const STATUS_TEXT: Record<ApprovalStatus, string> = {
	approved: "approved",
	"not-approved": "not approved",
	modified: "changed since approval",
	revoked: "approval revoked",
	unreadable: "could not be hashed",
	"no-allowlist": "no valid allowlist",
};

export function describeStatus(status: ApprovalStatus): string {
	return STATUS_TEXT[status];
}

/** What omp would load, what the run lets in, what it keeps out, and whether it can start at all. */
export async function plan(options: PlanOptions): Promise<Plan> {
	const { config } = options;
	const passthrough = parseOmpArgs(options.ompArgs ?? [], path.resolve(options.cwd));
	const cwd = passthrough.cwd ?? path.resolve(options.cwd);
	const mode = config.mode ?? "trusted";
	const trusted = loadTrustedAllowlists({ allowlists: config.allowlists, publicKeys: config.publicKeys, now: options.now });
	const inv = await inventory(cwd, { explicit: passthrough.explicit, configFiles: passthrough.configFiles });
	const units: UnitStatus[] = inv.units.map(unit => ({ ...unit, status: approvalStatus(unit, trusted.approvals) }));
	const isApproved = (unit: UnitStatus) => unit.status === "approved";
	const approvedUnits = units.filter(isApproved);
	const refusals: string[] = [];
	const disabled = new Set(inv.disabledExtensions);
	const approvedIds = new Map<string, string>();
	for (const unit of approvedUnits) for (const entry of unit.entries) if (entry.disableId) approvedIds.set(entry.disableId, unit.key);
	// omp de-duplicates tools and extension modules by name, so an unapproved unit can shadow an
	// approved one, which then never shows up in the inventory. Ids of approved units on disk count too.
	for (const [key, entries] of trusted.approvals?.entries ?? []) {
		const abs = keyPath(key, inv);
		if (!abs || !fs.existsSync(abs)) continue;
		for (const entry of entries) {
			const id = derivedId(entry.kind, abs);
			if (!id || approvedIds.has(id)) continue;
			try {
				if (digestUnit(abs) === entry.digest) approvedIds.set(id, key);
			} catch {}
		}
	}

	const turnOff = (unit: UnitStatus, id: string) => {
		const owner = approvedIds.get(id);
		if (owner) refusals.push(`${unit.key} (${describeStatus(unit.status)}): turning it off with ${id} would also turn off the approved ${owner}`);
		else disabled.add(id);
	};

	const extensionKinds = new Set(["extension", "hook", "plugin", "configured", "explicit"]);
	const extensions =
		mode === "discovery"
			? approvedUnits.filter(unit => unit.kind === "explicit").flatMap(unit => unit.entries.filter(entry => entry.role === "extension").map(entry => entry.path))
			: approvedUnits.filter(unit => extensionKinds.has(unit.kind)).flatMap(unit => unit.entries.filter(entry => entry.role === "extension").map(entry => entry.path));
	const overlay: Plan["overlay"] = { disabledExtensions: [] };
	if (mode === "discovery") overlay.extensions = approvedUnits.filter(unit => unit.kind === "configured").map(unit => unit.path);

	const excluded: UnitStatus[] = [];
	for (const unit of units) {
		if (isApproved(unit)) continue;
		excluded.push(unit);
		for (const entry of unit.entries) {
			if (entry.role === "preload") continue;
			if (entry.role === "tool") {
				if (entry.disableId) turnOff(unit, entry.disableId);
				else refusals.push(`${unit.key} (${describeStatus(unit.status)}): its tool ${path.basename(entry.path)} loads whatever the flags say, and no setting turns it off`);
				continue;
			}
			if (mode !== "discovery" || unit.kind === "explicit") continue;
			if (entry.role === "command") {
				refusals.push(`${unit.key} (${describeStatus(unit.status)}): a command module; only --no-extensions or --trusted-extension keep it out, so use another mode`);
			} else if (entry.switches.includes("overlay-extensions")) {
				// Left out of the overlay's `extensions:` list.
			} else if (entry.disableId) {
				turnOff(unit, entry.disableId);
			} else {
				refusals.push(`${unit.key} (${describeStatus(unit.status)}): nothing in discovery mode keeps ${path.basename(entry.path)} out`);
			}
		}
	}
	overlay.disabledExtensions = [...disabled];

	const draft: Plan = {
		cwd,
		mode,
		units,
		extensions,
		overlay,
		excluded,
		approved: approvedUnits.filter(unit => unit.digest).map(unit => ({ kind: unit.kind, key: unit.key, path: unit.path, digest: unit.digest!, scripts: unit.scripts })),
		refusals,
		problems: trusted.problems,
		findings: [],
		env: {},
		passthrough,
	};
	if (refusals.length === 0) refusals.push(...(await verify(draft)));

	const env = childEnv(options.env ?? process.env, config.passEnv ?? []);
	draft.env = env;
	const isolation = config.isolation ?? "warn";
	if (isolation !== "off") {
		const home = env.HOME ?? os.homedir();
		const agentDir = env.PI_CODING_AGENT_DIR ?? path.join(home, ".omp", "agent");
		draft.findings = checkExposure({
			env,
			argv: [...passthrough.flags, ...passthrough.rest],
			home,
			storePath: getAgentDbPath(agentDir),
			placeholder: config.placeholder,
			accept: config.accept,
			extraFiles: config.credentialFiles,
		});
		if (isolation === "require") {
			for (const finding of draft.findings) if (!finding.accepted) refusals.push(`credential within omp's reach: ${finding.key} (${finding.detail})`);
		}
	}
	return draft;
}

/** Re-runs omp's discovery with the run's flags and overlay; anything unapproved still in the result is a refusal. */
async function verify(draft: Plan): Promise<string[]> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ext-safe-verify-"));
	const overlayFile = path.join(dir, "overlay.yml");
	try {
		fs.writeFileSync(overlayFile, renderOverlay(draft));
		const discovery = draft.mode === "discovery";
		const truth = await loadSet(draft.cwd, {
			mode: discovery ? "merge" : "explicit-only",
			explicit: draft.extensions,
			configFiles: [...draft.passthrough.configFiles, overlayFile],
		});
		const approvedPaths = draft.approved.map(unit => unit.path);
		const allowed = (file: string) => approvedPaths.some(unitPath => isInside(path.resolve(file), unitPath));
		const leftovers = [...truth.extensions, ...truth.tools, ...(discovery ? truth.commands : [])].filter(file => !allowed(file));
		return leftovers.map(file => `${file} would still load; omp's discovery found it after the overlay was applied`);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** Asks before starting without unapproved units; refuses outright when the plan has a refusal. */
export async function decide(pl: Plan, policy: UnapprovedPolicy, io: LaunchIO): Promise<"start" | "refuse"> {
	if (pl.refusals.length > 0) return "refuse";
	if (pl.excluded.length === 0) return "start";
	if (policy === "exclude") return "start";
	if (policy === "refuse" || !io.ask) return "refuse";
	const question = [
		"omp-ext-safe: omp would load this code, which is not approved:",
		...pl.excluded.map(unit => `  - ${unit.key} (${unit.kind}, ${describeStatus(unit.status)})`),
		"Start omp anyway?",
		"  1) No, do not start (default)",
		"  2) Start without it",
		"Choose 1 or 2: ",
	].join("\n");
	return (await io.ask(question))?.trim() === "2" ? "start" : "refuse";
}

/** The run's settings overlay. Arrays in an overlay replace the user's and the project's lists. */
export function renderOverlay(pl: Pick<Plan, "overlay">): string {
	const lines = ["# Written by omp-ext-safe for one run and passed to omp with --config.", `disabledExtensions: ${JSON.stringify(pl.overlay.disabledExtensions)}`];
	if (pl.overlay.extensions) lines.push(`extensions: ${JSON.stringify(pl.overlay.extensions)}`);
	return `${lines.join("\n")}\n`;
}

/** The per-run guard entry, a single module file, with every setting spelled out. */
export function renderEntry(options: ExtensionGuardOptions): string {
	return [
		"// Written by omp-ext-safe for one run. It configures the guard explicitly, so no environment",
		"// variable or repository file can point it at another allowlist or key.",
		`import { createExtensionGuard } from ${JSON.stringify(path.join(PACKAGE_DIR, "src", "index.ts"))};`,
		`export default createExtensionGuard(${JSON.stringify(options, null, "\t")});`,
		"",
	].join("\n");
}

/** omp's command line: the project, the approved extensions and the guard last, the overlays, then omp's own arguments. */
export function buildCommand(pl: Plan, entry: string, overlayFile: string, config: GuardConfig): string[] {
	const named = [...pl.extensions, entry];
	const load =
		pl.mode === "trusted"
			? named.flatMap(file => ["--trusted-extension", file])
			: [...(pl.mode === "explicit" ? ["--no-extensions"] : []), ...named.flatMap(file => ["-e", file])];
	const overlays = [...pl.passthrough.configFiles, overlayFile].flatMap(file => ["--config", file]);
	return [...(config.omp ?? ["omp"]), "--cwd", pl.cwd, ...load, ...overlays, ...pl.passthrough.flags, ...pl.passthrough.rest];
}

function readJsonLines(file: string): Array<Record<string, unknown>> {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const lines: Array<Record<string, unknown>> = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value = JSON.parse(line) as unknown;
			if (value !== null && typeof value === "object") lines.push(value as Record<string, unknown>);
		} catch {}
	}
	return lines;
}

/** Guard handler failures in omp's log for the run's process. */
function handlerAlerts(pid: number, entry: string): string[] {
	let dir: string;
	let names: string[];
	try {
		dir = getLogsDir();
		names = fs.readdirSync(dir).filter(name => name.includes(`.${pid}.log`));
	} catch {
		return [];
	}
	const entries = new Set([entry, fs.existsSync(entry) ? fs.realpathSync(entry) : entry]);
	const alerts: string[] = [];
	for (const name of names) {
		for (const line of readJsonLines(path.join(dir, name))) {
			const message = typeof line.message === "string" ? line.message : "";
			if (message === "Extension handler timed out" && entries.has(String(line.extensionPath))) {
				alerts.push(
					line.event === "tool_call"
						? "the guard's tool_call handler timed out; omp blocked that call."
						: `the guard's ${String(line.event)} handler timed out.`,
				);
			} else if (message.startsWith("omp-extension-guard:")) {
				alerts.push(`${message.slice("omp-extension-guard:".length).trim()}.`);
			}
		}
	}
	return alerts;
}

function report(io: LaunchIO, auditLog: string, runId: string, pid: number, entry: string, code: number): void {
	const counts = new Map<string, number>();
	for (const line of readJsonLines(auditLog)) {
		if (line.run === runId && line.event === "tool_call" && typeof line.action === "string") counts.set(line.action, (counts.get(line.action) ?? 0) + 1);
		if (line.run === runId && line.action === "lockdown") io.err("omp-ext-safe: ALERT: the guard locked the session because unapproved code registered tools.");
	}
	if (counts.size > 0) io.err(`omp-ext-safe: guard decisions this run: ${[...counts].map(([action, n]) => `${n} ${action}`).join(", ")}.`);
	for (const alert of handlerAlerts(pid, entry)) io.err(`omp-ext-safe: ALERT: ${alert}`);
	if (code !== 0) io.err(`omp-ext-safe: omp exited with code ${code}.`);
}

export interface LaunchOptions extends PlanOptions {
	/** Where each run's overlay, guard entry, and empty launch directory are written; removed after the run. */
	stateDir?: string;
	io: LaunchIO;
}

/** The whole run: plan, decision, overlay and entry, omp, report. Returns omp's exit code. */
export async function launch(options: LaunchOptions): Promise<number> {
	const { io, config } = options;
	const pl = await plan(options);
	for (const problem of pl.problems) io.err(`omp-ext-safe: allowlist left out: ${problem}`);
	for (const finding of pl.findings) io.err(`omp-ext-safe: ${finding.accepted ? "accepted" : "credential"}: ${finding.key}: ${finding.detail}`);
	const outcome = await decide(pl, config.onUnapproved ?? "ask", io);
	if (outcome === "refuse") {
		io.err("omp-ext-safe: not starting omp.");
		for (const refusal of pl.refusals) io.err(`  - ${refusal}`);
		if (pl.refusals.length === 0) for (const unit of pl.excluded) io.err(`  - not approved: ${unit.key} (${describeStatus(unit.status)})`);
		return EXIT_REFUSED;
	}
	if (pl.excluded.length > 0) io.err(`omp-ext-safe: starting without: ${pl.excluded.map(unit => unit.key).join(", ")}.`);

	const runId = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
	const runsDir = path.join(options.stateDir ?? defaultStateDir(), "runs");
	const runDir = path.join(runsDir, runId);
	const launchDir = path.join(runDir, "launch");
	fs.mkdirSync(launchDir, { recursive: true, mode: 0o700 });
	try {
		const overlayFile = path.join(runDir, "overlay.yml");
		const entry = path.join(runDir, "guard.ts");
		const auditLog = path.resolve(config.auditLog ?? defaultAuditLog());
		fs.writeFileSync(overlayFile, renderOverlay(pl), { mode: 0o600 });
		const guard: ExtensionGuardOptions = {
			configPath: null,
			approved: pl.approved,
			auditLog,
			runId,
			entry,
			...(config.allowlists ? { allowlists: config.allowlists } : {}),
			...(config.publicKeys ? { publicKeys: config.publicKeys } : {}),
			...(config.protect ? { protect: config.protect } : {}),
			...(config.allowWrite ? { allowWrite: config.allowWrite } : {}),
		};
		fs.writeFileSync(entry, renderEntry(guard), { mode: 0o600 });
		const child = Bun.spawn(buildCommand(pl, entry, overlayFile, config), { cwd: launchDir, env: pl.env, stdio: ["inherit", "inherit", "inherit"] });
		const ignore = () => {};
		process.on("SIGINT", ignore);
		let code: number;
		try {
			code = await child.exited;
		} finally {
			process.off("SIGINT", ignore);
		}
		report(io, auditLog, runId, child.pid, entry, code);
		return code;
	} finally {
		fs.rmSync(runDir, { recursive: true, force: true });
	}
}

function printPlan(pl: Plan, io: LaunchIO): void {
	io.err(`omp-ext-safe plan for ${pl.cwd} (mode: ${pl.mode})`);
	for (const unit of pl.units) {
		const fate = unit.status === "approved" ? "loads" : "kept out";
		io.err(`  ${fate.padEnd(8)} ${unit.key} (${unit.kind}, ${describeStatus(unit.status)})`);
	}
	io.err(`  overlay: ${renderOverlay(pl).split("\n").slice(1).filter(Boolean).join("; ")}`);
	for (const finding of pl.findings) io.err(`  ${finding.accepted ? "accepted" : "credential"}: ${finding.key}: ${finding.detail}`);
	for (const problem of pl.problems) io.err(`  allowlist left out: ${problem}`);
	for (const refusal of pl.refusals) io.err(`  refuses: ${refusal}`);
	io.err(pl.refusals.length === 0 ? "  would start omp" : "  would not start omp");
}

const USAGE = `usage: omp-ext-safe [options] [-- omp arguments...]
  --config <file>            config file (default ~/.config/omp-extension-guard/config.json)
  --allowlist <file>         signed allowlist; its signature is <file>.sig (repeatable)
  --public-key <file>        trusted public key (repeatable)
  --mode <mode>              trusted (default) | explicit | discovery
  --isolation <mode>         warn (default) | require | off
  --accept <key>             accept a credential exposure, e.g. env:CURSOR_API_KEY (repeatable)
  --pass-env <NAME>          pass an environment variable to omp (repeatable)
  --on-unapproved <policy>   ask (default) | refuse | exclude
  --audit-log <file>         where the guard appends its decisions
  --omp <command>            how to run omp (default "omp")
  --cwd <dir>                the project to start omp in (default: the current directory)
  --state-dir <dir>          where each run's files are written
  --plan                     print what would happen and exit (0: would start, 3: would not)`;

interface ParsedArgs {
	configPath?: string;
	overrides: GuardConfig;
	cwd?: string;
	stateDir?: string;
	ompArgs: string[];
	planOnly: boolean;
	help: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
	const parsed: ParsedArgs = { overrides: {}, ompArgs: [], planOnly: false, help: false };
	const here = process.cwd();
	const append = (field: "allowlists" | "publicKeys" | "accept" | "passEnv", value: string) => {
		parsed.overrides[field] = [...(parsed.overrides[field] ?? []), value];
	};
	for (let i = 0; i < argv.length; i++) {
		let arg = argv[i]!;
		let inline: string | undefined;
		const equals = arg.indexOf("=");
		if (arg.startsWith("--") && equals > 0) {
			inline = arg.slice(equals + 1);
			arg = arg.slice(0, equals);
		}
		const value = () => {
			const next = inline ?? argv[++i];
			if (next === undefined) throw new Error(`${arg} needs a value`);
			return next;
		};
		switch (arg) {
			case "--":
				parsed.ompArgs = argv.slice(i + 1);
				return parsed;
			case "-h":
			case "--help":
				parsed.help = true;
				break;
			case "--plan":
				parsed.planOnly = true;
				break;
			case "--config":
				parsed.configPath = resolveConfigPath(value(), here);
				break;
			case "--allowlist":
				append("allowlists", resolveConfigPath(value(), here));
				break;
			case "--public-key":
				append("publicKeys", resolveConfigPath(value(), here));
				break;
			case "--accept":
				append("accept", value());
				break;
			case "--pass-env":
				append("passEnv", value());
				break;
			case "--mode": {
				const mode = value();
				if (!LOAD_MODES.includes(mode as LoadMode)) throw new Error(`--mode must be one of ${LOAD_MODES.join(", ")}`);
				parsed.overrides.mode = mode as LoadMode;
				break;
			}
			case "--isolation": {
				const mode = value();
				if (!ISOLATION_MODES.includes(mode as IsolationMode)) throw new Error(`--isolation must be one of ${ISOLATION_MODES.join(", ")}`);
				parsed.overrides.isolation = mode as IsolationMode;
				break;
			}
			case "--on-unapproved": {
				const policy = value();
				if (!UNAPPROVED_POLICIES.includes(policy as UnapprovedPolicy)) throw new Error(`--on-unapproved must be one of ${UNAPPROVED_POLICIES.join(", ")}`);
				parsed.overrides.onUnapproved = policy as UnapprovedPolicy;
				break;
			}
			case "--audit-log":
				parsed.overrides.auditLog = resolveConfigPath(value(), here);
				break;
			case "--omp":
				parsed.overrides.omp = value().split(/\s+/).filter(Boolean);
				break;
			case "--cwd":
				parsed.cwd = resolveConfigPath(value(), here);
				break;
			case "--state-dir":
				parsed.stateDir = resolveConfigPath(value(), here);
				break;
			default:
				throw new Error(`unknown option ${arg}`);
		}
	}
	return parsed;
}

/** The `omp-ext-safe` command. */
export async function runOmpExtSafe(argv: readonly string[], io: LaunchIO): Promise<number> {
	let parsed: ParsedArgs;
	let config: GuardConfig;
	try {
		parsed = parseArgs(argv);
		if (parsed.help) {
			io.err(USAGE);
			return 0;
		}
		const file = loadConfig(parsed.configPath ?? defaultConfigPath());
		config = { ...file, ...parsed.overrides };
		for (const field of ["allowlists", "publicKeys", "accept", "passEnv"] as const) {
			if (parsed.overrides[field]) config[field] = [...(file[field] ?? []), ...parsed.overrides[field]!];
		}
	} catch (err) {
		io.err(`omp-ext-safe: ${err instanceof Error ? err.message : String(err)}`);
		io.err(USAGE);
		return EXIT_USAGE;
	}
	const cwd = parsed.cwd ?? process.cwd();
	try {
		if (parsed.planOnly) {
			const pl = await plan({ cwd, config, ompArgs: parsed.ompArgs });
			printPlan(pl, io);
			return pl.refusals.length === 0 ? 0 : EXIT_REFUSED;
		}
		return await launch({ cwd, config, ompArgs: parsed.ompArgs, stateDir: parsed.stateDir, io });
	} catch (err) {
		io.err(`omp-ext-safe: ${err instanceof Error ? err.message : String(err)}`);
		return EXIT_USAGE;
	}
}

/** stderr for output; a question at the terminal when both stdin and stderr are terminals. */
export function terminalIO(): LaunchIO {
	const io: LaunchIO = { err: line => process.stderr.write(`${line}\n`) };
	if (process.stdin.isTTY && process.stderr.isTTY) {
		io.ask = async question => {
			const prompt = readline.createInterface({ input: process.stdin, output: process.stderr });
			try {
				return await prompt.question(question);
			} finally {
				prompt.close();
			}
		};
	}
	return io;
}
