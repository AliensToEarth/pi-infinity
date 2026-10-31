import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

// Tools are declared as plain objects. `tool` keeps parameter inference per tool and
// erases it afterwards so the tool lists stay homogeneous.
export type ToolDef = ToolDefinition<any, any, any>;

export function tool<T extends TSchema>(definition: ToolDefinition<T, any, any>): ToolDef {
  return definition as unknown as ToolDef;
}
