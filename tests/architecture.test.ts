import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { hashOwnerToken } from "../packages/db/src/index.ts";
import { normalizeEmail, sanitizeInstagramUsername } from "../packages/worker/src/validation.ts";

test("ownership tokens are compared by a stable one-way hash", () => {
  assert.equal(hashOwnerToken("owner-token"), hashOwnerToken("owner-token"));
  assert.notEqual(hashOwnerToken("owner-token"), hashOwnerToken("other-token"));
});

test("submission validators reject unsafe identity input", () => {
  assert.equal(sanitizeInstagramUsername("@face.reel"), "face.reel");
  assert.throws(() => sanitizeInstagramUsername("../escape"));
  assert.equal(normalizeEmail(" USER@Example.com "), "user@example.com");
  assert.throws(() => normalizeEmail("not-an-email"));
});

test("PostgreSQL schema contains durable job, outbox, asset, and email state", async () => {
  const schema = await readFile(new URL("../packages/db/prisma/schema.prisma", import.meta.url), "utf8");
  for (const model of ["FaceReelProject", "SourceImage", "RenderJob", "RenderedAsset", "RenderDispatch", "EmailDelivery"]) assert.match(schema, new RegExp(`model ${model}\\b`));
  assert.match(schema, /provider = "postgresql"/);
  assert.doesNotMatch(schema, /provider = "sqlite"/);
});

test("worker HTTP boundary accepts only a job ID and production verifies OIDC", async () => {
  const server = await readFile(new URL("../packages/worker/src/server.ts", import.meta.url), "utf8");
  assert.match(server, /body\.jobId/);
  assert.match(server, /verifyIdToken/);
  assert.match(server, /x-cloudtasks-queuename/);
  assert.doesNotMatch(server, /renderConfig/);
});

test("render outputs use deterministic project and job scoped R2 keys", async () => {
  const worker = await readFile(new URL("../packages/worker/src/index.ts", import.meta.url), "utf8");
  assert.match(worker, /projects\/\$\{job\.projectId\}\/renders\/\$\{jobId\}\/outputs\/master\.mp4/);
  assert.match(worker, /createMany\([\s\S]*skipDuplicates: true/);
});
