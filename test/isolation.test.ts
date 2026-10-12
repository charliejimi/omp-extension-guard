import { Database } from "bun:sqlite";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_PASS_ENV, checkExposure, childEnv, looksLikeCredentialName, looksLikeCredentialValue } from "../src/isolation";
import { homeDir, removeTemps, resetUserLevel, tempDir, writeHome } from "./fixtures";

afterAll(removeTemps);
afterEach(resetUserLevel);

const GITHUB_PAT = `github_pat_${"A1b2C3d4".repeat(10)}`;
const OPENAI_KEY = `sk-proj-${"Zx9Yw8Vu7".repeat(5)}`;

describe("childEnv", () => {
	it("starts empty and keeps only the allowlisted names", () => {
		const env = childEnv(
			{ PATH: "/usr/bin", HOME: "/home/u", LANG: "C.UTF-8", CURSOR_API_KEY: "secret", SSH_AUTH_SOCK: "/tmp/agent", GH_TOKEN: GITHUB_PAT, EXTRA: "1" },
			["EXTRA"],
		);
		expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/u", LANG: "C.UTF-8", EXTRA: "1" });
		expect(DEFAULT_PASS_ENV).not.toContain("SSH_AUTH_SOCK");
	});
});

describe("credential patterns", () => {
	it("recognizes credential names and well-known key formats, not ordinary values", () => {
		for (const name of ["CURSOR_API_KEY", "ANTHROPIC_API_KEY", "GH_TOKEN", "AWS_SECRET_ACCESS_KEY", "DB_PASSWORD", "NPM_AUTH_TOKEN"]) {
			expect(looksLikeCredentialName(name)).toBe(true);
		}
		for (const name of ["PATH", "TOKENIZERS_PARALLELISM", "KEYBOARD", "HOME"]) expect(looksLikeCredentialName(name)).toBe(false);
		for (const value of [GITHUB_PAT, OPENAI_KEY, "AKIAIOSFODNN7EXAMPLE", "xoxb-1234567890-abcdefghij", "glpat-abcdefghij1234567890"]) {
			expect(looksLikeCredentialValue(value)).toBe(true);
		}
		for (const value of ["/usr/bin:/bin", "C.UTF-8", "proxy-managed", "1"]) expect(looksLikeCredentialValue(value)).toBe(false);
	});
});

describe("checkExposure", () => {
	const base = () => ({ home: homeDir(), argv: [] as string[], env: { PATH: "/usr/bin" } as Record<string, string> });

	it("finds a credential passed in the environment, by name or by value, and lets a placeholder through", () => {
		const findings = checkExposure({
			...base(),
			env: { PATH: "/usr/bin", CURSOR_API_KEY: "key-123456789", RELAY: GITHUB_PAT, ANTHROPIC_API_KEY: "proxy-managed" },
		});
		expect(findings.map(f => [f.key, f.check, f.accepted])).toEqual([
			["env:CURSOR_API_KEY", "env", false],
			["env:RELAY", "env", false],
		]);
		expect(JSON.stringify(findings)).not.toContain("key-123456789");
		expect(JSON.stringify(findings)).not.toContain(GITHUB_PAT);
	});

	it("finds a credential in omp's arguments", () => {
		const findings = checkExposure({ ...base(), argv: ["--model", "x", "--api-key", OPENAI_KEY, `--api-key=${OPENAI_KEY}`, "--api-key", "proxy-managed"] });
		expect(findings.map(f => f.key)).toEqual(["argv:3", "argv:4"]);
		expect(JSON.stringify(findings)).not.toContain(OPENAI_KEY);
	});

	it("finds credential files the process could read", () => {
		writeHome(".git-credentials", `https://user:${GITHUB_PAT}@github.com\n`);
		writeHome(".config/gh/hosts.yml", `github.com:\n  oauth_token: ${GITHUB_PAT}\n`);
		writeHome(".aws/credentials", "[default]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\n");
		writeHome(".npmrc", "registry=https://registry.npmjs.org/\n");
		const extra = path.join(tempDir("eg-extra-"), "token.txt");
		fs.writeFileSync(extra, "t\n");
		const findings = checkExposure({ ...base(), extraFiles: [extra] });
		expect(findings.map(f => f.key)).toEqual(["file:~/.git-credentials", "file:~/.config/gh/hosts.yml", "file:~/.aws/credentials", `file:${extra}`]);
		writeHome(".npmrc", "//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789\n");
		expect(checkExposure(base()).map(f => f.key)).toContain("file:~/.npmrc");
	});

	it("lists the providers whose credentials omp's store holds, never the credentials", () => {
		const dir = tempDir("eg-store-");
		const store = path.join(dir, "agent.db");
		const db = new Database(store);
		db.run("CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL, disabled_cause TEXT DEFAULT NULL)");
		db.run("INSERT INTO auth_credentials (provider, credential_type, data) VALUES ('anthropic', 'api_key', ?)", [JSON.stringify({ key: OPENAI_KEY })]);
		db.run("INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause) VALUES ('openai', 'api_key', 'x', 'revoked')");
		db.close();
		const findings = checkExposure({ ...base(), storePath: store });
		expect(findings.map(f => f.key)).toEqual(["store:anthropic"]);
		expect(JSON.stringify(findings)).not.toContain(OPENAI_KEY);
		expect(checkExposure({ ...base(), storePath: path.join(dir, "missing.db") })).toEqual([]);
		const corrupt = path.join(dir, "corrupt.db");
		fs.writeFileSync(corrupt, "not a database");
		expect(checkExposure({ ...base(), storePath: corrupt }).map(f => f.key)).toEqual(["store:unreadable"]);
	});

	it("marks findings the user accepted", () => {
		const findings = checkExposure({ ...base(), env: { PATH: "/usr/bin", CURSOR_API_KEY: "key-123456789" }, accept: ["env:CURSOR_API_KEY"] });
		expect(findings).toEqual([expect.objectContaining({ key: "env:CURSOR_API_KEY", accepted: true })]);
	});
});
