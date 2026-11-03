import { Type } from "typebox";
import { assessCoverage, MAX_CLAIM_LENGTH, MAX_COVERAGE_ENTRIES, MAX_SOURCE_LENGTH } from "../lib/coverage.ts";
import { tool, type ToolDef } from "./types.ts";

const rangeFields = {
  source: Type.String({ minLength: 1, maxLength: MAX_SOURCE_LENGTH }),
  start: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  end: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
};

export function coverageTools(): ToolDef[] {
  return [
    tool({
      name: "assess_coverage",
      label: "Assess coverage",
      description:
        "Compare assigned inclusive line ranges with reported read ranges. Returns missing ranges, partial and failed reports, evidence, and unknown sources. " +
        "All inputs are untrusted claims: this does not read sources, verify reports or establish correctness. Limits apply to input and output size.",
      parameters: Type.Object({
        assigned: Type.Array(Type.Object(rangeFields), { maxItems: MAX_COVERAGE_ENTRIES }),
        coverage: Type.Array(
          Type.Object({ ...rangeFields, status: Type.Union([Type.Literal("read"), Type.Literal("partial"), Type.Literal("failed")]) }),
          { maxItems: MAX_COVERAGE_ENTRIES },
        ),
        evidence: Type.Optional(
          Type.Array(Type.Object({ ...rangeFields, claim: Type.String({ minLength: 1, maxLength: MAX_CLAIM_LENGTH }) }), {
            maxItems: MAX_COVERAGE_ENTRIES,
          }),
        ),
      }),
      async execute(_id, params) {
        const result = assessCoverage(params);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    }),
  ];
}
