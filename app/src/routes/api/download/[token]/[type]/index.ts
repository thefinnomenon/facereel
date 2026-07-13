import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
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
  const fileStat = await stat(job.video_path);
  const range = parseByteRange(request.headers.get("range"), fileStat.size);
  if (range === "invalid") {
    return new Response(null, {
      status: 416,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes */${fileStat.size}`
      }
    });
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, fileStat.size - 1);
  const contentLength = Math.max(0, end - start + 1);
  const body = Readable.toWeb(createReadStream(job.video_path, { start, end })) as ReadableStream;
  if (downloadId) recordDownloadCompleted(downloadId);

  return new Response(body, {
    status: range ? 206 : 200,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Disposition": `inline; filename="facereel-${job.username}-video.mp4"`,
      "Cache-Control": "public, max-age=86400, immutable",
      "Accept-Ranges": "bytes",
      "Content-Length": String(contentLength),
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${fileStat.size}` } : {})
    }
  });
}

function parseByteRange(value: string | null, size: number): { start: number; end: number } | null | "invalid" {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) return "invalid";

  const startText = match[1] || "";
  const endText = match[2] || "";
  if (!startText && !endText) return "invalid";

  if (!startText) {
    const suffixLength = Number.parseInt(endText, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return "invalid";
    return {
      start: Math.max(0, size - suffixLength),
      end: Math.max(0, size - 1)
    };
  }

  const start = Number.parseInt(startText, 10);
  const requestedEnd = endText ? Number.parseInt(endText, 10) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(requestedEnd) || start < 0 || requestedEnd < start || start >= size) return "invalid";

  return {
    start,
    end: Math.min(requestedEnd, Math.max(0, size - 1))
  };
}
