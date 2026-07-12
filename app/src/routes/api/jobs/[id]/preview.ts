import type { APIEvent } from "@solidjs/start/server";
import { getJob } from "@facereel/db";
import { errorJson, imageResponse } from "../../../../lib/server.ts";

export async function GET({ request, params }: APIEvent): Promise<Response> {
  const job = params.id ? getJob(params.id) : null;
  if (!job) return errorJson("Job not found.", 404);

  const kind = new URL(request.url).searchParams.get("kind");
  if (kind === "target") return imageResponse(job.target_path);
  if (kind === "poster") {
    if (!job.poster_path || job.status !== "completed") return errorJson("Poster is not ready yet.", 404);
    return imageResponse(job.poster_path);
  }

  return errorJson("Unknown preview type.", 404);
}
