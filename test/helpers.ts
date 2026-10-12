import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { discoverAndLoadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ALLOWLIST_SCHEMA, type Allowlist, type AllowlistEntry, generateKeyPair, signAllowlist } from "../src/allowlist";
import type { ExtensionGuardOptions } from "../src/index";
import type { Unit } from "../src/inventory";
import { safeRemove } from "./fixtures";

export const PACKAGE = path.resolve(import.meta.dir, "..");

/** The key pair the tests trust, and one they do not. */
export const KEYS = generateKeyPair();
export const OTHER_KEYS = generateKeyPair();

export function allowlistOf(items: AllowlistEntry[], extra: Partial<Allowlist> = {}): Allowlist {
	return { schema: ALLOWLIST_SCHEMA, issuedAt: new Date().toISOString(), items, revoked: [], ...extra };
}

/** Writes an allowlist and its detached signature into `dir`; returns the allowlist's path. */
export function writeAllowlist(
	dir: string,
	list: Allowlist | string,
	privateKeyPem: string = KEYS.privateKeyPem,
	name = "extensions.allow.json",
): string {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, name);
	const text = typeof list === "string" ? list : `${JSON.stringify(list, null, 2)}\n`;
	fs.writeFileSync(file, text);
	fs.writeFileSync(`${file}.sig`, `${signAllowlist(text, privateKeyPem)}\n`);
	return file;
}

export function writePublicKey(dir: string, pem: string = KEYS.publicKeyPem, name = "trusted.pub.pem"): string {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, name);
	fs.writeFileSync(file, pem);
	return file;
}

/** An allowlist entry approving an inventory unit as it is now. */
export function approve(unit: Unit, extra: Partial<AllowlistEntry> = {}): AllowlistEntry {
	if (!unit.digest) throw new Error(`${unit.key} has no digest: ${unit.error}`);
	return {
		kind: unit.kind,
		key: unit.key,
		digest: unit.digest,
		scripts: unit.scripts,
		source: "https://example.test/extensions",
		version: "1.0.0",
		reviewer: "platform-team",
		...extra,
	};
}

export function unitByKey(units: readonly Unit[], key: string): Unit {
	const unit = units.find(item => item.key === key);
	if (!unit) throw new Error(`no unit ${key}; have ${units.map(item => item.key).join(", ")}`);
	return unit;
}

let entries = 0;

/** An extension entry that loads the guard with explicit options, the way omp-ext-safe does. */
export function writeGuardEntry(dir: string, options: ExtensionGuardOptions): string {
	fs.mkdirSync(dir, { recursive: true });
	const entry = path.join(dir, `guard-${++entries}.ts`);
	const config = { configPath: null, ...options, entry };
	const source = [
		`import { createExtensionGuard } from ${JSON.stringify(path.join(PACKAGE, "src", "index.ts"))};`,
		`export default createExtensionGuard(${JSON.stringify(config, null, "\t")});`,
		"",
	].join("\n");
	fs.writeFileSync(entry, source);
	return entry;
}

let registry: { auth: AuthStorage; models: ModelRegistry; dir: string } | undefined;

async function models(): Promise<ModelRegistry> {
	if (!registry) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eg-auth-"));
		const auth = await AuthStorage.create(path.join(dir, "auth.db"));
		registry = { auth, models: new ModelRegistry(auth), dir };
	}
	return registry.models;
}

export function closeRegistry(): void {
	if (!registry) return;
	registry.auth.close();
	safeRemove(registry.dir);
	registry = undefined;
}

export interface Notice {
	message: string;
	type: string | undefined;
}

type Emitted = Promise<{ block?: boolean; reason?: string } | undefined>;

export interface Guard {
	runner: ExtensionRunner;
	notices: Notice[];
	handlerErrors: string[];
	toolCall(toolName: string, input: unknown): Emitted;
}

const BUILTIN_TOOLS = ["read", "write", "edit", "ast_edit", "bash", "eval", "grep", "find"];

/**
 * Loads extension entries, in order, through omp's own loader and runner, reports omp's built-in
 * tools plus every tool the entries registered through `getAllTools()`, and starts the session.
 */
export async function loadGuard(paths: string[], cwd: string, options: { startSession?: boolean } = {}): Promise<Guard> {
	const result = await discoverAndLoadExtensions(paths, cwd, undefined, undefined, { ambient: false });
	const extensions = result.extensions.filter(ext => paths.includes(ext.path));
	const loadErrors = result.errors.filter(err => paths.includes(err.path));
	if (loadErrors.length > 0 || extensions.length !== paths.length) {
		throw new Error(`extensions did not load: ${JSON.stringify(loadErrors)} (${extensions.length} loaded)`);
	}
	const runner = new ExtensionRunner(extensions, result.runtime, cwd, SessionManager.inMemory(cwd), await models());
	const notices: Notice[] = [];
	const ui = { notify: (message: string, type?: string) => notices.push({ message, type }) };
	const builtins = BUILTIN_TOOLS.map(name => ({
		name,
		description: name,
		parameters: {},
		sourceInfo: { path: `<builtin:${name}>`, source: "builtin", scope: "temporary", origin: "top-level" },
	}));
	const getAllTools = () => [
		...builtins,
		...runner.getAllRegisteredTools().map(tool => ({
			name: tool.definition.name,
			description: tool.definition.description,
			parameters: tool.definition.parameters,
			sourceInfo: tool.sourceInfo,
		})),
	];
	runner.initialize({ getActiveTools: () => getAllTools().map(tool => tool.name), getAllTools } as never, {} as never, undefined, ui as never, "rpc");
	const handlerErrors: string[] = [];
	runner.onError(e => handlerErrors.push(`${e.event}: ${e.error}`));
	if (options.startSession !== false) await runner.emit({ type: "session_start" } as never);
	return {
		runner,
		notices,
		handlerErrors,
		toolCall: (toolName, input) => runner.emitToolCall({ type: "tool_call", toolCallId: "call-1", toolName, input } as never) as Emitted,
	};
}

export function readAudit(file: string): Array<Record<string, unknown>> {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(line => line.trim())
		.map(line => JSON.parse(line) as Record<string, unknown>);
}
