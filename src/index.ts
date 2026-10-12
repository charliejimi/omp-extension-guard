// The guard that runs inside omp. It cannot see code that ran while omp loaded extensions (that code
// shares omp's process), but it can see what that code left: tools whose source is not an approved,
// unchanged unit lock the session. On every tool call it keeps the agent from writing code where
// omp or Bun would load it at the next start, and from running an extension's scripts unless the
// approval lists them. Imports nothing from omp at runtime.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory, ToolInfo } from "@oh-my-pi/pi-coding-agent";
import { type UnitKind, digestUnit, loadTrustedAllowlists } from "./allowlist";
import { type GuardConfig, defaultAuditLog, defaultConfigPath, loadConfig } from "./config";
import { type ScopeContext, displayPath, keyPath, scopeKey } from "./keys";
import { type BashContext, type Protection, type Verdict, astEditTouchesProtected, bashVerdict, evalVerdict, isProtectedPath, protection, realPathOf, writeTargets } from "./policy";

/** A unit the launcher (or a verified allowlist) approved, pinned to its digest. */
export interface ApprovedUnit {
	kind: UnitKind;
	key: string;
	path: string;
	digest: string;
	scripts: Record<string, string>;
}

export interface ExtensionGuardOptions {
	/** The user config to read; `null` reads none. Defaults to ~/.config/omp-extension-guard/config.json. */
	configPath?: string | null;
	allowlists?: string[];
	publicKeys?: string[];
	/** Units approved for this run; when set, allowlists are not read. */
	approved?: ApprovedUnit[];
	auditLog?: string;
	runId?: string;
	/** This guard's entry file, written by the launcher. */
	entry?: string;
	protect?: string[];
	allowWrite?: string[];
}

const PACKAGE_DIR = path.resolve(import.meta.dir, "..");
const SAFE_SOURCES = new Set(["builtin", "sdk", "mcp"]);

const RULE_TEXT: Record<string, string> = {
	lockdown: "code that was not approved loaded into this session, so every tool call is blocked",
	"unapproved-tool": "this tool comes from code that was not approved",
	"protected-write": "it writes where omp or Bun loads code or settings at startup",
	"protected-eval": "the code names a place where omp or Bun loads code or settings at startup",
	"plugin-install": "it installs an omp plugin",
	"unlisted-script": "the approval does not list this script",
	"modified-script": "the script or its extension changed since approval",
	unverifiable: "it builds its arguments at run time near places where omp loads code, so it cannot be checked",
};

function guardPaths(options: ExtensionGuardOptions, config: GuardConfig, configPath: string | null): string[] {
	const paths = [PACKAGE_DIR, path.dirname(options.auditLog ?? config.auditLog ?? defaultAuditLog())];
	if (options.entry) paths.push(path.dirname(options.entry));
	if (configPath) paths.push(path.dirname(configPath));
	for (const file of [...(options.allowlists ?? config.allowlists ?? [])]) paths.push(file, `${file}.sig`);
	for (const key of options.publicKeys ?? config.publicKeys ?? []) if (!key.trimStart().startsWith("-----BEGIN")) paths.push(key);
	return paths;
}

function isInside(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The guard as an extension factory. With no options it reads the user's config file. */
export function createExtensionGuard(options: ExtensionGuardOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		const configPath = options.configPath === undefined ? defaultConfigPath() : options.configPath;
		let config: GuardConfig = {};
		let configProblem: string | undefined;
		try {
			config = configPath ? loadConfig(configPath) : {};
		} catch (err) {
			configProblem = err instanceof Error ? err.message : String(err);
		}
		const auditLog = path.resolve(options.auditLog ?? config.auditLog ?? defaultAuditLog());
		const runId = options.runId ?? "direct";
		const paths = guardPaths(options, config, configPath);
		let auditFailed = false;

		const audit = (record: Record<string, unknown>) => {
			try {
				fs.mkdirSync(path.dirname(auditLog), { recursive: true });
				fs.appendFileSync(auditLog, `${JSON.stringify({ time: new Date().toISOString(), run: runId, ...record })}\n`);
			} catch (err) {
				if (!auditFailed) pi.logger.warn("omp-extension-guard: could not write the audit log", { error: String(err) });
				auditFailed = true;
			}
		};

		let scope: ScopeContext = { cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".omp", "agent"), home: os.homedir() };
		let approved: ApprovedUnit[] | undefined = options.approved;
		let approvalProblem: string | undefined;
		let guardProtection: Protection | undefined;
		let lockdown = false;
		const unitStatus = new Map<string, boolean>();

		const loadApprovals = () => {
			if (options.approved) return;
			const result = loadTrustedAllowlists({ allowlists: options.allowlists ?? config.allowlists, publicKeys: options.publicKeys ?? config.publicKeys });
			if (!result.approvals) {
				approvalProblem = result.problems.join("; ") || "no allowlist verified";
				return;
			}
			approved = [];
			for (const [key, entries] of result.approvals.entries) {
				if (result.approvals.revoked.has(key)) continue;
				const unitPath = keyPath(key, scope);
				if (!unitPath) continue;
				for (const entry of entries) approved.push({ kind: entry.kind, key, path: unitPath, digest: entry.digest, scripts: entry.scripts });
			}
		};

		const currentProtection = (): Protection => {
			guardProtection ??= protection({
				cwd: scope.cwd,
				home: scope.home,
				agentDir: scope.agentDir,
				guardPaths: paths,
				extra: options.protect ?? config.protect ?? [],
				allowWrite: options.allowWrite ?? config.allowWrite ?? [],
			});
			return guardProtection;
		};

		/** Whether a unit is approved and still hashes to its approved digest; computed once per session. */
		const unchanged = (unit: ApprovedUnit): boolean => {
			let ok = unitStatus.get(unit.path + unit.digest);
			if (ok === undefined) {
				try {
					ok = digestUnit(unit.path) === unit.digest;
				} catch {
					ok = false;
				}
				unitStatus.set(unit.path + unit.digest, ok);
			}
			return ok;
		};

		const isExpected = (tool: ToolInfo): boolean => {
			const source = tool.sourceInfo;
			if (!source || SAFE_SOURCES.has(source.source) || !path.isAbsolute(source.path)) return true;
			const real = realPathOf(source.path);
			if (isInside(real, realPathOf(PACKAGE_DIR)) || (options.entry && real === realPathOf(options.entry))) return true;
			return (approved ?? []).some(unit => isInside(real, realPathOf(unit.path)) && unchanged(unit));
		};

		const bashContext = (): BashContext => ({
			protection: currentProtection(),
			units: (approved ?? []).filter(unit => unit.kind !== "tool"),
			digest: abs => {
				try {
					return digestUnit(abs);
				} catch {
					return undefined;
				}
			},
		});

		const decide = (toolName: string, input: unknown, cwd: string): Verdict & { location?: string } => {
			if (lockdown) return { ok: false, rule: "lockdown" };
			const info = pi.getAllTools().find(tool => tool.name === toolName);
			if (info && !isExpected(info)) return { ok: false, rule: "unapproved-tool" };
			const p = currentProtection();
			const targets = writeTargets(toolName, input);
			for (const target of targets ?? []) {
				const touches = toolName === "ast_edit" ? astEditTouchesProtected(target, cwd, p) : isProtectedPath(target, cwd, p);
				if (touches) return { ok: false, rule: "protected-write", location: scopeKey(path.resolve(cwd, target), scope) };
			}
			const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
			if (toolName === "bash" && typeof args.command === "string") {
				const base = typeof args.cwd === "string" ? path.resolve(cwd, args.cwd) : cwd;
				return bashVerdict(args.command, base, bashContext());
			}
			if (toolName === "eval" && typeof args.code === "string") return evalVerdict(args.code, p);
			return { ok: true };
		};

		pi.on("session_start", async (_event, ctx: ExtensionContext) => {
			scope = { ...scope, cwd: ctx.cwd };
			guardProtection = undefined;
			unitStatus.clear();
			if (configProblem) ctx.ui.notify(`omp-extension-guard: the config could not be read (${configProblem}).`, "warning");
			loadApprovals();
			if (!approved) {
				ctx.ui.notify(
					`omp-extension-guard: no approved extensions are configured (${approvalProblem}). Built-in tools work; tools from other code are blocked.`,
					"warning",
				);
				audit({ event: "session_start", action: "warn", rule: "no-allowlist" });
				return;
			}
			const unexpected = pi.getAllTools().filter(tool => !isExpected(tool));
			if (unexpected.length === 0) {
				audit({ event: "session_start", action: "allow", units: approved.length });
				return;
			}
			lockdown = true;
			const names = unexpected.map(tool => tool.name);
			const where = unexpected.map(tool => `${tool.name} (${displayPath(tool.sourceInfo.path, scope)})`).join(", ");
			ctx.ui.notify(
				`omp-extension-guard: code that was not approved, or changed since approval, registered tools: ${where}. It already ran in this process; every tool call is blocked. Restart through omp-ext-safe.`,
				"error",
			);
			audit({ event: "session_start", action: "lockdown", rule: "lockdown", tools: names });
		});

		pi.on("tool_call", async (event, ctx: ExtensionContext) => {
			const verdict = decide(event.toolName, event.input, ctx.cwd);
			if (verdict.ok) {
				audit({ event: "tool_call", tool: event.toolName, action: "allow" });
				return undefined;
			}
			const location = "location" in verdict ? verdict.location : undefined;
			audit({ event: "tool_call", tool: event.toolName, action: "block", rule: verdict.rule, ...(location ? { location } : {}) });
			return { block: true, reason: `omp-extension-guard blocked ${event.toolName}: ${RULE_TEXT[verdict.rule] ?? verdict.rule}.` };
		});
	};
}

export default createExtensionGuard();
