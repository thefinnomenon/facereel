import type { APIEvent } from "@solidjs/start/server";
import { estimateJobQueue, getJob, toPublicJob } from "@facereel/db";
import { errorJson, json } from "../../../../lib/server.ts";

const DEFAULT_ESTIMATED_JOB_SECONDS = 8 * 60;

export async function GET({ params }: APIEvent): Promise<Response> {
  const id = params.id;
  const job = id ? getJob(id) : null;
  if (!job) return errorJson("Job not found.", 404);
  const publicJob = toPublicJob(job, true);
  const queueEstimate = job.status === "queued" || job.status === "processing"
    ? estimateJobQueue(job, estimatedJobSeconds())
    : null;
  return json({
    job: {
      ...publicJob,
      estimatedWaitSeconds: queueEstimate?.estimatedWaitSeconds ?? null,
      estimatedReadySeconds: queueEstimate?.estimatedReadySeconds ?? null
    }
  });
}

function estimatedJobSeconds(): number {
  const parsed = Number(process.env.FACEREEL_ESTIMATED_JOB_SECONDS || "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ESTIMATED_JOB_SECONDS;
}
