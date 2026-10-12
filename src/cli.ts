// omp-extension-guard: the review and CI side. `inventory` lists the code omp would run at startup
// and who wrote it; `keygen`, `allowlist`, `sign`, and `verify` produce the approved-load list; and
// `check` fails a pull request that adds, changes, moves, or renames startup code without approval.
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type ApprovalStatus,
	approvalStatus,
	buildAllowlist,
	generateKeyPair,
	loadTrustedAllowlists,
	parseAllowlist,
	parseApprovals,
	resolvePublicKeys,
	signAllowlist,
	verifyAllowlistSignature,
} from "./allowlist";
import { type Entry, type Inventory, type Unit, displayPath, inventory } from "./inventory";
import { describeStatus } from "./launcher";

export interface CliIO {
	out(line: string): void;
	err(line: string): void;
}

const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

const USAGE = `usage: omp-extension-guard <command> [options]
  inventory [--cwd <dir>] [--json]
      list every unit of code omp would run at startup, who wrote it, and what keeps it out
  keygen <dir> [--force]
      write extension-guard.key.pem (keep it in CI only) and extension-guard.pub.pem
  allowlist --approvals <file> --out <file> [--cwd <dir>] [--expires-in-days <n>]
      pin every approved unit to its current digest
  sign --key <pem> <allowlist>
      write <allowlist>.sig
  verify --public-key <pem> [--public-key <pem>...] <allowlist>
  check --allowlist <file> [--allowlist <file>...] --public-key <pem> [--cwd <dir>] [--scope project|all] [--json]
      exit 1 when startup code is new, changed, moved, or revoked`;

class UsageError extends Error {}

interface Options {
	values: Map<string, string[]>;
	flags: Set<string>;
	positional: string[];
}

function parseOptions(argv: readonly string[], valued: readonly string[], flags: readonly string[]): Options {
	const out: Options = { values: new Map(), flags: new Set(), positional: [] };
	for (let i = 0; i < argv.length; i++) {
		let arg = argv[i]!;
		let inline: string | undefined;
		const equals = arg.indexOf("=");
		if (arg.startsWith("--") && equals > 0) {
			inline = arg.slice(equals + 1);
			arg = arg.slice(0, equals);
		}
		if (valued.includes(arg)) {
			const value = inline ?? argv[++i];
			if (value === undefined) throw new UsageError(`${arg} needs a value`);
			out.values.set(arg, [...(out.values.get(arg) ?? []), value]);
		} else if (flags.includes(arg)) {
			out.flags.add(arg);
		} else if (arg.startsWith("-")) {
			throw new UsageError(`unknown option ${arg}`);
		} else {
			out.positional.push(arg);
		}
	}
	return out;
}

function one(options: Options, name: string, required = true): string | undefined {
	const values = options.values.get(name);
	if (!values || values.length === 0) {
		if (required) throw new UsageError(`${name} is required`);
		return undefined;
	}
	return path.resolve(values.at(-1)!);
}

function switchText(entry: Entry): string {
	const s = entry.switches;
	if (s.includes("omit")) return "named on omp's command line";
	if (s.includes("launch-dir")) return "Bun preloads it; stopped by starting omp from another directory";
	if (entry.role === "command") return "stopped by --trusted-extension or --no-extensions";
	if (s.includes("overlay-extensions")) return "stopped by --trusted-extension, --no-extensions, or replacing the extensions: setting";
	if (s.includes("trusted-extension")) return `stopped by --trusted-extension, --no-extensions, or disabledExtensions ${entry.disableId}`;
	if (s.includes("disabled-id")) return `no flag stops it; only disabledExtensions ${entry.disableId}`;
	return "nothing stops it but removing it";
}

const LEVEL_HEADINGS: Array<[Unit["level"], string]> = [
	["project", "Written by the repository's author (low trust: picked up because omp runs in this directory):"],
	["user", "Installed by you, in your own directories (a deliberate install is not an escalation):"],
	["external", "Elsewhere on this machine:"],
];

function printInventory(inv: Inventory, io: CliIO): void {
	io.out(`Code omp would run at startup in ${inv.cwd}: inside omp's own process, before the first model request,`);
	io.out("with your permissions and your environment variables.");
	for (const [level, heading] of LEVEL_HEADINGS) {
		const units = inv.units.filter(unit => unit.level === level);
		if (units.length === 0) continue;
		io.out("");
		io.out(heading);
		for (const unit of units) {
			const pin = unit.digest ? unit.digest.slice(0, 19) : `could not be hashed: ${unit.error}`;
			for (const entry of unit.entries) {
				io.out(`  ${unit.key} [${unit.kind}] ${path.basename(entry.path)}: ${switchText(entry)} (${pin})`);
			}
		}
	}
	if (inv.dotenv.length > 0) {
		io.out("");
		io.out(`Bun also loads into a process started here: ${inv.dotenv.map(file => path.basename(file)).join(", ")} (environment variables; stopped by starting omp from another directory).`);
	}
}

function inventoryJson(inv: Inventory): unknown {
	return {
		units: inv.units.map(unit => ({
			kind: unit.kind,
			key: unit.key,
			level: unit.level,
			...(unit.via ? { via: unit.via } : {}),
			...(unit.digest ? { digest: unit.digest } : { error: unit.error }),
			scripts: Object.keys(unit.scripts),
			entries: unit.entries.map(entry => ({
				file: displayPath(entry.path, inv),
				role: entry.role,
				switches: entry.switches,
				...(entry.disableId ? { disableId: entry.disableId } : {}),
			})),
		})),
		dotenv: inv.dotenv.map(file => displayPath(file, inv)),
	};
}

async function cmdInventory(argv: readonly string[], io: CliIO): Promise<number> {
	const options = parseOptions(argv, ["--cwd"], ["--json"]);
	const inv = await inventory(one(options, "--cwd", false) ?? process.cwd());
	if (options.flags.has("--json")) io.out(JSON.stringify(inventoryJson(inv), null, 2));
	else printInventory(inv, io);
	return 0;
}

function cmdKeygen(argv: readonly string[], io: CliIO): number {
	const options = parseOptions(argv, [], ["--force"]);
	const dir = options.positional[0];
	if (!dir) throw new UsageError("keygen needs a directory");
	const keyFile = path.resolve(dir, "extension-guard.key.pem");
	const pubFile = path.resolve(dir, "extension-guard.pub.pem");
	if (!options.flags.has("--force") && (fs.existsSync(keyFile) || fs.existsSync(pubFile))) {
		io.err(`omp-extension-guard: ${fs.existsSync(keyFile) ? keyFile : pubFile} already exists; pass --force to replace it`);
		return EXIT_FAIL;
	}
	const pair = generateKeyPair();
	fs.mkdirSync(path.dirname(keyFile), { recursive: true });
	fs.writeFileSync(keyFile, pair.privateKeyPem, { mode: 0o600 });
	fs.chmodSync(keyFile, 0o600);
	fs.writeFileSync(pubFile, pair.publicKeyPem);
	io.out(`wrote ${keyFile} (store it as a CI secret only) and ${pubFile}`);
	return 0;
}

async function cmdAllowlist(argv: readonly string[], io: CliIO): Promise<number> {
	const options = parseOptions(argv, ["--approvals", "--out", "--cwd", "--expires-in-days"], []);
	const approvalsFile = one(options, "--approvals")!;
	const out = one(options, "--out")!;
	const daysText = options.values.get("--expires-in-days")?.at(-1);
	const days = daysText === undefined ? undefined : Number(daysText);
	if (days !== undefined && (!Number.isFinite(days) || days <= 0)) throw new UsageError("--expires-in-days must be a positive number");
	try {
		const approvals = parseApprovals(fs.readFileSync(approvalsFile, "utf8"));
		const inv = await inventory(one(options, "--cwd", false) ?? process.cwd());
		const list = buildAllowlist(approvals, inv.units, { expiresInDays: days });
		fs.writeFileSync(out, `${JSON.stringify(list, null, 2)}\n`);
		io.out(`wrote ${out}: ${list.items.length} approved units${list.expiresAt ? `, expires ${list.expiresAt}` : ""}`);
		return 0;
	} catch (err) {
		io.err(`omp-extension-guard: ${err instanceof Error ? err.message : String(err)}`);
		return EXIT_FAIL;
	}
}

function cmdSign(argv: readonly string[], io: CliIO): number {
	const options = parseOptions(argv, ["--key"], []);
	const key = one(options, "--key")!;
	const file = options.positional[0];
	if (!file) throw new UsageError("sign needs an allowlist file");
	const content = fs.readFileSync(file);
	parseAllowlist(content.toString("utf8"));
	fs.writeFileSync(`${file}.sig`, `${signAllowlist(content, fs.readFileSync(key, "utf8"))}\n`);
	io.out(`wrote ${file}.sig`);
	return 0;
}

function cmdVerify(argv: readonly string[], io: CliIO): number {
	const options = parseOptions(argv, ["--public-key", "--signature"], []);
	const file = options.positional[0];
	if (!file) throw new UsageError("verify needs an allowlist file");
	const keys = resolvePublicKeys((options.values.get("--public-key") ?? []).map(key => path.resolve(key)));
	if (keys.length === 0) throw new UsageError("--public-key is required");
	const content = fs.readFileSync(file);
	const signatureFile = one(options, "--signature", false) ?? `${file}.sig`;
	let signature: string;
	try {
		signature = fs.readFileSync(signatureFile, "utf8");
	} catch {
		io.err(`omp-extension-guard: the signature file ${signatureFile} was not found`);
		return EXIT_FAIL;
	}
	if (!verifyAllowlistSignature(content, signature, keys)) {
		io.err("omp-extension-guard: the signature does not verify against the given public key");
		return EXIT_FAIL;
	}
	try {
		const list = parseAllowlist(content.toString("utf8"));
		io.out(`valid: ${list.items.length} approved units${list.expiresAt ? `, expires ${list.expiresAt}` : ""}`);
		return 0;
	} catch (err) {
		io.err(`omp-extension-guard: ${err instanceof Error ? err.message : String(err)}`);
		return EXIT_FAIL;
	}
}

async function cmdCheck(argv: readonly string[], io: CliIO): Promise<number> {
	const options = parseOptions(argv, ["--allowlist", "--public-key", "--cwd", "--scope"], ["--json"]);
	const allowlists = (options.values.get("--allowlist") ?? []).map(file => path.resolve(file));
	if (allowlists.length === 0) throw new UsageError("--allowlist is required");
	const publicKeys = (options.values.get("--public-key") ?? []).map(file => path.resolve(file));
	const scope = options.values.get("--scope")?.at(-1) ?? "project";
	if (scope !== "project" && scope !== "all") throw new UsageError("--scope must be project or all");
	const trusted = loadTrustedAllowlists({ allowlists, publicKeys });
	for (const problem of trusted.problems) io.err(`omp-extension-guard: allowlist left out: ${problem}`);
	if (!trusted.approvals) return EXIT_FAIL;
	const inv = await inventory(one(options, "--cwd", false) ?? process.cwd());
	const units = inv.units.filter(unit => scope === "all" || unit.level === "project");
	const approvedEntries = [...trusted.approvals.entries.values()].flat();
	const results = units.map(unit => {
		const status: ApprovalStatus = approvalStatus(unit, trusted.approvals);
		const elsewhere = status === "not-approved" ? approvedEntries.find(entry => entry.kind === unit.kind && entry.digest === unit.digest && entry.key !== unit.key) : undefined;
		return { key: unit.key, kind: unit.kind, status, ...(elsewhere ? { approvedAt: elsewhere.key } : {}) };
	});
	const failing = results.filter(result => result.status !== "approved");
	if (options.flags.has("--json")) {
		io.out(JSON.stringify({ ok: failing.length === 0, units: results }, null, 2));
	} else {
		for (const result of failing) {
			const moved = "approvedAt" in result ? `; identical to the unit approved at ${result.approvedAt} (moved or renamed?)` : "";
			io.out(`${result.key} (${result.kind}): ${describeStatus(result.status)}${moved}`);
		}
		io.out(failing.length === 0 ? `ok: all ${results.length} units are approved` : `${failing.length} of ${results.length} units need review`);
	}
	return failing.length === 0 ? 0 : EXIT_FAIL;
}

/** The `omp-extension-guard` command. */
export async function runCli(argv: readonly string[], io: CliIO): Promise<number> {
	const [command, ...rest] = argv;
	try {
		switch (command) {
			case "inventory":
				return await cmdInventory(rest, io);
			case "keygen":
				return cmdKeygen(rest, io);
			case "allowlist":
				return await cmdAllowlist(rest, io);
			case "sign":
				return cmdSign(rest, io);
			case "verify":
				return cmdVerify(rest, io);
			case "check":
				return await cmdCheck(rest, io);
			case "-h":
			case "--help":
			case "help":
				io.out(USAGE);
				return 0;
			default:
				throw new UsageError(command ? `unknown command ${command}` : "a command is required");
		}
	} catch (err) {
		if (err instanceof UsageError) {
			io.err(`omp-extension-guard: ${err.message}`);
			io.err(USAGE);
			return EXIT_USAGE;
		}
		io.err(`omp-extension-guard: ${err instanceof Error ? err.message : String(err)}`);
		return EXIT_FAIL;
	}
}
