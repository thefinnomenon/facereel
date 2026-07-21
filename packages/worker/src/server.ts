import "dotenv/config";
import { createServer } from "node:http";
import { OAuth2Client } from "google-auth-library";
import { disconnectPrisma } from "@facereel/db";
import { processRenderJob } from "./index.ts";
const port = Number(process.env.PORT || 8080);
let draining = false;
const auth = new OAuth2Client();
const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(draining ? 503 : 200).end(draining ? "draining" : "ok");
    return;
  }
  if (req.method !== "POST" || req.url !== "/internal/render-jobs/process") {
    res.writeHead(404).end();
    return;
  }
  try {
    if (draining)
      throw Object.assign(new Error("Worker is draining"), { status: 503 });
    await authenticate(req.headers);
    const body = await readJson(req);
    if (
      !body ||
      typeof body.jobId !== "string" ||
      !/^[-0-9a-z]{20,50}$/i.test(body.jobId)
    )
      throw Object.assign(new Error("Invalid jobId"), { status: 400 });
    console.log(JSON.stringify({ event: "worker_invoked", jobId: body.jobId }));
    const result = await processRenderJob(body.jobId);
    const retry = result === "RETRY";
    res
      .writeHead(retry ? 503 : 200, { "content-type": "application/json" })
      .end(JSON.stringify({ result }));
  } catch (error: any) {
    console.error(
      JSON.stringify({
        event: "worker_request_failed",
        message: error.message,
      }),
    );
    res.writeHead(error.status || 500).end();
  }
});
server.listen(port, () =>
  console.log(JSON.stringify({ event: "worker_listening", port })),
);
async function authenticate(
  headers: NodeJS.Dict<string | string[] | undefined>,
) {
  if (process.env.NODE_ENV !== "production") {
    if (
      headers["x-facereel-local-secret"] !==
      (process.env.LOCAL_WORKER_SECRET || "local-development-only")
    )
      throw Object.assign(new Error("Unauthorized"), { status: 401 });
    return;
  }
  if (!headers["x-cloudtasks-queuename"])
    throw Object.assign(new Error("Cloud Tasks header required"), {
      status: 401,
    });
  const token = String(headers.authorization || "").replace(/^Bearer /, "");
  if (!token)
    throw Object.assign(new Error("OIDC token required"), { status: 401 });
  const audience = process.env.CLOUD_RUN_WORKER_URL;
  if (!audience) throw Object.assign(new Error("Worker audience is not configured"), { status: 500 });
  await auth.verifyIdToken({ idToken: token, audience });
}
async function readJson(req: import("node:http").IncomingMessage) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10_000)
      throw Object.assign(new Error("Payload too large"), { status: 413 });
  }
  return JSON.parse(body);
}
async function shutdown() {
  if (draining) return;
  draining = true;
  server.close();
  setTimeout(() => process.exit(1), 25_000).unref();
  await disconnectPrisma();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
