// User-level settings shared by omp-ext-safe, the CLI, and the guard. They come from a file under
// the home directory, never from environment variables: Bun loads a project's .env into a process
// started in that project, so a repository could otherwise point the guard at its own key.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type LoadMode = "trusted" | "explicit" | "discovery";
export type IsolationMode = "off" | "warn" | "require";
export type UnapprovedPolicy = "ask" | "refuse" | "exclude";

export const LOAD_MODES: readonly LoadMode[] = ["trusted", "explicit", "discovery"];
export const ISOLATION_MODES: readonly IsolationMode[] = ["off", "warn", "require"];
export const UNAPPROVED_POLICIES: readonly UnapprovedPolicy[] = ["ask", "refuse", "exclude"];

export interface GuardConfig {
	/** Signed allowlists; each has its signature in `<file>.sig`. */
	allowlists?: string[];
	/** Trusted public keys: PEM text or paths to PEM files. */
	publicKeys?: string[];
	/** How omp-ext-safe keeps unapproved extensions out; `trusted` by default. */
	mode?: LoadMode;
	/** What omp-ext-safe does about credentials the omp process could reach; `warn` by default. */
	isolation?: IsolationMode;
	/** Exposure keys (`env:NAME`, `file:~/.netrc`, `store:<provider>`, `argv:<n>`) accepted on purpose. */
	accept?: string[];
	/** Environment variables passed to omp on top of the built-in allowlist. */
	passEnv?: string[];
	/** The value a credential proxy puts in place of a real key; `proxy-managed` by default. */
	placeholder?: string;
	/** More credential files to look for, besides the well-known ones. */
	credentialFiles?: string[];
	/** What omp-ext-safe does when unapproved units exist that it can keep out. */
	onUnapproved?: UnapprovedPolicy;
	/** Where the guard appends its decisions as JSON lines. */
	auditLog?: string;
	/** More paths the agent may not write, relative to the project or absolute. */
	protect?: string[];
	/** Paths the agent may write even though they are protected. */
	allowWrite?: string[];
	/** How to run omp; `["omp"]` by default. */
	omp?: string[];
}

export function defaultConfigPath(): string {
	return path.join(os.homedir(), ".config", "omp-extension-guard", "config.json");
}

export function defaultStateDir(): string {
	return path.join(os.homedir(), ".local", "state", "omp-extension-guard");
}

export function defaultAuditLog(): string {
	return path.join(defaultStateDir(), "audit.jsonl");
}

/** `~` and `~/…` expand to the home directory; other relative paths resolve against `base`. */
export function resolveConfigPath(value: string, base: string): string {
	const home = value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value;
	return path.resolve(base, home);
}

function stringList(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || !value.every(item => typeof item === "string" && item.length > 0)) {
		throw new Error(`${field} must be a list of strings`);
	}
	return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
	if (!allowed.includes(value as T)) throw new Error(`${field} must be one of ${allowed.join(", ")}`);
	return value as T;
}

/** Validates a parsed config object; file paths resolve against `base`. */
export function normalizeConfig(raw: unknown, base: string): GuardConfig {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("the config must be a JSON object");
	const input = raw as Record<string, unknown>;
	const config: GuardConfig = {};
	if (input.allowlists !== undefined) config.allowlists = stringList(input.allowlists, "allowlists").map(file => resolveConfigPath(file, base));
	if (input.publicKeys !== undefined) {
		config.publicKeys = stringList(input.publicKeys, "publicKeys").map(key =>
			key.trimStart().startsWith("-----BEGIN") ? key : resolveConfigPath(key, base),
		);
	}
	if (input.credentialFiles !== undefined) {
		config.credentialFiles = stringList(input.credentialFiles, "credentialFiles").map(file => resolveConfigPath(file, base));
	}
	if (input.auditLog !== undefined) {
		if (typeof input.auditLog !== "string" || input.auditLog.length === 0) throw new Error("auditLog must be a path");
		config.auditLog = resolveConfigPath(input.auditLog, base);
	}
	if (input.mode !== undefined) config.mode = oneOf(input.mode, LOAD_MODES, "mode");
	if (input.isolation !== undefined) config.isolation = oneOf(input.isolation, ISOLATION_MODES, "isolation");
	if (input.onUnapproved !== undefined) config.onUnapproved = oneOf(input.onUnapproved, UNAPPROVED_POLICIES, "onUnapproved");
	for (const field of ["accept", "passEnv", "protect", "allowWrite", "omp"] as const) {
		if (input[field] !== undefined) config[field] = stringList(input[field], field);
	}
	if (input.placeholder !== undefined) {
		if (typeof input.placeholder !== "string" || input.placeholder.length === 0) throw new Error("placeholder must be text");
		config.placeholder = input.placeholder;
	}
	return config;
}

/** Reads a config file. A missing file is an empty config; an invalid one throws. */
export function loadConfig(file: string): GuardConfig {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw err;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		throw new Error(`${file} is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
	}
	return normalizeConfig(raw, path.dirname(file));
}
