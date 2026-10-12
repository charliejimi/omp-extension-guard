// Pure decisions for the guard: which paths count as places omp loads code from, which paths a tool
// call would write, and a static reading of bash commands and eval code. Nothing here imports omp.
import * as fs from "node:fs";
import * as path from "node:path";

export interface ProtectContext {
	/** The project omp runs in. */
	cwd: string;
	home: string;
	/** omp's agent directory (it can be moved with PI_CODING_AGENT_DIR). */
	agentDir: string;
	/** The guard's own configuration, state, allowlists, keys, entry, and package. */
	guardPaths: readonly string[];
	/** More protected paths from the user's config, relative to the project or absolute. */
	extra: readonly string[];
	/** Exceptions from the user's config, relative to the project or absolute. */
	allowWrite: readonly string[];
}

/** Project paths omp, its foreign-tool providers, or Bun read code or settings from at startup. */
const PROJECT_PATHS = [".omp", ".pi", ".claude", ".codex", ".mcp.json", "bunfig.toml"];
/** Home paths with the same role: omp's root (agent directory, plugins), the foreign tools, Bun. */
const HOME_PATHS = [".omp", ".pi", ".claude", ".codex", ".bunfig.toml", ".config/omp-extension-guard", ".local/state/omp-extension-guard"];

const PROTECTED_TOKENS = [
	/(^|[^A-Za-z0-9_.-])\.(omp|pi|claude|codex)(?=$|[^A-Za-z0-9_-])/,
	/(^|[^A-Za-z0-9_.-])\.?bunfig\.toml/,
	/(^|[^A-Za-z0-9_.-])\.env(?=$|[.\s'"/;)|&<>])/,
	/\.mcp\.json/,
	/omp-extension-guard/,
];

function expandHome(value: string, home: string): string {
	return value === "~" || value.startsWith("~/") ? path.join(home, value.slice(1)) : value;
}

function resolveFrom(value: string, base: string, home: string): string {
	return path.resolve(base, expandHome(value, home));
}

function isInside(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The real path of `abs`, following symlinks on the part of it that exists. */
export function realPathOf(abs: string): string {
	const tail: string[] = [];
	let current = abs;
	for (let depth = 0; depth < 64; depth++) {
		try {
			const real = fs.realpathSync(current);
			return tail.length > 0 ? path.join(real, ...tail) : real;
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return abs;
			tail.unshift(path.basename(current));
			current = parent;
		}
	}
	return abs;
}

export interface Protection {
	/** Protected roots: the path itself and everything under it. */
	roots: string[];
	/** Directories whose `.env*` files are protected. */
	dotenvDirs: string[];
	allow: string[];
	ctx: ProtectContext;
}

export function protection(ctx: ProtectContext): Protection {
	const roots = [
		...PROJECT_PATHS.map(rel => path.join(ctx.cwd, rel)),
		...HOME_PATHS.map(rel => path.join(ctx.home, rel)),
		ctx.agentDir,
		...ctx.guardPaths,
		...ctx.extra.map(value => resolveFrom(value, ctx.cwd, ctx.home)),
	];
	const withReal = (list: string[]) => [...new Set(list.flatMap(item => [path.resolve(item), realPathOf(path.resolve(item))]))];
	return {
		roots: withReal(roots),
		dotenvDirs: withReal([ctx.cwd]),
		allow: withReal(ctx.allowWrite.map(value => resolveFrom(value, ctx.cwd, ctx.home))),
		ctx,
	};
}

/** Whether writing `target` (resolved against `base`) would touch a protected place, through symlinks too. */
export function isProtectedPath(target: string, base: string, p: Protection): boolean {
	const lexical = resolveFrom(target, base, p.ctx.home);
	const candidates = [lexical, realPathOf(lexical)];
	if (candidates.some(candidate => p.allow.some(allowed => isInside(candidate, allowed)))) return false;
	return candidates.some(
		candidate =>
			p.roots.some(root => isInside(candidate, root)) ||
			(path.basename(candidate).startsWith(".env") && p.dotenvDirs.includes(path.dirname(candidate))),
	);
}

/** Whether `dir` (resolved against `base`) holds a protected place below it. */
function isAncestorOfProtected(target: string, base: string, p: Protection): boolean {
	const dir = realPathOf(resolveFrom(target, base, p.ctx.home));
	return p.roots.some(root => root !== dir && isInside(root, dir));
}

function mentionsProtected(text: string): boolean {
	return PROTECTED_TOKENS.some(pattern => pattern.test(text));
}

function asStrings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
	return [];
}

const PATCH_FILE_LINE = /^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/gm;

/** The paths a write, edit, or ast_edit call would write; `undefined` for other tools. */
export function writeTargets(toolName: string, input: unknown): string[] | undefined {
	const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	switch (toolName) {
		case "write":
			return asStrings(args.path);
		case "edit": {
			const targets = asStrings(args.path);
			if (Array.isArray(args.edits)) {
				for (const edit of args.edits) {
					if (edit && typeof edit === "object") {
						for (const field of ["rename", "move", "moveTo", "to"]) targets.push(...asStrings((edit as Record<string, unknown>)[field]));
					}
				}
			}
			for (const text of [...asStrings(args.input), ...asStrings(args.patch)]) {
				for (const match of text.matchAll(PATCH_FILE_LINE)) targets.push(match[1]!);
			}
			return targets;
		}
		case "ast_edit":
			return asStrings(args.paths).flatMap(entry => entry.split(";").map(item => item.trim()).filter(Boolean));
		default:
			return undefined;
	}
}

const GLOB_CHARS = /[*?[{]/;

/** For ast_edit: the static part of a glob, and whether the walk could reach below a protected place. */
export function astEditTouchesProtected(target: string, base: string, p: Protection): boolean {
	const globAt = target.search(GLOB_CHARS);
	const staticPart = globAt < 0 ? target : target.slice(0, globAt);
	const dir = globAt < 0 ? target : staticPart.endsWith("/") || staticPart === "" ? staticPart || "." : path.dirname(staticPart);
	if (mentionsProtected(target) || isProtectedPath(dir, base, p)) return true;
	const recursive = globAt < 0 ? isDirectory(resolveFrom(target, base, p.ctx.home)) : target.includes("**");
	return recursive && isAncestorOfProtected(dir, base, p);
}

function isDirectory(abs: string): boolean {
	try {
		return fs.statSync(abs).isDirectory();
	} catch {
		return false;
	}
}

// ---- bash ---------------------------------------------------------------------------------------

interface Segment {
	words: string[];
	/** Targets of output redirects (`>`, `>>`, `&>`, `>|`). */
	writes: string[];
	/** Contains command or process substitution, so its effect cannot be read statically. */
	opaque: boolean;
}

/** Splits a command into simple commands, honoring quotes; good enough to find paths and redirects. */
export function parseCommand(command: string): Segment[] {
	const segments: Segment[] = [];
	let current: Segment = { words: [], writes: [], opaque: false };
	let word = "";
	let hasWord = false;
	let redirect = false;
	const pushWord = () => {
		if (hasWord) {
			if (redirect) current.writes.push(word);
			else current.words.push(word);
			redirect = false;
		}
		word = "";
		hasWord = false;
	};
	const endSegment = () => {
		pushWord();
		redirect = false;
		if (current.words.length > 0 || current.writes.length > 0 || current.opaque) segments.push(current);
		current = { words: [], writes: [], opaque: false };
	};
	for (let i = 0; i < command.length; i++) {
		const c = command[i]!;
		const next = command[i + 1];
		if (c === "'") {
			const end = command.indexOf("'", i + 1);
			word += command.slice(i + 1, end < 0 ? command.length : end);
			hasWord = true;
			i = end < 0 ? command.length : end;
			continue;
		}
		if (c === '"') {
			let j = i + 1;
			while (j < command.length && command[j] !== '"') {
				if (command[j] === "\\" && j + 1 < command.length) j++;
				else if (command[j] === "$" && command[j + 1] === "(") current.opaque = true;
				else if (command[j] === "`") current.opaque = true;
				word += command[j];
				j++;
			}
			hasWord = true;
			i = j;
			continue;
		}
		if (c === "\\" && next !== undefined) {
			word += next;
			hasWord = true;
			i++;
			continue;
		}
		if (c === "`" || (c === "$" && next === "(") || ((c === "<" || c === ">") && next === "(")) {
			current.opaque = true;
			word += c;
			hasWord = true;
			continue;
		}
		if (c === "\n" || c === ";" || c === "|" || (c === "&" && next !== ">")) {
			endSegment();
			if ((c === "|" || c === "&") && (next === c || next === "&")) i++;
			continue;
		}
		if (c === " " || c === "\t") {
			pushWord();
			continue;
		}
		if (c === ">" || (c === "&" && next === ">")) {
			const fdDigits = /^\d+$/.test(word);
			if (fdDigits) {
				word = "";
				hasWord = false;
			} else pushWord();
			let j = c === "&" ? i + 2 : i + 1;
			if (command[j] === ">" || command[j] === "|") j++;
			if (command[j] === "&") {
				i = j;
				while (i + 1 < command.length && /[0-9-]/.test(command[i + 1]!)) i++;
				continue;
			}
			redirect = true;
			i = j - 1;
			continue;
		}
		if (c === "<") {
			pushWord();
			while (command[i + 1] === "<") i++;
			continue;
		}
		word += c;
		hasWord = true;
	}
	endSegment();
	return segments;
}

const READ_ONLY = new Set([
	"cat", "less", "more", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "ag", "ls", "tree", "file", "stat", "du", "df",
	"sha256sum", "sha1sum", "sha512sum", "md5sum", "shasum", "b2sum", "cksum", "diff", "cmp", "readlink", "realpath", "basename",
	"dirname", "pwd", "echo", "printf", "true", "false", "test", "[", "jq", "sort", "uniq", "cut", "tr", "nl", "od", "xxd",
	"hexdump", "strings", "column", "type", "which", "cd", "pushd", "popd",
]);
const READ_ONLY_GIT = new Set(["status", "diff", "log", "show", "ls-files", "grep", "blame", "rev-parse", "cat-file", "branch", "describe"]);
const FIND_ACTIONS = /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/;
const INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "source", ".", "bun", "node", "deno", "python", "python3", "perl", "ruby"]);
const RECURSIVE_WRITERS = new Set(["rm", "chmod", "chown", "chgrp", "find", "git"]);
const PLUGIN_INSTALL = /^(install|add|link|enable|update|upgrade)$/;

function commandName(words: readonly string[]): { name: string; args: string[] } {
	let at = 0;
	while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]!)) at++;
	while (at < words.length && ["env", "command", "nohup", "time", "exec", "sudo"].includes(words[at]!)) at++;
	return { name: words[at] ?? "", args: words.slice(at + 1) };
}

function isReadOnly(words: readonly string[]): boolean {
	const { name, args } = commandName(words);
	const base = path.basename(name);
	if (base === "git") return READ_ONLY_GIT.has(args.find(arg => !arg.startsWith("-")) ?? "");
	if (base === "find") return !args.some(arg => FIND_ACTIONS.test(arg));
	return READ_ONLY.has(base);
}

/** A script a unit ships and the approval lists, with the unit's approved digest. */
export interface ScriptUnit {
	path: string;
	digest: string;
	scripts: Record<string, string>;
}

export type Verdict = { ok: true } | { ok: false; rule: string; target?: string };

export interface BashContext {
	protection: Protection;
	units: readonly ScriptUnit[];
	/** Digest function for units and scripts; injected so policy stays free of file hashing details. */
	digest(abs: string): string | undefined;
}

/** Whether running `script` is allowed: it sits in an approved, unchanged unit that lists it unchanged. */
function scriptVerdict(script: string, base: string, ctx: BashContext): Verdict | undefined {
	const abs = realPathOf(resolveFrom(script, base, ctx.protection.ctx.home));
	const unit = ctx.units.find(item => isInside(abs, realPathOf(item.path)));
	if (!unit) return undefined;
	const rel = path.relative(realPathOf(unit.path), abs).split(path.sep).join("/");
	const listed = unit.scripts[rel];
	if (listed === undefined) return { ok: false, rule: "unlisted-script", target: script };
	if (ctx.digest(unit.path) !== unit.digest || ctx.digest(abs) !== listed) return { ok: false, rule: "modified-script", target: script };
	return { ok: true };
}

/** A static reading of a bash command: allowed unless it would write to, run, or install code in a protected place. */
export function bashVerdict(command: string, cwd: string, ctx: BashContext): Verdict {
	const p = ctx.protection;
	let base = cwd;
	let insideProtected = isProtectedPath(".", base, p);
	let tainted = false;
	for (const segment of parseCommand(command)) {
		const { name, args } = commandName(segment.words);
		const exe = path.basename(name);
		if (exe === "omp" && ["plugin", "plugins", "marketplace"].includes(args[0] ?? "") && PLUGIN_INSTALL.test(args[1] ?? "")) {
			return { ok: false, rule: "plugin-install" };
		}
		for (const word of segment.words) {
			const assignment = /^[A-Za-z_][A-Za-z0-9_]*=(.*)$/.exec(word);
			if (assignment && mentionsProtected(assignment[1]!)) tainted = true;
		}
		const usesVariable = segment.words.some(word => word.includes("$")) || segment.writes.some(target => target.includes("$"));
		for (const target of segment.writes) {
			if (isProtectedPath(target, base, p) || mentionsProtected(target) || (tainted && target.includes("$")) || insideProtected) {
				return { ok: false, rule: "protected-write", target };
			}
		}
		const named = segment.words.slice(1).filter(word => isProtectedPath(word, base, p) || mentionsProtected(word));
		const mentions = named.length > 0 || isProtectedPath(name, base, p) || mentionsProtected(name) || insideProtected || (tainted && usesVariable);
		if (exe === "cd" || exe === "pushd") {
			const target = args[0] ?? p.ctx.home;
			base = resolveFrom(target, base, p.ctx.home);
			insideProtected = isProtectedPath(".", base, p);
			continue;
		}
		const recursive = args.some(arg => /^-[A-Za-z]*[rR]/.test(arg) || arg === "--recursive" || FIND_ACTIONS.test(arg));
		const wide = args.some(arg => !arg.startsWith("-") && (arg.includes("**") || isAncestorOfProtected(arg, base, p)));
		if (RECURSIVE_WRITERS.has(exe) && !isReadOnly(segment.words) && (recursive || exe === "git") && wide && (exe !== "git" || args[0] === "clean")) {
			return { ok: false, rule: "protected-write", target: args.find(arg => !arg.startsWith("-")) };
		}
		if (!mentions) continue;
		if (segment.opaque) return { ok: false, rule: "unverifiable" };
		if (isReadOnly(segment.words)) continue;
		const script = INTERPRETERS.has(exe) ? args.find(arg => !arg.startsWith("-")) : name;
		const verdict = script ? scriptVerdict(script, base, ctx) : undefined;
		if (verdict?.ok) continue;
		return verdict ?? { ok: false, rule: "protected-write", target: named[0] ?? name };
	}
	return { ok: true };
}

/** Eval code may run anything, so code that names a protected place is blocked. */
export function evalVerdict(code: string, p: Protection): Verdict {
	if (mentionsProtected(code) || p.roots.some(root => root.length > 1 && code.includes(root))) return { ok: false, rule: "protected-eval" };
	return { ok: true };
}
