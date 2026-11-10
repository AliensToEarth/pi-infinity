import assert from "node:assert/strict";
import { test } from "node:test";
import { scopedModel } from "../extensions/lib/threads/scoped-model.ts";

const scoped = [{ model: { provider: "one", id: "m" } }, { model: { provider: "two", id: "n" } }];

test("R-H13 scoped selection prefers current, otherwise first; unrestricted preserves overrides", () => {
  assert.equal(scopedModel(undefined, scoped[1].model, scoped), "two/n");
  assert.equal(scopedModel(undefined, { provider: "other", id: "z" }, scoped), "one/m");
  assert.equal(scopedModel("outside", undefined, []), "outside");
  assert.equal(scopedModel(undefined, undefined, []), undefined);
});

test("R-H13 exact scoped overrides are canonicalized and ambiguous or outside models rejected", () => {
  assert.equal(scopedModel("n", undefined, scoped), "two/n");
  assert.equal(scopedModel("one/m", undefined, scoped), "one/m");
  assert.equal(scopedModel("one/m", undefined, [...scoped, scoped[0]]), "one/m");
  assert.throws(() => scopedModel("other/z", undefined, scoped), /scoped model/);
  assert.throws(() => scopedModel("m", undefined, [...scoped, { model: { provider: "two", id: "m" } }]), /unambiguous/);
});
