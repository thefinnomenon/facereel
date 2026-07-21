import assert from "node:assert/strict";
import test from "node:test";
import { buildEmailContent } from "../packages/worker/src/email.ts";

test("processing email says the status page can be closed", () => {
  const content = buildEmailContent({
    kind: "PROCESSING",
    username: "facereel",
    statusUrl: "https://facereel.net/status/job",
  });

  assert.match(content.text, /don't need to stay on the status page/i);
  assert.match(content.text, /email you when your FaceReel is ready/i);
  assert.match(content.html, /don't need to stay on the status page/i);
});

test("failure email includes the user-facing reason", () => {
  const content = buildEmailContent({
    kind: "FAILURE",
    username: "facereel",
    statusUrl: "https://facereel.net/status/job",
    errorMessage: "No matching photos found.",
  });

  assert.match(content.text, /No matching photos found/);
  assert.match(content.html, /No matching photos found/);
});
