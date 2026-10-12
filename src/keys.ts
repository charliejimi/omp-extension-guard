// Unit keys: where a unit sits, independent of the machine. `project:` is relative to the project
// omp runs in, `user:` to omp's agent directory, `home:` to the home directory, and `abs:` is an
// absolute path. Nothing here imports omp.
import * as path from "node:path";

export interface ScopeContext {
	cwd: string;
	agentDir: string;
	home: string;
}

export type Level = "project" | "user" | "external";

function relativeInside(root: string, abs: string): string | undefined {
	const rel = path.relative(root, abs);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
	return rel.split(path.sep).join("/");
}

/** The key of the first of the project, omp's agent directory, HOME, or the filesystem root that holds `abs`. */
export function scopeKey(abs: string, ctx: ScopeContext): string {
	const resolved = path.resolve(abs);
	for (const [scope, root] of [
		["project", ctx.cwd],
		["user", ctx.agentDir],
		["home", ctx.home],
	] as const) {
		const rel = relativeInside(path.resolve(root), resolved);
		if (rel !== undefined) return `${scope}:${rel}`;
	}
	return `abs:${resolved.split(path.sep).join("/")}`;
}

/** The absolute path a key names in this context. */
export function keyPath(key: string, ctx: ScopeContext): string | undefined {
	const at = key.indexOf(":");
	if (at < 0) return undefined;
	const scope = key.slice(0, at);
	const rest = key.slice(at + 1);
	switch (scope) {
		case "project":
			return path.join(ctx.cwd, rest);
		case "user":
			return path.join(ctx.agentDir, rest);
		case "home":
			return path.join(ctx.home, rest);
		case "abs":
			return rest;
		default:
			return undefined;
	}
}

/** Who wrote a unit: the repository's author, you (your own directories), or someone else. */
export function levelOf(key: string): Level {
	if (key.startsWith("project:")) return "project";
	if (key.startsWith("user:") || key.startsWith("home:")) return "user";
	return "external";
}

/** A path for messages: relative to the project, `~/…` under HOME, otherwise absolute. */
export function displayPath(abs: string, ctx: ScopeContext): string {
	const resolved = path.resolve(abs);
	const inProject = relativeInside(path.resolve(ctx.cwd), resolved);
	if (inProject !== undefined) return inProject;
	const inHome = relativeInside(path.resolve(ctx.home), resolved);
	return inHome !== undefined ? `~/${inHome}` : resolved;
}
