# omp-extension-guard

An [oh-my-pi](https://github.com/can1357/oh-my-pi) (omp) package that keeps unreviewed code from running inside omp's process. omp loads extensions, hooks, custom tools, and plugins from the directory it starts in, and runs them before the first model request, in its own process, with your permissions and environment. This package lists every such unit of code, lets a named reviewer approve each one in a signed list, starts omp with only the approved units, and guards the session so the agent cannot plant new startup code.

[中文說明](README.zh-TW.md)

> **Not tested with a real model.** The live tests run real omp 18.2.8 end to end with a scripted test model (the machine it was built on had no network). They show what loads, what runs, and what the guard blocks; they do not show how a real model behaves.

## Why

An extension is code, not text. Day 21 of the omp-versus-Cursor series measured it: an extension a cloned repository ships in `.omp/extensions/` runs when omp starts, before you type anything, reads credential environment variables, and writes files, and a guard extension loaded next to it sees none of it, because the guard and the extension share one process. omp's own README says the same: its flags "narrow inputs without changing the repository-trust model".

Reading omp 18.2.8's source shows more than the extension directory:

- Custom tools in `.omp/tools/`, `.claude/tools/`, and `.codex/tools/`, and the tools of installed plugins, load even with `--no-extensions --no-tools` ([#14878](https://github.com/can1357/oh-my-pi/issues/14878)).
- A repository can ship its own plugin root, `.omp/plugins/`, whose tools no flag and no user setting turns off.
- Bun runs the `bunfig.toml` preload and loads the `.env` of the directory it starts in, before omp's own code, when omp is installed from npm.

Flags decide what loads; they cannot contain what loaded. So this package moves the decision out of the process: what may load is approved before omp starts, real credentials are kept out of the process, and the in-process guard only checks what it can see.

## How it fits together

1. **Review, before omp runs.** `omp-extension-guard inventory` lists every unit omp would load and who wrote it. A reviewer approves units in an approvals file with source, version or commit, and their name; `allowlist` pins each to a digest of its file or directory, and `sign` signs the list with a key the agent never sees. In CI, `check` fails a pull request that adds, changes, moves, or renames startup code without approval.
2. **Credentials, before omp starts.** `omp-ext-safe` gives omp an empty environment plus an allowlist, then looks for real credentials omp could still reach: variables, omp's arguments, credential files, and omp's own credential store. In `require` mode it refuses to start if any remain.
3. **Launch.** `omp-ext-safe` starts omp with only the approved units, and keeps everything else out: through `--trusted-extension` (default), `--no-extensions` and `-e`, or auto-discovery with every unapproved unit switched off in a settings overlay. Unapproved custom tools are switched off by id, which no flag does. It refuses when unapproved code has no switch at all. It starts omp from an empty directory so the project's `bunfig.toml` and `.env` are not loaded, and checks the result with omp's own discovery before starting.
4. **While omp runs.** The guard blocks the agent from writing to places omp or Bun load code from, runs an extension's scripts only when the approval lists them, and locks the session if code that was not approved registered tools.
5. **After.** `omp-ext-safe` prints the guard's decisions from a content-free audit log. Destroying the sandbox and revoking keys are steps for your sandbox and key setup; see [Running it in a sandbox](#running-it-in-a-sandbox).

## What omp 18.2.8 runs at startup

| Unit | Example | What keeps it out |
|---|---|---|
| Extension modules | `.omp/extensions/x/`, `~/.omp/agent/extensions/x.ts`, `.omp/settings.json#extensions` | `--trusted-extension`, `--no-extensions`, or `disabledExtensions: [extension-module:<name>]` |
| Hook factories | `.omp/hooks/pre/x.ts`, `.claude/hooks/pre/x.ts`, `~/.omp/agent/hooks/` | the same flags, or `hook:<type>:<tool>:<file>` |
| `extensions:` setting | `extensions: [./vendor/x]` in the repository's `.omp/config.yml` | the flags, or an overlay that replaces `extensions:` |
| Plugin extensions | `~/.omp/plugins/node_modules/x`, the repository's `.omp/plugins/node_modules/x` | the flags, or `extension-module:<name>` |
| Custom tools | `.omp/tools/x.ts`, `.claude/tools/`, `.codex/tools/`, `~/.omp/agent/tools/` | no flag; only `disabledExtensions: [tool:<name>]` |
| Plugin tools | a plugin's `omp.tools` entry, user or repository plugin root | nothing but removing the plugin |
| TypeScript slash commands | `.omp/commands/x/index.ts` | `--trusted-extension` or `--no-extensions` |
| Bun preload and `.env` | `bunfig.toml` `preload`, `.env` in the start directory | starting omp from another directory (omp's compiled binary does not load them) |

`omp-extension-guard inventory` prints this for a real project, using omp's own discovery functions, without running any of it.

## What it does

| Part | Where | What it does | If it fails |
|---|---|---|---|
| `omp-extension-guard` | reviewer, CI | `inventory` lists each unit with its key (`project:`, `user:`, `home:`, `abs:` plus a path), kind, digest, and the switch that keeps it out. `keygen`, `allowlist`, `sign`, and `verify` produce the signed list; `allowlist` refuses an approval without a source, version or commit, or reviewer, a unit omp does not load, a kind other than where omp loads it, a unit that cannot be hashed, and a script list that differs from the unit's scripts. `check` exits 1 for each new, changed, moved, or revoked unit. | Exits non-zero; nothing is written. |
| `omp-ext-safe` | developer machine, before omp | Verifies the allowlists against your public keys; inventories with omp's own discovery; checks credential exposure; builds the run's flags and overlay for the chosen mode; refuses on code nothing can keep out, on ids shared with an approved unit (also when an unapproved unit shadows an approved one of the same name), and in `require` mode on credentials; verifies the plan with omp's discovery; asks before starting without unapproved units (refuses without a terminal unless `--on-unapproved exclude`); starts omp from an empty directory with the guard last; reports afterwards. | Refuses to start (exit 3). Under `--trusted-extension`, omp itself stops if an approved extension or the guard fails to load. |
| Guard: startup check | `session_start` | Every tool whose source file is not inside an approved, unchanged unit locks the session: every tool call is blocked and the user is told which tools and files. Without any approval configured, built-in tools work and other tools are blocked. | The error is logged; the next check is `tool_call`. |
| Guard: write protection | `tool_call` | Blocks `write`, `edit` (also renames and the files named in a combined patch), and `ast_edit` into `.omp/`, `.pi/`, `.claude/`, `.codex/`, `.mcp.json`, `bunfig.toml`, `.env*`, `~/.omp/` and omp's agent directory, `~/.claude/`, `~/.codex/`, `~/.pi/`, `~/.bunfig.toml`, and the package's own config, state, allowlists, keys, and files, resolving symlinks. `bash` commands that name these places pass only when every part is read-only; `cd` into them, redirects, variables carrying them, recursive deletes from above them, and `omp plugin install` are blocked. `eval` code that names them is blocked. | omp blocks the call. |
| Guard: scripts | `tool_call` | A `bash` command may run a script inside an approved unit only if the approval lists it and both the script and its unit still hash to the approved digests. | omp blocks the call. |
| Audit log | every decision | One JSON line per decision: time, run, event, tool, action, rule, unit key. No file content, no credentials. | A write error is logged once. |

## Requirements

- [Bun](https://bun.sh) 1.3.14 or newer, and a POSIX shell for the two bin wrappers.
- omp 18.2.8. The package uses omp's own discovery code; other versions may load from places it does not know.
- Install the package next to omp: clone it and run `bun install`. Loading omp's code adds a few seconds before omp starts.

## Setup

### Once: the signing key

```bash
omp-extension-guard keygen ./keys
```

Store `extension-guard.key.pem` as a CI secret and nowhere else. Give `extension-guard.pub.pem` to everyone who runs `omp-ext-safe`. For your own extensions you can make a personal key pair and a personal list; `omp-ext-safe` accepts several lists and keys.

### When startup code is added or changes

List what omp would load, and copy the keys of the units you reviewed:

```bash
omp-extension-guard inventory
```

Record each approval (see [`examples/approvals.example.json`](examples/approvals.example.json)):

```json
{
	"items": {
		"project:.omp/extensions/dx-helper": {
			"kind": "extension",
			"source": "https://github.com/example/dx-helper",
			"commit": "0123456789abcdef0123456789abcdef01234567",
			"reviewer": "platform-team",
			"scripts": ["scripts/setup.sh"]
		}
	},
	"revoked": ["project:.omp/tools/old-helper.ts"]
}
```

Then, in the job that runs after the review:

```bash
omp-extension-guard allowlist --approvals approvals.json --out extensions.allow.json --expires-in-days 30
omp-extension-guard sign --key "$EXTENSION_GUARD_KEY_FILE" extensions.allow.json
```

Publish `extensions.allow.json` and `extensions.allow.json.sig` where the repository cannot change them, such as a CI artifact. A list kept in the repository is input the repository controls, so `omp-ext-safe` trusts only the signature.

### In CI, on every pull request

```bash
omp-extension-guard check --allowlist extensions.allow.json --public-key extension-guard.pub.pem
```

It exits 1 and names each unit that is new, changed, moved, renamed, or revoked; `--scope all` also checks user-level units. [`examples/github-check.yml`](examples/github-check.yml) is a workflow step. Run it through `bin/omp-extension-guard`, not `bun …/omp-extension-guard.ts`: the wrapper starts Bun in an empty directory, so the repository under review cannot run its `bunfig.toml` preload inside the checker.

### On each developer machine

Write `~/.config/omp-extension-guard/config.json` (see [`examples/config.example.json`](examples/config.example.json)):

```json
{
	"allowlists": ["~/.cache/omp-extension-guard/extensions.allow.json"],
	"publicKeys": ["~/.config/omp-extension-guard/extension-guard.pub.pem"],
	"mode": "trusted",
	"isolation": "warn",
	"passEnv": [],
	"onUnapproved": "ask",
	"auditLog": "~/.local/state/omp-extension-guard/audit.jsonl",
	"omp": ["omp"]
}
```

Then start omp through the launcher, with omp's own arguments after `--`:

```bash
omp-ext-safe -- --model <your model>
```

`omp-ext-safe --plan -- …` prints what would load, what is kept out, and why, without starting omp (exit 0 if it would start, 3 if not). `omp-ext-safe --help` lists the flags; each config field has one. Exit codes: omp's own, 2 for a usage error, 3 when it refuses to start.

The trust anchor (lists and keys) comes only from this file or flags, never from environment variables: Bun loads a project's `.env` into processes started in that project.

### Modes

- `trusted` (default): `--trusted-extension` for each approved extension entry and the guard. omp turns off all auto-discovery and stops if any of them fails to load. It cannot be combined with `-e`, so the launcher turns your `-e` arguments into approved entries or leaves them out.
- `explicit`: `--no-extensions` and `-e`. The same set, but a failing extension does not stop omp.
- `discovery`: auto-discovery stays on; the overlay replaces `extensions:` with the approved entries and lists every unapproved unit in `disabledExtensions`. It refuses when an unapproved unit has no id (a TypeScript command) or shares an id with an approved one.

In every mode, unapproved custom tools are switched off by `tool:<name>`, and unapproved plugin tools make the launcher refuse. Approved TypeScript commands do not load in `trusted` or `explicit` mode.

### Credentials and isolation

omp gets the variables in `DEFAULT_PASS_ENV` (`PATH`, `HOME`, locale, terminal, temp, XDG, `PI_CODING_AGENT_DIR`) plus `passEnv`. `isolation` then decides what happens to real credentials still within reach: variables named or shaped like a key, credentials in omp's arguments, files such as `~/.git-credentials`, `~/.config/gh/hosts.yml`, `~/.aws/credentials`, and SSH keys, and providers with a stored credential in omp's `agent.db`.

- `warn` (default) prints them; `require` refuses to start; `off` skips the check.
- A value equal to `placeholder` (`proxy-managed` by default) is what a credential proxy leaves in place of a key, and passes.
- `accept` lists exposures you keep on purpose, by key: `env:CURSOR_API_KEY`, `file:~/.netrc`, `store:anthropic`.

Findings name a location, never a value. Without a credential proxy, a provider key omp needs is always within reach of the code omp loads; `require` makes that visible instead of hiding it.

### Running it in a sandbox

The real boundary is outside the process: a container or microVM with only the project mounted, omp state per project, no host `~/.omp` or `~/.config/gh`, outbound traffic through an allowlist proxy, and keys held by a proxy that injects them. Community wrappers such as [omp-sbx](https://github.com/mikeatlas/omp-sbx), [omp-sandbox](https://github.com/nmarcetic/omp-sandbox), and [omp-guard](https://github.com/bnivanov/omp-guard) do this; this package was not tested with them. Inside the sandbox, run `omp-ext-safe --isolation require`, mount the allowlists and keys read-only, and afterwards destroy the sandbox and revoke or let expire the keys it used.

### Without omp-ext-safe

Loading the guard directly (`omp -e <this package>`, with the config file above) checks tools against the allowlists and blocks writes to startup locations, but everything omp auto-discovers still loads and runs first.

## Tests

```bash
bun run test
```

`bun run test` starts Bun with a temporary `HOME` and `TMPDIR`; plain `bun test` refuses to run, because the suite writes and deletes user-level fixtures and Bun fixes the home directory when it starts. The suite runs through omp's own discovery, loader, runner, and settings, with no network.

The live tests run real omp with a scripted test-only model provider (`test/scripted-provider.ts`):

```bash
EXTENSION_GUARD_LIVE=1 OMP_CLI=/path/to/oh-my-pi/packages/coding-agent/src/cli.ts \
EXTENSION_GUARD_LIVE_OUT=/tmp/extension-guard-evidence bun run test test/live.test.ts
```

`OMP_BIN=/path/to/omp` runs an installed omp instead. They cover plain omp (the repository's extension, tool, preload, and `.env` all run, and the extension sees the credential), `--no-extensions --no-tools` (`.omp/tools` and the preload still run), `omp-ext-safe` in all three modes (only the approved extension runs, without the credential or `.env`), its refusals (an unapproved plugin tool, a credential in `require` mode), omp stopping when a trusted extension fails to load, the guard blocking planted code, the guard's lockdown without the launcher, and the CI check with and without its wrapper.

## To do before a public release

- **Threat model.** Not run. A STRIDE, OWASP LLM Top 10, and OWASP Agentic walkthrough of the allowlist, launcher, and guard is still open.
- **Security audit.** Not run. The launcher and guard have had no independent adversarial review.
- **Real-model runs.** Not run; no network on the build machine.
- **First CI run.** The GitHub Actions workflow has not run yet; `bun.lock` was produced offline from Bun's cache.
- **Validation sandbox.** Running an unreviewed extension once in a sandbox without network, with fake credentials, to see what it reads and writes, is a manual step; it is not automated here.
- **Newer omp versions.** Only 18.2.8 was tested.

## Limits

- **Approved code still runs in omp's process.** Approval decides what loads; an approved extension can do anything omp can, including at load time. Only a sandbox and a credential proxy limit that.
- **The guard sees results, not actions.** It notices tools that unapproved code registered; code that registers nothing, or that changes the guard itself, is not seen. Without `omp-ext-safe`, auto-discovered code runs before the guard.
- **Digests cover the unit.** A file unit is pinned to its file and a directory unit to everything in it; a symlink that leaves the unit makes it unapprovable. Imports from outside the unit, such as hoisted plugin dependencies, are not covered; pin them with your lockfile.
- **`bash` and `eval` are read statically.** A command that reaches startup files without naming them (`find . -exec`, a path built at run time, another script) is not seen. Leave `bash` and `eval` out of `--tools` when you can.
- **Allowlists can be replayed** unless they expire; use `--expires-in-days`.
- **Between the check and the start** a file can change; omp loads what is on disk then, and the guard's startup check sees only tools.
- **Not covered:** MCP servers (they run as separate processes; see Day 27), skill content (Day 20), shell startup files and other persistence outside omp's directories, omp profiles (`--profile`), and Windows.
- **The audit log is local** and not tamper-evident.

## Background

This package implements the integrated sequence written for Day 21 of an omp-versus-Cursor hardening series, "an extension is code in omp's own process". That sequence put five sources on one timeline: the article's switches, upstream omp's documentation and issues, community sandbox wrappers, a workflow playbook's isolation and short-lived credentials, and a security-audit method's trust-expansion review. This package automates the parts that can run on one machine: the inventory and approval, the launch decision, the credential check, the in-process guard, and the CI gate. The sandbox, the proxy, and key revocation stay outside it.

## License

[MIT](LICENSE)
