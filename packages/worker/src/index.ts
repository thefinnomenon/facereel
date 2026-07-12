import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  claimNextJob,
  getJob,
  incrementJobRetry,
  logError,
  logInfo,
  logWarn,
  nowIso,
  storageDir,
  trackEvent,
  updateJob
} from "@facereel/db";
import { sendAdminJobCreatedEmail, sendProcessingEmail, sendReadyEmail } from "./email.ts";
import { faceReelVideoFilename, generateFaceReel, mockGenerateFaceReel } from "./facereel.ts";
import { buildInstagramMediaManifest, checkInstagramProfile, downloadScanImages, downloadSourceImages } from "./instagram.ts";

export { buildInstagramMediaManifest, checkInstagramProfile, downloadScanImages, downloadSourceImages } from "./instagram.ts";
export { appUrl, normalizeEmail, sanitizeInstagramUsername } from "./validation.ts";
export { faceReelPosterFilename, faceReelVideoFilename, generateFaceReel, mockGenerateFaceReel } from "./facereel.ts";
export { sendAdminJobCreatedEmail, sendProcessingEmail, sendReadyEmail } from "./email.ts";

const RETENTION_DAYS = 7;

export type ProcessJobOptions = {
  allowRetry?: boolean;
};

export async function processJob(jobId: string, options: ProcessJobOptions = {}): Promise<void> {
  const allowRetry = options.allowRetry ?? true;
  const current = getJob(jobId);
  if (!current) throw new Error(`Job not found: ${jobId}`);
  if (current.status === "completed") return;
  if (current.status === "failed" && !allowRetry) return;

  updateJob(jobId, {
    status: "processing",
    progress: 2,
    step: "Job created",
    processing_started_at: current.processing_started_at ?? nowIso(),
    error_message: null
  });

  trackEvent({ event: "worker_started", jobId, user: current.email });
  logInfo({ event: "worker_started", jobId, user: current.email, message: "Worker started processing job." });

  try {
    const useMock = process.env.FACEREEL_MOCK === "1";
    let result: Awaited<ReturnType<typeof generateFaceReel>>;
    let instagramMetadata = {
      oldestImagePostAt: null as string | null,
      newestImagePostAt: null as string | null
    };
    let warnings: string[] = [];

    if (useMock) {
      updateJob(jobId, { progress: 20, step: "Scanning faces", ig_public: 1, ig_post_count: 8, scan_count: 8 });
      result = await mockGenerateFaceReel({
        outputDir: current.output_dir,
        onProgress(event) {
          updateJob(jobId, {
            progress: Math.max(20, Math.min(98, Math.round(20 + event.progress * 78))),
            step: event.stage,
            matched_count: event.matched_count ?? 0
          });
        }
      });
    } else {
      const check = await checkInstagramProfile(current.username);
      if (!check.exists) throw new Error("Instagram profile was not found.");
      if (!check.is_public) throw new Error("Instagram profile is private. Make it public and resubmit or retry.");

      updateJob(jobId, {
        progress: 8,
        step: "Instagram verified",
        ig_public: 1,
        ig_post_count: check.estimated_photo_count
      });
      trackEvent({ event: "instagram_check_public", jobId, user: current.email, metadata: { estimatedPhotoCount: check.estimated_photo_count } });

      const maxImages = positiveIntFromEnv("FACEREEL_MAX_IMAGES", 0);
      const manifest = await buildInstagramMediaManifest({
        username: current.username,
        ...(maxImages ? { maxImages } : {}),
        onProgress(event) {
          updateJob(jobId, {
            progress: Math.max(10, Math.min(22, Math.round(10 + event.progress * 12))),
            step: "Finding photos",
            ig_post_count: event.total_count ?? check.estimated_photo_count
          });
        }
      });
      if (manifest.items.length === 0) throw new Error("No Instagram image posts were available to scan.");
      warnings = [...warnings, ...manifest.warnings];
      instagramMetadata = {
        oldestImagePostAt: manifest.oldest_image_post_at,
        newestImagePostAt: manifest.newest_image_post_at
      };
      updateJob(jobId, { progress: 24, step: "Scanning faces", ig_post_count: manifest.items.length });

      const scansDir = path.join(current.output_dir, "scans");
      const scans = await downloadScanImages({
        items: manifest.items,
        outputDir: scansDir,
        onProgress(event) {
          updateJob(jobId, {
            progress: Math.max(24, Math.min(48, Math.round(24 + event.progress * 24))),
            step: "Scanning faces",
            scan_count: event.downloaded_count ?? 0,
            skipped_count: Math.max(0, (event.total_count ?? 0) - (event.downloaded_count ?? 0))
          });
        }
      });
      warnings = [...warnings, ...scans.errors];
      if (scans.images.length === 0) throw new Error("No scan images could be downloaded.");

      const sourcesDir = path.join(current.output_dir, "sources");
      result = await generateFaceReel({
        targetPath: current.target_path,
        scanImages: scans.images,
        outputDir: current.output_dir,
        sourceDownloader(matches) {
          return downloadSourceImages({
            items: matches,
            outputDir: sourcesDir,
            onProgress(event) {
              updateJob(jobId, {
                progress: Math.max(62, Math.min(78, Math.round(62 + event.progress * 16))),
                step: "Downloading matches",
                downloaded_count: event.downloaded_count ?? 0
              });
            }
          });
        },
        onProgress(event) {
          const range: [number, number] = event.stage === "Scanning faces"
            ? [48, 62]
            : event.stage === "Aligning faces"
              ? [78, 92]
              : [92, 98];
          const patch = {
            progress: Math.max(range[0], Math.min(range[1], Math.round(range[0] + event.progress * (range[1] - range[0])))),
            step: event.stage
          };
          updateJob(jobId, typeof event.matched_count === "number" ? { ...patch, matched_count: event.matched_count } : patch);
        }
      });
    }

    const cleanupAfter = new Date(Date.now() + RETENTION_DAYS * 24 * 60 * 60_000).toISOString();
    updateJob(jobId, {
      status: "completed",
      progress: 100,
      step: "Done",
      scan_count: result.scannedCount,
      downloaded_count: result.highResCount,
      matched_count: result.matchedCount,
      skipped_count: result.skippedCount,
      video_path: result.videoPath,
      poster_path: result.posterPath,
      processing_completed_at: nowIso(),
      metadata: JSON.stringify({
        ...safeMetadata(current.metadata),
        cleanupAfter,
        instagram: instagramMetadata,
        faceReel: {
          video: faceReelVideoFilename,
          videoWidth: result.videoWidth,
          videoHeight: result.videoHeight,
          frameCount: result.framePaths.length,
          matchThreshold: result.matchThreshold,
          warnings: [...warnings, ...result.warnings]
        }
      })
    });

    trackEvent({ event: "worker_completed", jobId, user: current.email, metadata: { matchedCount: result.matchedCount } });
    logInfo({ event: "worker_completed", jobId, user: current.email, message: "Worker completed job.", metadata: { matchedCount: result.matchedCount } });
    await sendReadyEmail({ to: current.email, jobId, username: current.username }).catch((error) => {
      logWarn({ event: "ready_email_failed", jobId, user: current.email, message: error instanceof Error ? error.message : String(error) });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError({
      event: "worker_failed",
      jobId,
      user: current.email,
      message,
      stack: error instanceof Error ? error.stack : undefined
    });
    trackEvent({ event: "worker_failed", jobId, user: current.email, metadata: { message, retry: allowRetry } });

    const latest = getJob(jobId);
    if (allowRetry && latest && latest.retry_count < 1) {
      incrementJobRetry(jobId);
      updateJob(jobId, {
        status: "queued",
        progress: 5,
        step: "Job created",
        error_message: `Retrying after failure: ${message}`
      });
      logWarn({ event: "worker_retry", jobId, user: current.email, message: "Retrying failed job once." });
      await processJob(jobId, { allowRetry: false });
      return;
    }

    updateJob(jobId, {
      status: "failed",
      progress: 100,
      step: "Failed",
      error_message: message,
      processing_completed_at: nowIso()
    });
  }
}

export async function processNextJob(): Promise<boolean> {
  const job = claimNextJob();
  if (!job) return false;
  await processJob(job.id);
  return true;
}

export async function runWorkerLoop(input: { pollMs?: number | undefined; once?: boolean | undefined } = {}): Promise<void> {
  const pollMs = input.pollMs ?? 5_000;
  await mkdir(storageDir(), { recursive: true });
  while (true) {
    const processed = await processNextJob();
    if (input.once) return;
    if (!processed) await sleep(pollMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function safeMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export async function sendInitialProcessingEmail(input: {
  to: string;
  jobId: string;
  username: string;
  queuePosition?: number | null;
  estimatedWaitSeconds?: number | null;
  estimatedReadySeconds?: number | null;
}): Promise<void> {
  await sendProcessingEmail(input);
}
