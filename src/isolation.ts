// What a process started for omp could read of real credentials: environment variables, omp's own
// arguments, well-known credential files, and omp's credential store. Code that omp loads runs in
// that process with all of it, so the launcher passes only an allowlisted environment and reports
// (or refuses over) anything left. Findings name a location, never a value.
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

/** Variables omp needs to run; everything else is dropped unless the user passes it on purpose. */
export const DEFAULT_PASS_ENV: readonly string[] = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TERM",
	"COLORTERM",
	"TERM_PROGRAM",
	"LANG",
	"LANGUAGE",
	"LC_ALL",
	"LC_CTYPE",
	"LC_MESSAGES",
	"TZ",
	"TMPDIR",
	"NO_COLOR",
	"FORCE_COLOR",
	"PI_CODING_AGENT_DIR",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
	"XDG_RUNTIME_DIR",
];

export const DEFAULT_PLACEHOLDER = "proxy-managed";

/** An empty environment plus the allowlisted names that are set. */
export function childEnv(source: Readonly<Record<string, string | undefined>>, pass: readonly string[]): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name of new Set([...DEFAULT_PASS_ENV, ...pass])) {
		const value = source[name];
		if (value !== undefined) env[name] = value;
	}
	return env;
}

const CREDENTIAL_NAME = /(^|_)(API_?KEY|ACCESS_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_?KEY|AUTH)($|_)/i;
const CREDENTIAL_VALUE = [
	/^sk-[A-Za-z0-9_-]{20,}$/,
	/^(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}$/,
	/^github_pat_[A-Za-z0-9_]{40,}$/,
	/^glpat-[A-Za-z0-9_-]{20,}$/,
	/^xox[abposr]-[A-Za-z0-9-]{10,}$/,
	/^(AKIA|ASIA)[A-Z0-9]{16}$/,
	/^AIza[A-Za-z0-9_-]{35}$/,
	/^npm_[A-Za-z0-9]{36}$/,
	/^-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function looksLikeCredentialName(name: string): boolean {
	return CREDENTIAL_NAME.test(name);
}

export function looksLikeCredentialValue(value: string): boolean {
	const trimmed = value.trim();
	return CREDENTIAL_VALUE.some(pattern => pattern.test(trimmed));
}

export type ExposureCheck = "env" | "argv" | "file" | "store";

export interface Finding {
	/** `env:NAME`, `argv:<index>`, `file:<path>`, or `store:<provider>`; accepted with `--accept <key>`. */
	key: string;
	check: ExposureCheck;
	detail: string;
	accepted: boolean;
}

export interface ExposureOptions {
	/** The environment omp will get. */
	env: Readonly<Record<string, string>>;
	/** omp's arguments. */
	argv: readonly string[];
	home: string;
	/** omp's credential store (`agent.db`) for the agent directory omp will use. */
	storePath?: string;
	placeholder?: string;
	accept?: readonly string[];
	/** More credential files to look for. */
	extraFiles?: readonly string[];
}

interface KnownFile {
	rel: string;
	/** Counts only when the file contains this; otherwise its presence is enough. */
	contains?: RegExp;
}

const KNOWN_FILES: readonly KnownFile[] = [
	{ rel: ".git-credentials" },
	{ rel: ".netrc" },
	{ rel: ".config/gh/hosts.yml", contains: /oauth_token/ },
	{ rel: ".aws/credentials" },
	{ rel: ".npmrc", contains: /_authToken|_auth\s*=|_password/ },
	{ rel: ".docker/config.json", contains: /"auth"\s*:/ },
	{ rel: ".config/gcloud/application_default_credentials.json" },
	{ rel: ".kube/config" },
	{ rel: ".pypirc", contains: /password/ },
	{ rel: ".ssh/id_rsa" },
	{ rel: ".ssh/id_ecdsa" },
	{ rel: ".ssh/id_ed25519" },
];

function readable(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

function displayFile(file: string, home: string): string {
	const rel = path.relative(home, file);
	return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? `~/${rel.split(path.sep).join("/")}` : file;
}

/** Providers with an active credential in omp's store; never reads the credentials themselves. */
export function storedCredentialProviders(storePath: string): { providers: string[] } | { error: string } {
	if (!fs.existsSync(storePath)) return { providers: [] };
	let db: Database | undefined;
	try {
		db = new Database(storePath, { readonly: true });
		const table = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'auth_credentials'").get();
		if (!table) return { providers: [] };
		const rows = db.query("SELECT DISTINCT provider FROM auth_credentials WHERE disabled_cause IS NULL ORDER BY provider").all() as Array<{ provider: string }>;
		return { providers: rows.map(row => row.provider) };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	} finally {
		db?.close();
	}
}

/** Every place a real credential would be within reach of the omp process. */
export function checkExposure(options: ExposureOptions): Finding[] {
	const placeholder = options.placeholder ?? DEFAULT_PLACEHOLDER;
	const accepted = new Set(options.accept ?? []);
	const findings: Finding[] = [];
	const add = (key: string, check: ExposureCheck, detail: string) => findings.push({ key, check, detail, accepted: accepted.has(key) });

	for (const [name, value] of Object.entries(options.env)) {
		if (value === "" || value === placeholder) continue;
		if (looksLikeCredentialName(name)) add(`env:${name}`, "env", `omp would get ${name}, which is named like a credential and is not the placeholder`);
		else if (looksLikeCredentialValue(value)) add(`env:${name}`, "env", `omp would get ${name}, whose value looks like a credential`);
	}

	options.argv.forEach((arg, index) => {
		const equals = arg.indexOf("=");
		const inlineFlag = arg.startsWith("--") && equals > 0 ? arg.slice(0, equals) : undefined;
		const value = inlineFlag ? arg.slice(equals + 1) : arg;
		if (!value || value === placeholder || (!inlineFlag && value.startsWith("-"))) return;
		const previous = index > 0 ? options.argv[index - 1] : undefined;
		const flag = inlineFlag ?? (previous?.startsWith("--") ? previous : undefined);
		const named = flag !== undefined && /key|token|secret|password/i.test(flag);
		if (named || looksLikeCredentialValue(value)) add(`argv:${index}`, "argv", `omp's argument ${index} carries a credential`);
	});

	const files: Array<{ file: string; contains?: RegExp }> = [
		...KNOWN_FILES.map(known => ({ file: path.join(options.home, known.rel), contains: known.contains })),
		...(options.extraFiles ?? []).map(file => ({ file })),
	];
	for (const { file, contains } of files) {
		const text = readable(file);
		if (text === undefined || (contains && !contains.test(text))) continue;
		const shown = displayFile(file, options.home);
		add(`file:${shown}`, "file", `${shown} holds credentials and is readable`);
	}

	if (options.storePath) {
		const stored = storedCredentialProviders(options.storePath);
		if ("error" in stored) add("store:unreadable", "store", "omp's credential store could not be inspected");
		else for (const provider of stored.providers) add(`store:${provider}`, "store", `omp's credential store holds a credential for ${provider}`);
	}
	return findings;
}
