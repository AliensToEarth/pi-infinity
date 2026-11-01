import { spillIfLarge } from "./events.ts";

export interface TextPart {
  type: "text";
  text: string;
}
export interface OtherPart {
  type: string;
  [key: string]: unknown;
}
export type Part = TextPart | OtherPart;

function isText(p: Part): p is TextPart {
  return p.type === "text" && typeof (p as TextPart).text === "string";
}

/**
 * R-O1 to R-O3. Returns replacement content when the summed text is over the limit,
 * otherwise undefined (leave the result alone).
 */
export function guardContent(
  content: Part[],
  spillDir: string,
  limits: { maxChars: number; headChars: number; tailChars: number },
  onError: (err: unknown) => void,
): Part[] | undefined {
  const texts = content.filter(isText);
  const total = texts.reduce((n, p) => n + p.text.length, 0);
  if (total <= limits.maxChars) return undefined;
  const joined = texts.map((p) => p.text).join("\n");
  const spilled = spillIfLarge(joined, spillDir, limits, onError);
  const others = content.filter((p) => !isText(p));
  return [{ type: "text", text: spilled.text }, ...others];
}
