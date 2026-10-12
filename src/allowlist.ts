// The approved-load list: which units of startup code a named reviewer approved, each pinned to a
// digest of its file or directory, signed with an Ed25519 key the agent never sees. Nothing here
// imports omp, so the guard can use it inside omp's process.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const ALLOWLIST_SCHEMA = "omp-extension-guard/allowlist@1";

/** Where omp loads a unit from; moving a unit to another surface needs a new approval. */
export const UNIT_KINDS = ["extension", "hook", "configured", "explicit", "plugin", "tool", "command", "preload"] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

export interface AllowlistEntry {
	kind: UnitKind;
	/** `project:<path>`, `user:<path>` (omp's agent directory), `home:<path>`, or `abs:<path>`. */
	key: string;
	/** `sha256:` digest of the unit; see {@link digestUnit}. */
	digest: string;
	/** Each script's digest, keyed by its POSIX path inside the unit. */
	scripts: Record<string, string>;
	/** Where the unit came from: a repository URL, a package name, or a team. */
	source: string;
	version?: string;
	commit?: string;
	/** The named reviewer (a person, team, or role) who approved it. */
	reviewer: string;
}

export interface Allowlist {
	schema: typeof ALLOWLIST_SCHEMA;
	issuedAt: string;
	expiresAt?: string;
	items: AllowlistEntry[];
	/** Keys whose approval was withdrawn, in any list. */
	revoked: string[];
}

export class AllowlistError extends Error {}
export class DigestError extends Error {}

export interface DigestLimits {
	maxFiles: number;
	maxBytes: number;
	maxDepth: number;
}

export const DEFAULT_DIGEST_LIMITS: DigestLimits = { maxFiles: 10_000, maxBytes: 64 * 1024 * 1024, maxDepth: 32 };

const KEY = /^(project|user|home):(.+)$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const ED25519_SIGNATURE_BYTES = 64;

function isRelativePath(rel: string): boolean {
	if (rel.length === 0 || rel.includes("\\") || rel.includes("\0") || rel.startsWith("/")) return false;
	return rel.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..");
}

/** A scope and a path inside it, with no `..` segments. */
export function isValidKey(key: unknown): key is string {
	if (typeof key !== "string") return false;
	if (key.startsWith("abs:")) {
		const abs = key.slice(4);
		return path.posix.isAbsolute(abs) && !abs.includes("\0") && path.posix.normalize(abs) === abs && abs !== "/";
	}
	const match = KEY.exec(key);
	return match !== null && isRelativePath(match[2]!);
}

function sha256(data: string | Uint8Array): string {
	return crypto.createHash("sha256").update(data).digest("hex");
}

function isInside(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

interface DirEntry {
	rel: string;
	abs: string;
	stat: fs.Stats;
}

/**
 * Every file and symlink under the real directory `dir`, sorted by POSIX path. Throws on a special
 * file, on a symlink that points outside `dir` (the code it reaches would not be pinned), or beyond
 * the limits.
 */
function walk(dir: string, limits: DigestLimits): DirEntry[] {
	const entries: DirEntry[] = [];
	let bytes = 0;
	const visit = (abs: string, rel: string, depth: number) => {
		if (depth > limits.maxDepth) throw new DigestError(`nested deeper than ${limits.maxDepth} directories`);
		for (const name of fs.readdirSync(abs)) {
			const childAbs = path.join(abs, name);
			const childRel = rel ? `${rel}/${name}` : name;
			const stat = fs.lstatSync(childAbs);
			if (stat.isDirectory()) {
				visit(childAbs, childRel, depth + 1);
				continue;
			}
			if (stat.isSymbolicLink()) {
				const target = path.resolve(path.dirname(childAbs), fs.readlinkSync(childAbs));
				let real = target;
				try {
					real = fs.realpathSync(childAbs);
				} catch {}
				if (!isInside(target, dir) || !isInside(real, dir)) {
					throw new DigestError(`${JSON.stringify(childRel)} is a symlink that leaves the unit`);
				}
			} else if (!stat.isFile()) {
				throw new DigestError(`${JSON.stringify(childRel)} is a special file`);
			}
			if (entries.length >= limits.maxFiles) throw new DigestError(`more than ${limits.maxFiles} files`);
			if (stat.isFile()) {
				bytes += stat.size;
				if (bytes > limits.maxBytes) throw new DigestError(`more than ${limits.maxBytes} bytes`);
			}
			entries.push({ rel: childRel, abs: childAbs, stat });
		}
	};
	visit(dir, "", 0);
	return entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

function realUnit(unit: string): { real: string; stat: fs.Stats } {
	const real = fs.realpathSync(unit);
	const stat = fs.statSync(real);
	if (!stat.isFile() && !stat.isDirectory()) throw new DigestError(`${path.basename(unit)} is a special file`);
	return { real, stat };
}

/**
 * The `sha256:` digest of a unit, after following a symlink at the unit itself. A file unit is
 * pinned to its content. A directory unit is pinned to each regular file's path, executable bit,
 * and content, and each internal symlink's path and target, in path order; directories are not
 * recorded, so an empty directory, which git cannot carry, does not change it.
 */
export function digestUnit(unit: string, limits: Partial<DigestLimits> = {}): string {
	const { real, stat } = realUnit(unit);
	if (stat.isFile()) return `sha256:${sha256(fs.readFileSync(real))}`;
	const lines = walk(real, { ...DEFAULT_DIGEST_LIMITS, ...limits }).map(({ rel, abs, stat: entry }) =>
		entry.isSymbolicLink()
			? `l ${JSON.stringify(rel)} ${sha256(fs.readlinkSync(abs))}`
			: `f ${(entry.mode & 0o111) !== 0 ? "x" : "-"} ${JSON.stringify(rel)} ${sha256(fs.readFileSync(abs))}`,
	);
	return `sha256:${sha256(lines.join("\n"))}`;
}

/** Whether a path inside a unit counts as a script: under `scripts/`, or executable. */
export function isScript(rel: string, stat: fs.Stats): boolean {
	return stat.isFile() && (rel.startsWith("scripts/") || (stat.mode & 0o111) !== 0);
}

/** A directory unit's scripts with their digests; a file unit has none. */
export function unitScripts(unit: string, limits: Partial<DigestLimits> = {}): Record<string, string> {
	const { real, stat } = realUnit(unit);
	if (stat.isFile()) return {};
	const scripts: Record<string, string> = {};
	for (const entry of walk(real, { ...DEFAULT_DIGEST_LIMITS, ...limits })) {
		if (isScript(entry.rel, entry.stat)) scripts[entry.rel] = `sha256:${sha256(fs.readFileSync(entry.abs))}`;
	}
	return scripts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredText(value: unknown, what: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new AllowlistError(`${what} is missing`);
	return value;
}

function optionalText(value: unknown, what: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new AllowlistError(`${what} must be text`);
	return value.trim() === "" ? undefined : value;
}

function isKind(value: unknown): value is UnitKind {
	return typeof value === "string" && (UNIT_KINDS as readonly string[]).includes(value);
}

/** The review record shared by an approvals file and an allowlist entry. */
function reviewOf(value: Record<string, unknown>, key: string): Pick<AllowlistEntry, "kind" | "source" | "version" | "commit" | "reviewer"> {
	if (!isKind(value.kind)) throw new AllowlistError(`${key}: kind must be one of ${UNIT_KINDS.join(", ")}`);
	const version = optionalText(value.version, `${key}: version`);
	const commit = optionalText(value.commit, `${key}: commit`);
	if (version === undefined && commit === undefined) throw new AllowlistError(`${key}: a version or commit is required`);
	return {
		kind: value.kind,
		source: requiredText(value.source, `${key}: source`),
		...(version !== undefined ? { version } : {}),
		...(commit !== undefined ? { commit } : {}),
		reviewer: requiredText(value.reviewer, `${key}: reviewer`),
	};
}

function parseEntry(value: unknown): AllowlistEntry {
	if (!isRecord(value)) throw new AllowlistError("every item must be an object");
	if (!isValidKey(value.key)) throw new AllowlistError(`key ${JSON.stringify(value.key)} is not a valid unit key`);
	const key = value.key;
	const review = reviewOf(value, key);
	if (typeof value.digest !== "string" || !DIGEST.test(value.digest)) throw new AllowlistError(`${key}: digest must be sha256:<64 lowercase hex>`);
	if (!isRecord(value.scripts)) throw new AllowlistError(`${key}: scripts must be an object`);
	const scripts: Record<string, string> = {};
	for (const [rel, digest] of Object.entries(value.scripts)) {
		if (!isRelativePath(rel)) throw new AllowlistError(`${key}: script path ${JSON.stringify(rel)} is not a path inside the unit`);
		if (typeof digest !== "string" || !DIGEST.test(digest)) throw new AllowlistError(`${key}: script ${rel} has no valid digest`);
		scripts[rel] = digest;
	}
	return { kind: review.kind, key, digest: value.digest, scripts, source: review.source, ...withVersion(review), reviewer: review.reviewer };
}

function withVersion(review: Pick<AllowlistEntry, "version" | "commit">): Pick<AllowlistEntry, "version" | "commit"> {
	return { ...(review.version !== undefined ? { version: review.version } : {}), ...(review.commit !== undefined ? { commit: review.commit } : {}) };
}

function timestamp(value: unknown, what: string): string {
	if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new AllowlistError(`${what} must be an ISO date`);
	return value;
}

/** Parses and validates an allowlist; throws {@link AllowlistError} naming the first problem. */
export function parseAllowlist(text: string, now: Date = new Date()): Allowlist {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		throw new AllowlistError(`not valid JSON (${err instanceof Error ? err.message : String(err)})`);
	}
	if (!isRecord(raw)) throw new AllowlistError("not a JSON object");
	if (raw.schema !== ALLOWLIST_SCHEMA) throw new AllowlistError(`schema must be "${ALLOWLIST_SCHEMA}"`);
	const issuedAt = timestamp(raw.issuedAt, "issuedAt");
	const expiresAt = raw.expiresAt === undefined ? undefined : timestamp(raw.expiresAt, "expiresAt");
	if (expiresAt !== undefined && Date.parse(expiresAt) <= now.getTime()) throw new AllowlistError(`the allowlist expired at ${expiresAt}`);
	if (!Array.isArray(raw.items)) throw new AllowlistError("items must be an array");
	const items = raw.items.map(parseEntry);
	const keys = new Set<string>();
	for (const item of items) {
		if (keys.has(item.key)) throw new AllowlistError(`duplicate key ${item.key}`);
		keys.add(item.key);
	}
	const revokedRaw = raw.revoked ?? [];
	if (!Array.isArray(revokedRaw) || !revokedRaw.every(isValidKey)) throw new AllowlistError("revoked must be a list of unit keys");
	for (const key of revokedRaw) {
		if (keys.has(key)) throw new AllowlistError(`${key} is both approved and revoked`);
	}
	return { schema: ALLOWLIST_SCHEMA, issuedAt, ...(expiresAt ? { expiresAt } : {}), items, revoked: [...revokedRaw] };
}

/** A detached Ed25519 signature over the allowlist's exact bytes, base64-encoded. */
export function signAllowlist(content: string | Uint8Array, privateKeyPem: string): string {
	return crypto.sign(null, Buffer.from(content), crypto.createPrivateKey(privateKeyPem)).toString("base64");
}

/** Whether `signature` is a valid Ed25519 signature of `content` by any of the given public keys. */
export function verifyAllowlistSignature(content: string | Uint8Array, signature: string, publicKeyPems: readonly string[]): boolean {
	const encoded = signature.trim();
	if (!BASE64.test(encoded)) return false;
	const bytes = Buffer.from(encoded, "base64");
	if (bytes.length !== ED25519_SIGNATURE_BYTES) return false;
	const data = Buffer.from(content);
	for (const pem of publicKeyPems) {
		try {
			const key = crypto.createPublicKey(pem);
			if (key.asymmetricKeyType === "ed25519" && crypto.verify(null, data, key, bytes)) return true;
		} catch {}
	}
	return false;
}

export function generateKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
	const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
	return {
		privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
		publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
	};
}

/** Public keys given as PEM text or as paths to PEM files; unreadable files are skipped. */
export function resolvePublicKeys(entries: readonly string[]): string[] {
	const keys: string[] = [];
	for (const entry of entries) {
		if (entry.trimStart().startsWith("-----BEGIN")) {
			keys.push(entry);
			continue;
		}
		try {
			keys.push(fs.readFileSync(entry, "utf8"));
		} catch {}
	}
	return keys;
}

/** Every verified allowlist, merged: approvals by key, and the union of revoked keys. */
export interface Approvals {
	entries: Map<string, AllowlistEntry[]>;
	revoked: Set<string>;
	/** The file names of the lists that verified. */
	lists: string[];
}

export interface TrustedAllowlistOptions {
	/** Allowlist files; each is signed in `<file>.sig`. */
	allowlists?: readonly string[];
	/** PEM text or paths to PEM files. */
	publicKeys?: readonly string[];
	now?: Date;
}

export interface TrustedAllowlists {
	/** Absent when no list verified. */
	approvals?: Approvals;
	/** One line per list that was left out, naming the file and the reason, never its content. */
	problems: string[];
}

/** Loads every allowlist whose signature verifies against a trusted key and that is valid and unexpired. */
export function loadTrustedAllowlists(options: TrustedAllowlistOptions): TrustedAllowlists {
	const files = options.allowlists ?? [];
	if (files.length === 0) return { problems: ["no allowlist is configured"] };
	const keys = resolvePublicKeys(options.publicKeys ?? []);
	if (keys.length === 0) return { problems: ["no trusted public key is configured"] };
	const problems: string[] = [];
	const approvals: Approvals = { entries: new Map(), revoked: new Set(), lists: [] };
	for (const file of files) {
		const name = path.basename(file);
		let text: string;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch {
			problems.push(`${name}: not found`);
			continue;
		}
		let signature: string;
		try {
			signature = fs.readFileSync(`${file}.sig`, "utf8");
		} catch {
			problems.push(`${name}: the signature file was not found`);
			continue;
		}
		if (!verifyAllowlistSignature(text, signature, keys)) {
			problems.push(`${name}: the signature does not verify against a trusted public key`);
			continue;
		}
		let list: Allowlist;
		try {
			list = parseAllowlist(text, options.now);
		} catch (err) {
			problems.push(`${name}: rejected: ${err instanceof Error ? err.message : String(err)}`);
			continue;
		}
		approvals.lists.push(name);
		for (const item of list.items) approvals.entries.set(item.key, [...(approvals.entries.get(item.key) ?? []), item]);
		for (const key of list.revoked) approvals.revoked.add(key);
	}
	return approvals.lists.length > 0 ? { approvals, problems } : { problems };
}

export type ApprovalStatus = "approved" | "not-approved" | "modified" | "revoked" | "unreadable" | "no-allowlist";

/** How a unit with this kind, key, and current digest stands against the approvals. */
export function approvalStatus(unit: { kind: UnitKind; key: string; digest?: string }, approvals: Approvals | undefined): ApprovalStatus {
	if (!approvals) return "no-allowlist";
	if (unit.digest === undefined) return "unreadable";
	if (approvals.revoked.has(unit.key)) return "revoked";
	const entries = (approvals.entries.get(unit.key) ?? []).filter(entry => entry.kind === unit.kind);
	if (entries.length === 0) return "not-approved";
	return entries.some(entry => entry.digest === unit.digest) ? "approved" : "modified";
}

/** The approved entry matching this unit's kind, key, and digest. */
export function approvedEntry(unit: { kind: UnitKind; key: string; digest?: string }, approvals: Approvals | undefined): AllowlistEntry | undefined {
	if (approvalStatus(unit, approvals) !== "approved") return undefined;
	return approvals?.entries.get(unit.key)?.find(entry => entry.kind === unit.kind && entry.digest === unit.digest);
}

export interface ApprovalRecord {
	kind: UnitKind;
	source: string;
	version?: string;
	commit?: string;
	reviewer: string;
	/** The unit's scripts as the reviewer saw them; must match the unit's scripts exactly. */
	scripts: string[];
}

/** What reviewers write: one record per unit key, plus withdrawn keys. */
export interface ApprovalsFile {
	items: Record<string, ApprovalRecord>;
	revoked: string[];
}

/** Parses an approvals file; throws {@link AllowlistError} listing every problem. */
export function parseApprovals(text: string): ApprovalsFile {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		throw new AllowlistError(`the approvals file is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
	}
	if (!isRecord(raw) || !isRecord(raw.items)) throw new AllowlistError("the approvals file needs an items object keyed by unit key");
	const problems: string[] = [];
	const items: Record<string, ApprovalRecord> = {};
	for (const [key, value] of Object.entries(raw.items)) {
		try {
			if (!isValidKey(key)) throw new AllowlistError(`${JSON.stringify(key)} is not a valid unit key`);
			if (!isRecord(value)) throw new AllowlistError(`${key}: must be an object`);
			const scripts = value.scripts ?? [];
			if (!Array.isArray(scripts) || !scripts.every(rel => typeof rel === "string" && isRelativePath(rel))) {
				throw new AllowlistError(`${key}: scripts must be a list of paths inside the unit`);
			}
			items[key] = { ...reviewOf(value, key), scripts: [...scripts].sort() };
		} catch (err) {
			problems.push(err instanceof Error ? err.message : String(err));
		}
	}
	const revoked = raw.revoked ?? [];
	if (!Array.isArray(revoked) || !revoked.every(isValidKey)) problems.push("revoked must be a list of unit keys");
	if (problems.length > 0) throw new AllowlistError(problems.join("; "));
	return { items, revoked: revoked as string[] };
}

export interface BuildOptions {
	now?: Date;
	expiresInDays?: number;
}

/**
 * Pins every approved unit to its current digest and scripts. Refuses, listing every problem, a key
 * omp does not load, a kind other than where omp loads it, a unit that could not be hashed, and a
 * script list that differs from the unit's scripts.
 */
export function buildAllowlist(
	approvals: ApprovalsFile,
	units: ReadonlyArray<{ kind: UnitKind; key: string; digest?: string; scripts: Record<string, string>; error?: string }>,
	options: BuildOptions = {},
): Allowlist {
	const problems: string[] = [];
	const items: AllowlistEntry[] = [];
	for (const [key, record] of Object.entries(approvals.items)) {
		const unit = units.find(item => item.key === key);
		if (!unit) {
			problems.push(`${key}: not found among the units omp would load`);
			continue;
		}
		if (unit.kind !== record.kind) {
			problems.push(`${key}: approved as ${record.kind}, but omp loads it as ${unit.kind}`);
			continue;
		}
		if (!unit.digest) {
			problems.push(`${key}: could not be hashed (${unit.error ?? "unknown error"})`);
			continue;
		}
		const actual = Object.keys(unit.scripts).sort();
		if (actual.join("\n") !== record.scripts.join("\n")) {
			problems.push(`${key}: the approved scripts [${record.scripts.join(", ")}] differ from the unit's scripts [${actual.join(", ")}]`);
			continue;
		}
		items.push({
			kind: unit.kind,
			key,
			digest: unit.digest,
			scripts: unit.scripts,
			source: record.source,
			...withVersion(record),
			reviewer: record.reviewer,
		});
	}
	if (problems.length > 0) throw new AllowlistError(problems.join("; "));
	const now = options.now ?? new Date();
	const expiresAt =
		options.expiresInDays !== undefined ? new Date(now.getTime() + options.expiresInDays * 24 * 60 * 60 * 1000).toISOString() : undefined;
	return { schema: ALLOWLIST_SCHEMA, issuedAt: now.toISOString(), ...(expiresAt ? { expiresAt } : {}), items, revoked: [...approvals.revoked] };
}
