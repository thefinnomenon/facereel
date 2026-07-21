import assert from "node:assert/strict";
import test from "node:test";
import { insufficientMatchesError } from "../packages/worker/src/facereel.ts";
import { classifyRenderError } from "../packages/worker/src/index.ts";

test("zero face matches are a terminal user-facing failure", () => {
  const error = insufficientMatchesError(0, 4);
  const classified = classifyRenderError(error);

  assert.equal(classified.code, "INSUFFICIENT_MATCHES");
  assert.equal(classified.message, "No matching photos found. Upload a clear photo of someone who appears in this Instagram account.");
  assert.equal(classified.retryable, false);
});

test("too few face matches report the observed count without retrying", () => {
  const error = insufficientMatchesError(2, 4);
  const classified = classifyRenderError(error);

  assert.equal(classified.code, "INSUFFICIENT_MATCHES");
  assert.match(classified.message, /found 2, but needs at least 4/);
  assert.equal(classified.retryable, false);
});
