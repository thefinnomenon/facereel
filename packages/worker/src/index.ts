import { claimRenderJob, markJobFailure, prisma } from "@facereel/db";
import { storage } from "@facereel/storage";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { sendPendingEmail } from "./email.ts";
import {
  faceReelPosterFilename,
  faceReelVideoFilename,
  generateFaceReel,
  mockGenerateFaceReel,
} from "./facereel.ts";
import {
  buildInstagramMediaManifest,
  checkInstagramProfile,
  downloadScanImages,
  downloadSourceImages,
} from "./instagram.ts";

export {
  buildInstagramMediaManifest,
  checkInstagramProfile,
  downloadScanImages,
  downloadSourceImages,
} from "./instagram.ts";
export {
  appUrl,
  normalizeEmail,
  sanitizeInstagramUsername,
} from "./validation.ts";
export {
  detectFaces,
  faceReelPosterFilename,
  faceReelVideoFilename,
  generateFaceReel,
  mockGenerateFaceReel,
} from "./facereel.ts";

const STALE_MS = Number(process.env.RENDER_STALE_MINUTES || 30) * 60_000;
export type ProcessResult =
  | "COMPLETED"
  | "ALREADY_COMPLETED"
  | "ALREADY_PROCESSING"
  | "RETRY"
  | "TERMINAL";

export async function processRenderJob(jobId: string): Promise<ProcessResult> {
  const claim = await claimRenderJob(
    jobId,
    new Date(Date.now() - STALE_MS),
    process.env.K_REVISION || process.env.GIT_SHA,
  );
  if (claim === "COMPLETED") {
    await sendPendingEmail(jobId, "COMPLETION");
    return "ALREADY_COMPLETED";
  }
  if (claim === "ACTIVE") return "ALREADY_PROCESSING";
  if (claim !== "CLAIMED") return "TERMINAL";
  await sendPendingEmail(jobId, "PROCESSING").catch(() => {});
  const job = await prisma.renderJob.findUniqueOrThrow({
    where: { id: jobId },
    include: { project: { include: { sourceImages: true } } },
  });
  const scratch = await mkdtemp(
    path.join(tmpdir(), `facereel-${jobId}-a${job.attemptCount}-`),
  );
  const progress = createProgressReporter(jobId);
  try {
    const target = job.project.sourceImages.find(
      (s) => s.orderIndex === 0 && s.uploadStatus === "UPLOADED",
    );
    if (!target)
      throw renderError(
        "SOURCE_IMAGE_MISSING",
        "The target face photo is missing.",
        false,
      );
    const targetPath = path.join(scratch, "target");
    await progress.update(3, "DOWNLOADING_IMAGES");
    await storage().downloadToFile(target.r2ObjectKey, targetPath);
    await progress.update(8, "VALIDATING_IMAGES");
    let result: Awaited<ReturnType<typeof generateFaceReel>>;
    if (process.env.FACEREEL_MOCK === "1")
      result = await mockGenerateFaceReel({
        outputDir: scratch,
        onProgress: (e) => void progress.mapped(e.stage, e.progress),
      });
    else {
      const check = await checkInstagramProfile(job.project.instagramUsername);
      if (!check.exists)
        throw renderError(
          "SOURCE_IMAGE_MISSING",
          "The Instagram profile was not found.",
          false,
        );
      if (!check.is_public)
        throw renderError(
          "SOURCE_IMAGE_INVALID",
          "The Instagram profile must remain public while rendering.",
          false,
        );
      const manifest = await buildInstagramMediaManifest({
        username: job.project.instagramUsername,
        maxImages: positiveInt("FACEREEL_MAX_IMAGES", 500),
        onProgress: (e) =>
          void progress.update(
            8 + Math.round(e.progress * 5),
            "DOWNLOADING_IMAGES",
          ),
      });
      if (!manifest.items.length)
        throw renderError(
          "INSUFFICIENT_VALID_IMAGES",
          "No source photos were available.",
          false,
        );
      const scans = await downloadScanImages({
        items: manifest.items,
        outputDir: path.join(scratch, "scans"),
        onProgress: (e) =>
          void progress.update(
            10 + Math.round(e.progress * 15),
            "DOWNLOADING_IMAGES",
            { processedImages: e.downloaded_count, totalImages: e.total_count },
          ),
      });
      if (!scans.images.length)
        throw renderError(
          "SOURCE_IMAGE_INVALID",
          "No source photos could be decoded.",
          true,
        );
      result = await generateFaceReel({
        targetPath,
        scanImages: scans.images,
        outputDir: scratch,
        sourceDownloader: async (matches) => {
          const downloaded = await downloadSourceImages({
            items: matches,
            outputDir: path.join(scratch, "sources"),
            onProgress: (e) =>
              void progress.update(
                30 + Math.round(e.progress * 10),
                "DOWNLOADING_IMAGES",
                {
                  processedImages: e.downloaded_count,
                  totalImages: e.total_count,
                },
              ),
          });
          await Promise.all(
            downloaded.images.map(async (image, index) => {
              const sourceId = `${jobId}-${image.id}`;
              const key = `projects/${job.projectId}/source/${sourceId}/original.jpg`;
              const object = await storage().uploadFile(
                key,
                image.sourcePath,
                "image/jpeg",
              );
              await prisma.sourceImage.upsert({
                where: { r2ObjectKey: key },
                create: {
                  id: sourceId,
                  projectId: job.projectId,
                  orderIndex: index + 1,
                  r2Bucket: object.bucket,
                  r2ObjectKey: key,
                  originalFilename: `${image.id}.jpg`,
                  contentType: "image/jpeg",
                  sizeBytes: BigInt(object.sizeBytes),
                  width: image.width,
                  height: image.height,
                  checksum: object.etag ?? null,
                  uploadStatus: "UPLOADED",
                  validationStatus: "VALID",
                },
                update: {
                  checksum: object.etag ?? null,
                  sizeBytes: BigInt(object.sizeBytes),
                  uploadStatus: "UPLOADED",
                  validationStatus: "VALID",
                },
              });
            }),
          );
          return downloaded;
        },
        onProgress: (e) => void progress.mapped(e.stage, e.progress),
      });
    }
    await progress.update(92, "UPLOADING_OUTPUTS");
    const videoMeta = await validateVideo(
      result.videoPath,
      job.project.frameRate,
    );
    const videoKey = `projects/${job.projectId}/renders/${jobId}/outputs/master.mp4`;
    const posterKey = `projects/${job.projectId}/renders/${jobId}/outputs/poster.jpg`;
    const [video, poster] = await Promise.all([
      storage().uploadFile(videoKey, result.videoPath, "video/mp4"),
      storage().uploadFile(posterKey, result.posterPath, "image/jpeg"),
    ]);
    await progress.update(98, "FINALIZING");
    await prisma.$transaction(async (tx) => {
      await tx.renderedAsset.createMany({
        data: [
          {
            renderJobId: jobId,
            projectId: job.projectId,
            assetType: "MASTER_VIDEO",
            variant: "master",
            r2Bucket: video.bucket,
            r2ObjectKey: videoKey,
            contentType: "video/mp4",
            sizeBytes: BigInt(video.sizeBytes),
            width: videoMeta.width,
            height: videoMeta.height,
            durationMs: videoMeta.durationMs,
            frameRate: videoMeta.frameRate,
            checksum: video.etag ?? null,
          },
          {
            renderJobId: jobId,
            projectId: job.projectId,
            assetType: "POSTER_FRAME",
            variant: "poster",
            r2Bucket: poster.bucket,
            r2ObjectKey: posterKey,
            contentType: "image/jpeg",
            sizeBytes: BigInt(poster.sizeBytes),
            width: result.videoWidth,
            height: result.videoHeight,
            checksum: poster.etag ?? null,
          },
        ],
        skipDuplicates: true,
      });
      await tx.renderJob.update({
        where: { id: jobId },
        data: {
          status: "COMPLETED",
          progress: 100,
          stage: "COMPLETED",
          completedAt: new Date(),
          heartbeatAt: new Date(),
          events: {
            create: {
              eventType: "COMPLETED",
              stage: "COMPLETED",
              progress: 100,
            },
          },
          emails: {
            upsert: {
              where: {
                renderJobId_kind: { renderJobId: jobId, kind: "COMPLETION" },
              },
              create: { kind: "COMPLETION" },
              update: { status: "PENDING" },
            },
          },
        },
      });
      await tx.faceReelProject.update({
        where: { id: job.projectId },
        data: { status: "COMPLETED" },
      });
    });
    await sendPendingEmail(jobId, "COMPLETION");
    return "COMPLETED";
  } catch (error) {
    const classified = classify(error);
    await markJobFailure(jobId, classified);
    if (!classified.retryable) await sendPendingEmail(jobId, "FAILURE");
    return classified.retryable ? "RETRY" : "TERMINAL";
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function createProgressReporter(jobId: string) {
  let lastProgress = -1,
    lastStage = "",
    lastWrite = 0;
  return {
    async update(
      progress: number,
      stage: string,
      detail?: Record<string, unknown>,
    ) {
      const now = Date.now();
      progress = Math.max(0, Math.min(100, progress));
      if (
        stage === lastStage &&
        progress - lastProgress < 2 &&
        now - lastWrite < 10_000
      )
        return;
      lastProgress = progress;
      lastStage = stage;
      lastWrite = now;
      try {
        await prisma.renderJob.updateMany({
          where: { id: jobId, status: "PROCESSING" },
          data: {
            progress,
            stage,
            progressDetail: detail as any,
            heartbeatAt: new Date(),
          },
        });
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: "progress_write_failed",
            jobId,
            stage,
            message: String(error),
          }),
        );
      }
    },
    async mapped(stage: string, fraction: number) {
      const map: Record<string, [number, number, string]> = {
        "Scanning faces": [25, 45, "DETECTING_FACES"],
        "Downloading matches": [45, 50, "DOWNLOADING_IMAGES"],
        "Aligning faces": [50, 70, "ALIGNING_FACES"],
        "Rendering video": [70, 92, "ENCODING_VIDEO"],
      };
      const [start, end, name] = map[stage] || [50, 90, "GENERATING_FRAMES"];
      await this.update(Math.round(start + (end - start) * fraction), name);
    },
  };
}
function renderError(code: string, message: string, retryable: boolean) {
  return Object.assign(new Error(message), { code, retryable });
}
function classify(error: unknown) {
  const value = error as {
    code?: string;
    retryable?: boolean;
    message?: string;
    stack?: string;
  };
  return {
    code:
      value.code ||
      (/ffmpeg/i.test(value.message || "")
        ? "VIDEO_ENCODING_FAILED"
        : "INTERNAL_RENDER_ERROR"),
    message: value.code
      ? value.message || "Rendering failed."
      : "Rendering was interrupted. We will retry when safe.",
    internal: (value.stack || value.message || String(error)).slice(0, 4000),
    retryable: value.retryable ?? true,
  };
}
function positiveInt(name: string, fallback: number) {
  const n = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
async function validateVideo(
  file: string,
  expectedFps: number,
): Promise<{
  durationMs: number;
  width: number;
  height: number;
  frameRate: number;
}> {
  const info = await new Promise<any>((resolve, reject) => {
    const child = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_name,width,height,r_frame_rate",
        "-of",
        "json",
        file,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr = (stderr + c).slice(-2000)));
    child.on("close", (code) =>
      code === 0
        ? resolve(JSON.parse(stdout))
        : reject(new Error(`ffprobe failed: ${stderr}`)),
    );
    child.on("error", reject);
  });
  const fileStat = await stat(file);
  const stream = info.streams?.find((s: any) => s.codec_name === "h264");
  const duration = Number(info.format?.duration);
  if (
    !stream ||
    fileStat.size <= 0 ||
    !duration ||
    stream.width !== 1080 ||
    stream.height !== 1920
  )
    throw renderError(
      "OUTPUT_VALIDATION_FAILED",
      "The rendered video did not pass validation.",
      true,
    );
  return {
    durationMs: Math.round(duration * 1000),
    width: stream.width,
    height: stream.height,
    frameRate: expectedFps,
  };
}
