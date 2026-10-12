// What omp would load at startup, found with omp's own discovery code and never executed. Each
// loaded path is attributed to a unit (the file or directory a reviewer approves) and to the
// switches that can keep it out. Imports omp, so it runs outside omp: in the CLI and the launcher.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ExtensionModule, extensionModuleCapability } from "@oh-my-pi/pi-coding-agent/capability/extension-module";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type Hook, hookCapability } from "@oh-my-pi/pi-coding-agent/capability/hook";
import { type CustomTool, toolCapability } from "@oh-my-pi/pi-coding-agent/capability/tool";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeWithSettings, loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { clearClaudePluginRootsCache, getExtensionNameFromPath } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { injectOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { discoverCustomCommands } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/loader";
import { type ToolPathWithSource, discoverCustomToolPaths } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/loader";
import { getEnabledPlugins } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import { resolvePath } from "@oh-my-pi/pi-coding-agent/extensibility/utils";
import { discoverSessionExtensionPaths } from "@oh-my-pi/pi-coding-agent/sdk";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { type UnitKind, digestUnit, unitScripts } from "./allowlist";
import { type Level, type ScopeContext, displayPath, levelOf, scopeKey } from "./keys";

export * from "./keys";

/** How a loaded path enters omp's process. Hook factories load as extensions. */
export type EntryRole = "extension" | "tool" | "command" | "preload";

/**
 * What keeps a path out: `--trusted-extension`, `--no-extensions`, a `disabledExtensions` id, an
 * overlay that replaces the `extensions:` setting, starting omp from another directory, or leaving
 * an `-e` argument off.
 */
export type Switch = "trusted-extension" | "no-extensions" | "disabled-id" | "overlay-extensions" | "launch-dir" | "omit";

export interface Entry {
	path: string;
	role: EntryRole;
	switches: Switch[];
	disableId?: string;
	/** The discovery provider that found it (`native`, `claude`, `codex`, `plugin`, …). */
	provider?: string;
	/** The tool name omp derives from the file, for tools. */
	name?: string;
}

export interface Unit {
	kind: UnitKind;
	key: string;
	/** The file or directory a reviewer approves. */
	path: string;
	level: Level;
	/** The settings file that named it, when that is not obvious from the key. */
	via?: string;
	entries: Entry[];
	digest?: string;
	scripts: Record<string, string>;
	/** Why the unit could not be hashed. */
	error?: string;
}

export interface InventoryOptions {
	/** `explicit-only` is what `--no-extensions` and `--trusted-extension` do; `merge` is omp's default. */
	mode?: "merge" | "explicit-only";
	/** Extension paths named on omp's command line (`-e`, `--hook`, `--trusted-extension`). */
	explicit?: string[];
	/** Settings overlays (`--config`), applied after the user's and the project's settings. */
	configFiles?: string[];
}

export interface Inventory extends ScopeContext {
	units: Unit[];
	/** `.env` files Bun would load into a process started in the project. */
	dotenv: string[];
	/** The effective `disabledExtensions` setting; an overlay must keep these ids. */
	disabledExtensions: string[];
}

/** Exactly the paths omp would import at startup, as omp computes them. */
export interface LoadSet {
	extensions: string[];
	tools: string[];
	commands: string[];
}

const EXTENSION_SWITCHES: Switch[] = ["trusted-extension", "no-extensions", "disabled-id"];
const DOTENV_FILES = [".env", ".env.local", ".env.development", ".env.production", ".env.test", ".env.development.local", ".env.production.local", ".env.test.local"];

interface Prepared {
	settings: Settings;
	explicitOnly: boolean;
	explicit: string[];
	ctx: ScopeContext;
}

/**
 * Settings, discovery providers, and extension roots exactly as omp sets them up for this mode.
 * omp caches file reads and plugin roots for the life of its process; clearing them first makes
 * every call see the files as they are now.
 */
async function prepare(cwd: string, options: InventoryOptions): Promise<Prepared> {
	clearFsCache();
	clearClaudePluginRootsCache();
	const settings = await Settings.loadReadOnly({ cwd, configFiles: options.configFiles ?? [] });
	initializeWithSettings(settings);
	const explicitOnly = options.mode === "explicit-only";
	const explicit = (options.explicit ?? []).map(file => resolvePath(file, cwd));
	const home = os.homedir();
	injectOmpExtensionCliRoots(explicit, home, cwd, { replace: true, mode: explicitOnly ? "explicit-only" : "merge" });
	return { settings, explicitOnly, explicit, ctx: { cwd, agentDir: getAgentDir(), home } };
}

async function discover(prepared: Prepared): Promise<{ extensions: string[]; tools: ToolPathWithSource[]; commands: string[] }> {
	const { cwd } = prepared.ctx;
	const extensions = await discoverSessionExtensionPaths(
		{ disableExtensionDiscovery: prepared.explicitOnly, additionalExtensionPaths: prepared.explicit },
		cwd,
		prepared.settings,
	);
	const tools = await discoverCustomToolPaths([], cwd);
	const commands = prepared.explicitOnly ? [] : (await discoverCustomCommands({ cwd, agentDir: prepared.ctx.agentDir })).paths.map(item => item.path);
	return { extensions, tools, commands };
}

/** The paths omp would import in `cwd` with these options. */
export async function loadSet(cwd: string, options: InventoryOptions = {}): Promise<LoadSet> {
	const found = await discover(await prepare(path.resolve(cwd), options));
	return { extensions: found.extensions, tools: found.tools.map(tool => tool.path), commands: found.commands };
}

function isInside(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function firstSegmentUnder(file: string, root: string): string | undefined {
	const rel = path.relative(root, file);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
	return path.join(root, rel.split(path.sep)[0]!);
}

/** The innermost of `dirs` strictly containing `file`, or equal to it. */
function owner(file: string, dirs: readonly string[]): string | undefined {
	return dirs.filter(dir => isInside(file, dir)).sort((a, b) => b.length - a.length)[0];
}

/** A module named `index.*` stands for its directory. */
function fileOrIndexDir(file: string): string {
	return /^index\.(ts|js|mjs|cjs)$/.test(path.basename(file)) ? path.dirname(file) : file;
}

function expandTilde(value: string, home: string): string {
	return value === "~" || value.startsWith("~/") ? path.join(home, value.slice(1)) : value;
}

/** `extensions` arrays in the native `settings.json` files, resolved the way omp's native provider does. */
function settingsJsonExtensions(ctx: ScopeContext): Array<{ target: string; file: string }> {
	const found: Array<{ target: string; file: string }> = [];
	for (const dir of [path.join(ctx.cwd, ".omp"), ctx.agentDir]) {
		const file = path.join(dir, "settings.json");
		let data: unknown;
		try {
			data = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch {
			continue;
		}
		const list = (data as { extensions?: unknown } | null)?.extensions;
		if (!Array.isArray(list)) continue;
		for (const entry of list) {
			if (typeof entry !== "string") continue;
			const expanded = expandTilde(entry, ctx.home);
			found.push({ target: path.isAbsolute(expanded) ? expanded : path.resolve(ctx.cwd, expanded), file });
		}
	}
	return found;
}

/** Scripts the project's `bunfig.toml` preloads into any Bun process started in the project. */
function bunfigPreloads(cwd: string): string[] {
	let parsed: unknown;
	try {
		parsed = Bun.TOML.parse(fs.readFileSync(path.join(cwd, "bunfig.toml"), "utf8"));
	} catch {
		return [];
	}
	const preload = (parsed as { preload?: unknown } | null)?.preload;
	const specs = typeof preload === "string" ? [preload] : Array.isArray(preload) ? preload.filter((item): item is string => typeof item === "string") : [];
	return specs.map(spec => {
		if (spec.startsWith(".") || path.isAbsolute(spec)) return path.resolve(cwd, spec);
		try {
			return Bun.resolveSync(spec, cwd);
		} catch {
			return path.join(cwd, "node_modules", spec);
		}
	});
}

function describeError(err: unknown): string {
	if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return "not found";
	return err instanceof Error ? err.message : String(err);
}

/** Every unit of code omp would load in `cwd`, with its entries, switches, and digest. */
export async function inventory(cwd: string, options: InventoryOptions = {}): Promise<Inventory> {
	const prepared = await prepare(path.resolve(cwd), options);
	const { ctx } = prepared;
	const found = await discover(prepared);

	const modules = new Map<string, ExtensionModule>();
	for (const item of (await loadCapability<ExtensionModule>(extensionModuleCapability.id, { cwd: ctx.cwd, providers: ["native"], includeDisabled: true })).items) {
		modules.set(path.resolve(item.path), item);
	}
	const hooks = new Map<string, Hook>();
	for (const item of (await loadCapability<Hook>(hookCapability.id, { cwd: ctx.cwd, includeDisabled: true })).items) hooks.set(path.resolve(item.path), item);
	const tools = new Map<string, CustomTool>();
	for (const item of (await loadCapability<CustomTool>(toolCapability.id, { cwd: ctx.cwd, includeDisabled: true })).items) tools.set(path.resolve(item.path), item);
	const plugins = (await getEnabledPlugins(ctx.cwd)).map(plugin => path.resolve(plugin.path));
	const fromSettingsJson = settingsJsonExtensions(ctx);
	const configured = prepared.explicitOnly ? [] : ((prepared.settings.get("extensions") as string[] | undefined) ?? []).map(entry => resolvePath(entry, ctx.cwd));
	const extensionRoots = [path.join(ctx.cwd, ".omp", "extensions"), path.join(ctx.agentDir, "extensions")];

	const units = new Map<string, Unit>();
	const add = (unitPath: string, kind: UnitKind, entry: Entry, via?: string) => {
		const resolved = path.resolve(unitPath);
		let unit = units.get(resolved);
		if (!unit) {
			const key = scopeKey(resolved, ctx);
			unit = { kind, key, path: resolved, level: levelOf(key), ...(via ? { via } : {}), entries: [], scripts: {} };
			units.set(resolved, unit);
		}
		if (!unit.entries.some(existing => existing.path === entry.path && existing.role === entry.role)) unit.entries.push(entry);
	};

	for (const raw of found.extensions) {
		const file = path.resolve(raw);
		const module = modules.get(file);
		if (module) {
			const entry: Entry = { path: file, role: "extension", switches: EXTENSION_SWITCHES, disableId: `extension-module:${module.name}`, provider: "native" };
			const underRoot = extensionRoots.map(root => firstSegmentUnder(file, root)).find(Boolean);
			if (underRoot) {
				add(underRoot, "extension", entry);
			} else {
				const named = fromSettingsJson.find(item => isInside(file, item.target));
				add(named?.target ?? file, "extension", entry, named ? displayPath(named.file, ctx) : undefined);
			}
			continue;
		}
		const hook = hooks.get(file);
		if (hook) {
			add(file, "hook", {
				path: file,
				role: "extension",
				switches: EXTENSION_SWITCHES,
				disableId: `hook:${hook.type}:${hook.tool}:${hook.name}`,
				provider: hook._source.provider,
			});
			continue;
		}
		const plugin = owner(file, plugins);
		if (plugin) {
			add(plugin, "plugin", {
				path: file,
				role: "extension",
				switches: EXTENSION_SWITCHES,
				disableId: `extension-module:${getExtensionNameFromPath(file)}`,
				provider: "plugin",
			});
			continue;
		}
		const explicit = owner(file, prepared.explicit);
		if (explicit) {
			add(explicit, "explicit", { path: file, role: "extension", switches: ["omit"] });
			continue;
		}
		const fromSetting = owner(file, configured);
		if (fromSetting) {
			add(fromSetting, "configured", { path: file, role: "extension", switches: ["trusted-extension", "no-extensions", "overlay-extensions"] });
			continue;
		}
		add(file, "extension", { path: file, role: "extension", switches: ["trusted-extension", "no-extensions"] }, "an unrecognized source");
	}

	for (const tool of found.tools) {
		const file = path.resolve(tool.path);
		const provider = tool.source?.provider;
		if (provider === "plugin") {
			add(owner(file, plugins) ?? file, "plugin", { path: file, role: "tool", switches: [], provider });
			continue;
		}
		const item = tools.get(file);
		const entry: Entry = {
			path: file,
			role: "tool",
			switches: item ? ["disabled-id"] : [],
			...(item ? { disableId: `tool:${item.name}`, name: item.name } : {}),
			...(provider ? { provider } : {}),
		};
		const pkg = owner(file, [...prepared.explicit, ...configured].filter(dir => dir !== file));
		if (pkg) add(pkg, prepared.explicit.includes(pkg) ? "explicit" : "configured", entry);
		else add(fileOrIndexDir(file), "tool", entry);
	}

	for (const raw of found.commands) {
		const file = path.resolve(raw);
		add(fileOrIndexDir(file), "command", { path: file, role: "command", switches: ["trusted-extension", "no-extensions"] });
	}

	for (const file of bunfigPreloads(ctx.cwd)) add(file, "preload", { path: file, role: "preload", switches: ["launch-dir"] });

	for (const unit of units.values()) {
		try {
			unit.digest = digestUnit(unit.path);
			unit.scripts = unitScripts(unit.path);
		} catch (err) {
			unit.error = describeError(err);
			unit.scripts = {};
		}
	}

	const dotenv = DOTENV_FILES.map(name => path.join(ctx.cwd, name)).filter(file => fs.existsSync(file));
	const disabledExtensions = (prepared.settings.get("disabledExtensions") as string[] | undefined) ?? [];
	return { ...ctx, units: [...units.values()], dotenv, disabledExtensions: [...disabledExtensions] };
}
