import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** A best-effort accidental-write guard, not a security boundary. */
export function isolatedCommand(command: string, cwd: string, platform = process.platform): { executable: string; args: string[] } {
  if (platform !== "darwin" && platform !== "linux") throw new Error("process isolation is unavailable on this platform");
  let executable = SANDBOX_EXEC;
  if (platform === "linux") {
    const candidates = (process.env.PATH ?? "").split(delimiter).map((dir) => resolve(dir || ".", "bwrap"));
    const found = candidates.find((candidate) => {
      try {
        accessSync(candidate, constants.X_OK);
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
    if (!found) throw new Error("process isolation requires executable bwrap in PATH");
    executable = found;
  } else {
    try {
      accessSync(executable, constants.X_OK);
    } catch (err) {
      throw new Error(`process isolation requires executable ${executable}: ${(err as Error).message}`);
    }
  }
  const directory = realpathSync(cwd);
  if (!statSync(directory).isDirectory()) throw new Error("isolated job cwd must be a directory");
  if (/[\x00-\x1f\x7f]/.test(directory)) throw new Error("isolated job cwd contains unsupported control characters");
  if (platform === "linux") {
    return {
      executable,
      args: ["--ro-bind", "/", "/", "--bind", directory, directory, "--chdir", directory, "--", "/bin/sh", "-c", command],
    };
  }
  const escaped = directory.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const profile = `(version 1) (allow default) (deny file-write* (require-not (subpath "${escaped}")))`;
  return { executable: SANDBOX_EXEC, args: ["-p", profile, "/bin/sh", "-c", command] };
}
