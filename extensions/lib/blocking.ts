export interface BashVerdict {
  blocked: boolean;
  /** Short name of what matched, for the message. */
  what?: string;
  /** What to do instead. */
  advice?: string;
}

interface Segment {
  text: string;
  backgrounded: boolean;
}

/** Replace the inside of quotes so operators and keywords in strings are not scanned. */
function blankQuoted(cmd: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === "\\" && quote === '"') {
        out += "  ";
        i++;
      } else if (c === quote) {
        quote = null;
        out += c;
      } else {
        out += "_";
      }
    } else if (c === "'" || c === '"') {
      quote = c;
      out += c;
    } else {
      out += c;
    }
  }
  return out;
}

export function splitSegments(cmd: string): Segment[] {
  const text = blankQuoted(cmd);
  const segments: Segment[] = [];
  let cur = "";
  const push = (backgrounded: boolean) => {
    if (cur.trim() !== "") segments.push({ text: cur.trim(), backgrounded });
    cur = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "&" && next === "&") {
      push(false);
      i++;
    } else if (c === "|" && next === "|") {
      push(false);
      i++;
    } else if (c === "&") {
      const redirect = text[i - 1] === ">" || next === ">";
      if (redirect) cur += c;
      else push(true);
    } else if (c === ";" || c === "\n" || c === "|") {
      push(false);
    } else {
      cur += c;
    }
  }
  push(false);
  return segments;
}

const WRAPPERS = /^(nohup|setsid|timeout|disown)\b/;

function stripPrefix(segment: string): string {
  let s = segment;
  // leading VAR=value assignments, then do/then/else openers
  for (;;) {
    const m = s.match(/^([A-Za-z_][A-Za-z0-9_]*=\S*|do|then|else|\{|\()\s+/);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  return s.replace(/^[({]+/, "").trim();
}

function parseDurationSeconds(args: string[]): number | null {
  const unit: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };
  let total = 0;
  for (const a of args) {
    const m = a.match(/^(\d+(?:\.\d+)?)([smhd]?)$/);
    if (!m) return null;
    total += Number(m[1]) * unit[m[2]];
  }
  return total;
}

const DEV_SERVERS: Array<[RegExp, string]> = [
  [/^(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|watch)\b/, "a dev server or watcher"],
  [/^(npx\s+)?vite(\s+(dev|serve|preview))?(\s+--\S+)*\s*$/, "a vite dev server"],
  [/^(npx\s+)?next\s+(dev|start)\b/, "a next dev server"],
  [/^(npx\s+)?(nodemon|webpack\s+serve|webpack-dev-server|ng\s+serve)\b/, "a watcher or dev server"],
  [/^python3?\s+-m\s+http\.server\b/, "a static file server"],
  [/^php\s+-S\b/, "a PHP built-in server"],
  [/^(rails|bin\/rails)\s+s(erver)?\b/, "a rails server"],
  [/^(flask\s+run|uvicorn|gunicorn)\b/, "a web server"],
  [/^cargo\s+watch\b/, "cargo watch"],
  [/^watch\s/, "watch"],
];

/**
 * R-B2, R-B3. Decide whether a bash command would hold the turn open for a long time.
 * Conservative on purpose: a miss costs a slow turn, a false positive costs a retry.
 */
export function classifyBash(command: string, sleepLimitSec: number): BashVerdict {
  for (const seg of splitSegments(command)) {
    if (seg.backgrounded) continue;
    const text = stripPrefix(seg.text);
    if (WRAPPERS.test(text)) continue;
    const words = text.split(/\s+/);
    const head = words[0];

    if (head === "sleep" && words.length > 1) {
      const secs = parseDurationSeconds(words.slice(1));
      if (secs !== null && secs >= sleepLimitSec) {
        return {
          blocked: true,
          what: `sleep ${words.slice(1).join(" ")} (${secs}s)`,
          advice: "Use the sleep tool to wait on a timer, or bg_run for the work you are waiting on, then end your turn.",
        };
      }
      continue;
    }
    if (head === "tail" && words.slice(1).some((w) => /^-[a-zA-Z0-9]*[fF][a-zA-Z0-9]*$/.test(w) || /^--follow(=\w+)?$/.test(w))) {
      return { blocked: true, what: "tail -f", advice: "Run it with bg_run and a watch pattern, or read the log later with bg_output." };
    }
    if (/^while\s+(true|:|\[\s*1\s*\])/.test(text) || /^until\s+false\b/.test(text)) {
      return { blocked: true, what: "an endless loop", advice: "Start it with bg_run (with timeout_seconds) instead of holding the turn." };
    }
    if (/^docker(\s+|-)compose\s+up\b/.test(text) && !/(\s-d\b|--detach)/.test(text)) {
      return { blocked: true, what: "docker compose up in the foreground", advice: "Use bg_run, or add -d." };
    }
    for (const [re, label] of DEV_SERVERS) {
      if (re.test(text)) {
        return { blocked: true, what: label, advice: "Start it with bg_run and a watch pattern for its ready line, then end your turn." };
      }
    }
  }
  return { blocked: false };
}

export function blockMessage(verdict: BashVerdict, command: string, mode: "block" | "warn"): string {
  const shown = command.length > 120 ? `${command.slice(0, 120)}...` : command;
  const lead =
    mode === "block"
      ? `pi-infinity bash guard blocked this command because it would hold the turn open (${verdict.what}): ${shown}`
      : `pi-infinity bash guard notice: this command holds the turn open (${verdict.what}): ${shown}`;
  return `${lead}\n${verdict.advice}\nTo allow such commands set bash.guard to "warn" or "off" in infinity.json.`;
}
