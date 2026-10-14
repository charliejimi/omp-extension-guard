# Changelog

## [0.1.1] - 2026-10-14

### Fixed

- Write protection resolves `write`, `edit`, and `ast_edit` targets the way omp's tools do: a hashline header (`[path]`, `[path#TAG]`) is unwrapped, a stray leading `:` or `@` is dropped, and `~name` is read as home-relative. `[.omp/extensions/x.ts]`, `:./bunfig.toml`, `@<agent dir>/extensions/x.ts`, and `~.config/omp-extension-guard/config.json` are now blocked like the plain paths.
- Hashline `edit`: every file header of a multi-file patch and every `MV` destination is checked.
- A `bash` call's `cwd` is resolved the way omp resolves it (`~`, a leading `@` or `:`), so a command run from `~/.omp/agent/extensions` is judged there.

## [0.1.0] - 2026-10-12

### Added

- Inventory of the code omp 18.2.8 runs at startup, found with omp's own discovery functions and never executed: extension modules, hook factories (including `.claude/hooks`), the `extensions:` setting, installed and repository plugins, custom tools (including `.claude/tools` and `.codex/tools`), TypeScript slash commands, and Bun's `bunfig.toml` preload and `.env`. Each unit has a machine-independent key, a kind, a digest of its file or directory, and the switches that keep it out.
- Signed allowlist: each approved unit's kind, key, digest, script digests, source, version or commit, and named reviewer, plus revoked keys; a detached Ed25519 signature; optional expiry; several lists and keys at once.
- `omp-extension-guard` CLI: `inventory` (with the trust expansion by author), `keygen`, `allowlist`, `sign`, `verify`, and `check` for CI, which names each new, changed, moved, renamed, or revoked unit.
- `omp-ext-safe` launcher: an empty environment plus an allowlist for omp; a credential-exposure check (variables, omp's arguments, credential files, omp's credential store) with `warn`, `require`, and `off`; three load modes (`--trusted-extension`, `--no-extensions` with `-e`, and discovery with an overlay); unapproved custom tools switched off by `tool:<name>`; refusals for code no switch stops, for ids shared with or shadowing an approved unit, and for credentials in `require` mode; verification of the plan with omp's discovery; omp started from an empty directory with the guard last; a report of the guard's decisions and handler alerts.
- Guard extension: a startup check that locks the session when unapproved code registered tools; write protection for every place omp or Bun loads code or settings from, across `write`, `edit`, `ast_edit`, `bash`, and `eval`; scripts of approved units only when listed and unchanged; a content-free JSONL audit log.
- Bin wrappers that start Bun in an empty directory, so a project's `bunfig.toml` preload and `.env` cannot run inside the launcher or the CI checker.
- Tests through omp's own discovery, loader, runner, and settings, run with a temporary HOME by `bun run test`; opt-in live tests on real omp with a scripted test model.

### Not yet done

- Threat model (STRIDE, OWASP LLM Top 10, OWASP Agentic): not run.
- Independent security audit: not run.
- Live runs with a real model: not run.
- First run of the GitHub Actions workflow; `bun.lock` was produced offline.
- A validation sandbox for running an unreviewed extension once with fake credentials.
- Tests against omp versions newer than 18.2.8.
