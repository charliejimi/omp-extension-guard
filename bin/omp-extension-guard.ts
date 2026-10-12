// omp-extension-guard: inventory startup code, build and sign the approved-load list, and check it in
// CI. Run it through bin/omp-extension-guard, which starts Bun in an empty directory; the user's
// directory is restored here before omp's modules load, because some of them read the working
// directory when they are imported.
import * as fs from "node:fs";

const launchCwd = process.env.OMP_EXTENSION_GUARD_LAUNCH_CWD;
if (launchCwd) {
	process.chdir(launchCwd);
	delete process.env.OMP_EXTENSION_GUARD_LAUNCH_CWD;
} else if (fs.existsSync("bunfig.toml")) {
	process.stderr.write("omp-extension-guard: warning: started by Bun in a directory with a bunfig.toml; its preload ran inside this process. Use bin/omp-extension-guard.\n");
}
const { runCli } = await import("../src/cli");
process.exit(
	await runCli(process.argv.slice(2), {
		out: line => process.stdout.write(`${line}\n`),
		err: line => process.stderr.write(`${line}\n`),
	}),
);
