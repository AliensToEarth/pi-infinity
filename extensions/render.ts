import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { EVENT_TYPE, type EventDetails } from "./lib/events.ts";

/** R-E4. One line collapsed, full body expanded. */
export function registerEventRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<EventDetails>(EVENT_TYPE, (message, options, theme) => {
    const d = message.details;
    const text =
      typeof message.content === "string" ? message.content : message.content.map((p) => (p.type === "text" ? p.text : "")).join("\n");
    const lines = text.split("\n");
    const head = d ? `${d.kind} from ${d.source.tool}` : "event";
    const color = d?.kind === "job_exit" && /\((?:exit code [1-9]|killed|failed)/.test(text) ? "error" : "accent";
    let out = theme.fg(color, `[infinity] ${head}`);
    if (options.expanded) {
      out += `\n${lines.slice(3).join("\n")}`;
    } else {
      const first = lines.slice(3).find((l) => l.trim() !== "") ?? "";
      out += theme.fg("dim", `  ${first.length > 100 ? `${first.slice(0, 100)}...` : first}`);
    }
    const box = new Box(options.outputPad, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(out, 0, 0));
    return box;
  });
}
