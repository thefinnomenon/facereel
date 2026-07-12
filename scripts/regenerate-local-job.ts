import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { faceReelVideoFilename, generateFaceReel } from "../packages/worker/src/facereel.ts";
import { getJob, nowIso, updateJob } from "../packages/db/src/index.ts";

const jobId = process.argv[2];
if (!jobId) throw new Error("Usage: npx tsx scripts/regenerate-local-job.ts <job-id>");

const job = getJob(jobId);
if (!job) throw new Error(`Job not found: ${jobId}`);

const outputDir = job.output_dir;
const manifestPath = path.join(outputDir, "face_manifest.json");
const previousManifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) as { matches?: Array<{ id: string; takenAt?: number | null }> } : {};
const takenAtById = new Map((previousManifest.matches || []).map((match) => [String(match.id), typeof match.takenAt === "number" ? match.takenAt : null]));
const scansDir = path.join(outputDir, "scans");
const sourcesDir = path.join(outputDir, "sources");

const scanImages = readdirSync(scansDir)
  .filter((name) => name.endsWith("-scan.jpg"))
  .sort()
  .map((name) => {
    const id = name.replace(/-scan\.jpg$/, "");
    return {
      id,
      scanPath: path.join(scansDir, name),
      scanUrl: "",
      sourceUrl: "",
      takenAt: takenAtById.get(id) ?? null,
      width: null,
      height: null
    };
  });

const started = Date.now();
const processingStartedAt = nowIso();
console.log(`Regenerating ${jobId} from ${scanImages.length} scan images`);
updateJob(jobId, {
  status: "processing",
  progress: 78,
  step: "Aligning faces",
  processing_started_at: processingStartedAt,
  processing_completed_at: null
});

const result = await generateFaceReel({
  targetPath: job.target_path,
  scanImages,
  outputDir,
  async sourceDownloader(matches) {
    const images = [];
    const errors: string[] = [];
    for (const match of matches) {
      const sourcePath = path.join(sourcesDir, `${match.id}-source.jpg`);
      if (existsSync(sourcePath)) images.push({ ...match, sourcePath });
      else errors.push(`Missing local source for ${match.id}`);
    }
    return { images, skipped_count: matches.length - images.length, errors };
  },
  onProgress(event) {
    if (event.stage === "Rendering video" || event.progress === 1) {
      console.log(`${event.stage}: ${Math.round(event.progress * 100)}% matched=${event.matched_count ?? ""}`);
    }
  }
});

const existingMetadata = job.metadata ? JSON.parse(job.metadata) as Record<string, unknown> : {};
const newManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { alignedFrames?: unknown[] };
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
  processing_started_at: processingStartedAt,
  processing_completed_at: nowIso(),
  metadata: JSON.stringify({
    ...existingMetadata,
    regeneratedAt: nowIso(),
    faceReel: {
      ...((existingMetadata.faceReel || {}) as Record<string, unknown>),
      video: faceReelVideoFilename,
      videoWidth: result.videoWidth,
      videoHeight: result.videoHeight,
      frameCount: result.framePaths.length,
      matchThreshold: result.matchThreshold,
      warnings: result.warnings,
      alignment: {
        frameHoldSeconds: 0.3,
        alignedFrameCount: newManifest.alignedFrames?.length ?? result.framePaths.length
      }
    }
  })
});

console.log(JSON.stringify({
  frames: result.framePaths.length,
  highRes: result.highResCount,
  skipped: result.skippedCount,
  seconds: Math.round((Date.now() - started) / 1000),
  videoPath: result.videoPath
}, null, 2));
