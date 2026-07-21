import { getAuthorizedJob, hashOwnerToken } from "@facereel/db";
import { cookies } from "next/headers";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const token = request.headers.get("x-facereel-access") || (await cookies()).get("facereel_access")?.value;
  if (!token)
    return Response.json({ error: "Not authorized" }, { status: 401 });
  const { id } = await params;
  const job = await getAuthorizedJob(id, hashOwnerToken(token));
  if (!job)
    return Response.json({ error: "Render job not found" }, { status: 404 });
  return Response.json({
    id: job.id,
    projectId: job.projectId,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    createdAt: job.createdAt,
    processingStartedAt: job.processingStartedAt,
    completedAt: job.completedAt,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    assets: job.assets.map((a) => ({
      ...a,
      sizeBytes: a.sizeBytes.toString(),
    })),
  });
}
