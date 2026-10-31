import { spawnSync } from "node:child_process";

/** jj is optional for contributors. Tests that need it are skipped when it is missing. */
export const hasJj: boolean = spawnSync("jj", ["--version"], { stdio: "ignore" }).status === 0;
