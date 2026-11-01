import { accessSync, constants, realpathSync, statSync } from "node:fs";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** A best-effort accidental-write guard, not a security boundary. */
export function isolatedCommand(command: string, cwd: string, platform = process.platform): { executable: string; args: string[] } {
  if (platform !== "darwin") throw new Error("process isolation is unavailable on this platform");
  try {
    accessSync(SANDBOX_EXEC, constants.X_OK);
  } catch (err) {
    throw new Error(`process isolation requires executable ${SANDBOX_EXEC}: ${(err as Error).message}`);
  }
  const directory = realpathSync(cwd);
  if (!statSync(directory).isDirectory()) throw new Error("isolated job cwd must be a directory");
  if (/[\x00-\x1f\x7f]/.test(directory)) throw new Error("isolated job cwd contains unsupported control characters");
  const escaped = directory.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const profile = `(version 1) (allow default) (deny file-write* (require-not (subpath "${escaped}")))`;
  return { executable: SANDBOX_EXEC, args: ["-p", profile, "/bin/sh", "-c", command] };
}
