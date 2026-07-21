import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma, RenderJobStatus } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";

const globalPrisma = globalThis as unknown as { facereelPrisma?: PrismaClient };

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL ??
    (process.env.NEXT_PHASE === "phase-production-build" ? "postgresql://build-only:build-only@127.0.0.1:5432/build-only" : undefined);
  if (!connectionString)
    throw new Error(
      "DATABASE_URL is required; FaceReel has no local database fallback.",
    );
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

export const prisma = globalPrisma.facereelPrisma ?? createClient();
if (process.env.NODE_ENV !== "production") globalPrisma.facereelPrisma = prisma;

export { Prisma, RenderJobStatus };
export type {
  FaceReelProject,
  RenderJob,
  RenderedAsset,
  SourceImage,
} from "@prisma/client";

export function newOwnerToken(): string {
  return randomBytes(32).toString("base64url");
}
export function hashOwnerToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createProjectAndJob(input: {
  projectId: string;
  email: string;
  username: string;
  ownerTokenHash: string;
  ownerAccessToken: string;
  source: {
    id: string;
    objectKey: string;
    bucket: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    width?: number;
    height?: number;
  };
}) {
  return prisma.$transaction(
    async (tx) => {
      const project = await tx.faceReelProject.create({
        data: {
          id: input.projectId,
          email: input.email,
          name: `@${input.username} FaceReel`,
          instagramUsername: input.username,
          ownerTokenHash: input.ownerTokenHash,
          ownerAccessToken: input.ownerAccessToken,
          status: "READY",
          sourceImages: {
            create: {
              id: input.source.id,
              orderIndex: 0,
              r2Bucket: input.source.bucket,
              r2ObjectKey: input.source.objectKey,
              originalFilename: input.source.filename,
              contentType: input.source.contentType,
              sizeBytes: BigInt(input.source.sizeBytes),
              width: input.source.width ?? null,
              height: input.source.height ?? null,
              uploadStatus: "UPLOADED",
              validationStatus: "VALID",
            },
          },
        },
      });
      const job = await tx.renderJob.create({
        data: {
          projectId: project.id,
          email: input.email,
          events: {
            create: { eventType: "JOB_CREATED", stage: "QUEUED", progress: 0 },
          },
          dispatch: { create: {} },
          emails: { create: { kind: "PROCESSING" } },
        },
      });
      return { project, job };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function getAuthorizedJob(jobId: string, ownerTokenHash: string) {
  return prisma.renderJob.findFirst({
    where: { id: jobId, project: { ownerTokenHash } },
    include: {
      assets: {
        select: {
          id: true,
          assetType: true,
          variant: true,
          contentType: true,
          sizeBytes: true,
          width: true,
          height: true,
          durationMs: true,
        },
      },
    },
  });
}

export type ClaimResult =
  "CLAIMED" | "COMPLETED" | "ACTIVE" | "INELIGIBLE" | "MISSING";
export async function claimRenderJob(
  jobId: string,
  staleBefore: Date,
  workerRevision?: string,
): Promise<ClaimResult> {
  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{
          status: RenderJobStatus;
          heartbeatAt: Date | null;
          attemptCount: number;
          maxAttempts: number;
        }>
      >`
      SELECT "status", "heartbeatAt", "attemptCount", "maxAttempts" FROM "RenderJob" WHERE "id"=${jobId} FOR UPDATE`;
      const job = rows[0];
      if (!job) return "MISSING";
      if (job.status === "COMPLETED") return "COMPLETED";
      if (
        job.status === "PROCESSING" &&
        job.heartbeatAt &&
        job.heartbeatAt >= staleBefore
      )
        return "ACTIVE";
      if (
      !["QUEUED", "PROCESSING"].includes(job.status) ||
        job.attemptCount >= job.maxAttempts
      )
        return "INELIGIBLE";
      const now = new Date();
      await tx.renderJob.update({
        where: { id: jobId },
        data: {
          status: "PROCESSING",
          progress: 1,
          stage: "DOWNLOADING_IMAGES",
          attemptCount: { increment: 1 },
          workerRevision: workerRevision ?? null,
          heartbeatAt: now,
          processingStartedAt: now,
          failedAt: null,
          errorCode: null,
          errorMessage: null,
          internalError: null,
          events: {
            create: {
              eventType: "CLAIMED",
              stage: "DOWNLOADING_IMAGES",
              progress: 1,
            },
          },
        },
      });
      await tx.faceReelProject.update({
        where: {
          id: (
            await tx.renderJob.findUniqueOrThrow({
              where: { id: jobId },
              select: { projectId: true },
            })
          ).projectId,
        },
        data: { status: "RENDERING" },
      });
      return "CLAIMED";
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function markJobFailure(
  jobId: string,
  error: {
    code: string;
    message: string;
    internal: string;
    retryable: boolean;
  },
) {
  const job = await prisma.renderJob.findUniqueOrThrow({
    where: { id: jobId },
  });
  const canRetry = error.retryable && job.attemptCount < job.maxAttempts;
  await prisma.$transaction([
    prisma.renderJob.update({
      where: { id: jobId },
      data: {
        status: canRetry ? "QUEUED" : "FAILED",
        stage: canRetry ? "QUEUED" : "FAILED",
        errorCode: error.code,
        errorMessage: error.message,
        internalError: error.internal.slice(0, 4000),
        heartbeatAt: new Date(),
        failedAt: canRetry ? null : new Date(),
        ...(canRetry
          ? {
              dispatch: {
                update: {
                  status: "PENDING",
                  nextAttemptAt: new Date(),
                  lastError: error.code,
                },
              },
            }
          : {
              project: {
                update: { status: "FAILED" },
              },
              emails: {
                upsert: {
                  where: {
                    renderJobId_kind: { renderJobId: jobId, kind: "FAILURE" },
                  },
                  create: { kind: "FAILURE" },
                  update: { status: "PENDING" },
                },
              },
            }),
      },
    }),
    prisma.renderJobEvent.create({
      data: {
        renderJobId: jobId,
        eventType: canRetry ? "RETRY_PENDING" : "FAILED",
        stage: canRetry ? "QUEUED" : "FAILED",
        metadata: { code: error.code },
      },
    }),
  ]);
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
