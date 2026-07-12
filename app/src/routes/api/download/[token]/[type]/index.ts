import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { APIEvent } from "@solidjs/start/server";
import {
  assertRateLimit,
  getJobByDownloadToken,
  recordDownloadCompleted,
  recordDownloadStarted
} from "@facereel/db";
import { errorJson, getClientIp, rateLimitResponse, shouldBypassRateLimit } from "../../../../../lib/server.ts";

export async function GET({ params, request }: APIEvent): Promise<Response> {
  const token = params.token;
  const outputType = String(params.type || "");
  const ip = getClientIp(request);

  if (!shouldBypassRateLimit()) {
    const limit = assertRateLimit({ scope: "download_ip", identity: ip, limit: 20, windowMs: 60 * 60_000 });
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);
  }

  const job = token ? getJobByDownloadToken(token) : null;
  if (!job || job.status !== "completed" || !job.video_path) return errorJson("Download is not ready.", 403);
  if (outputType !== "video") return errorJson("Unknown download type.", 404);
  if (!existsSync(job.video_path)) return errorJson("Video is not ready.", 404);

  const isPreload = new URL(request.url).searchParams.get("preload") === "1";
  const downloadId = isPreload ? null : recordDownloadStarted({ jobId: job.id, token: job.download_token, outputType, ip });
  const body = await readFile(job.video_path);
  if (downloadId) recordDownloadCompleted(downloadId);

  return new Response(body, {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Disposition": `inline; filename="facereel-${job.username}-video.mp4"`,
      "Cache-Control": "public, max-age=86400, immutable"
    }
  });
}
