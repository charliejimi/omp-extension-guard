// omp-ext-safe: start omp with only the approved extensions, the guard loaded last, and the project's
// bunfig.toml and .env left out. Run it through bin/omp-ext-safe, which starts Bun in an empty
// directory; the user's directory is restored here before omp's modules load, because some of them
// read the working directory when they are imported.
import * as fs from "node:fs";

const launchCwd = process.env.OMP_EXTENSION_GUARD_LAUNCH_CWD;
if (launchCwd) {
	process.chdir(launchCwd);
	delete process.env.OMP_EXTENSION_GUARD_LAUNCH_CWD;
} else if (fs.existsSync("bunfig.toml")) {
	process.stderr.write("omp-ext-safe: warning: started by Bun in a directory with a bunfig.toml; its preload ran inside the launcher. Use bin/omp-ext-safe.\n");
}
const { runOmpExtSafe, terminalIO } = await import("../src/launcher");
process.exit(await runOmpExtSafe(process.argv.slice(2), terminalIO()));
