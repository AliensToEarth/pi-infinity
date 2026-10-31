import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Logger {
  error(scope: string, err: unknown): void;
  debug(scope: string, message: string): void;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

/**
 * Append-only logger. Never throws. If the log file itself cannot be written the
 * line goes to stderr, so a failure is never silent.
 */
export function createLogger(file: string | null, now: () => Date = () => new Date()): Logger {
  const write = (level: string, scope: string, text: string): void => {
    const line = `${now().toISOString()} ${level} [${scope}] ${text}\n`;
    if (file === null) {
      process.stderr.write(line);
      return;
    }
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, line);
    } catch (writeErr) {
      process.stderr.write(`pi-infinity: cannot write ${file}: ${describe(writeErr)}\n${line}`);
    }
  };
  return {
    error: (scope, err) => write("ERROR", scope, describe(err)),
    debug: (scope, message) => write("DEBUG", scope, message),
  };
}

/** Logger for tests: collects lines in memory. */
export function memoryLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    error: (scope, err) => void lines.push(`ERROR [${scope}] ${describe(err)}`),
    debug: (scope, message) => void lines.push(`DEBUG [${scope}] ${message}`),
  };
}
