import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { LocalScanImage, LocalSourceImage } from "./instagram.ts";

export const faceReelVideoFilename = "facereel.mp4";
export const faceReelPosterFilename = "poster.jpg";

const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;
const DEFAULT_MATCH_THRESHOLD = 0.5;
const DEFAULT_MIN_MATCHES = 4;
const FRAME_HOLD_SECONDS = 0.3;
const TARGET_FACE_WIDTH = 300;
const TARGET_EYE_Y = 720;
const MAX_ALIGNMENT_ROTATION_DEGREES = 38;
const MIN_ALIGNMENT_SCALE = 0.35;
const MAX_ALIGNMENT_SCALE = 2.4;
const WATERMARK_TEXT = "FaceReel.net";
let modelsLoaded = false;
let faceapiModule: typeof import("@vladmandic/face-api") | null = null;
let tfModule: typeof import("@tensorflow/tfjs-node") | null = null;

type Detection = {
  descriptor: Float32Array;
  box: Box;
  landmarks: LandmarkSet;
};

type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type Point = {
  x: number;
  y: number;
};

type LandmarkSet = {
  positions: Point[];
};

type ScanMatch = {
  image: LocalScanImage;
  distance: number;
  detection: Detection;
};

type FrequentFaceSample = {
  image: LocalScanImage;
  detection: Detection;
  faceCount: number;
};

export type FaceDescriptorSample = {
  imageId: string;
  descriptor: Float32Array;
};

export type FaceDescriptorCluster = {
  imageIds: Set<string>;
  sampleIndexes: number[];
  centroid: Float32Array;
};

type AlignmentStats = {
  rotationDegrees: number;
  scale: number;
  eyeDistance: number;
  placement: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
};

export type FaceReelProgressEvent = {
  stage: string;
  progress: number;
  matched_count?: number;
  total_count?: number;
};

export type FaceReelResult = {
  videoPath: string;
  posterPath: string;
  framePaths: string[];
  matchedCount: number;
  scannedCount: number;
  highResCount: number;
  skippedCount: number;
  warnings: string[];
  videoWidth: number;
  videoHeight: number;
  matchThreshold: number;
};

export async function generateFaceReel(input: {
  targetPath: string;
  scanImages: LocalScanImage[];
  outputDir: string;
  sourceDownloader: (matches: LocalScanImage[]) => Promise<{ images: LocalSourceImage[]; skipped_count: number; errors: string[] }>;
  matchThreshold?: number;
  minMatches?: number;
  onProgress?: (event: FaceReelProgressEvent) => void;
}): Promise<FaceReelResult> {
  const threshold = input.matchThreshold ?? numberFromEnv("FACEREEL_MATCH_THRESHOLD", DEFAULT_MATCH_THRESHOLD);
  const minMatches = input.minMatches ?? numberFromEnv("FACEREEL_MIN_MATCHES", DEFAULT_MIN_MATCHES);
  const framesDir = path.join(input.outputDir, "frames");
  await rm(framesDir, { recursive: true, force: true });
  await mkdir(framesDir, { recursive: true });

  const targetDetection = await detectSingleTargetFace(input.targetPath);
  const scanMatches: ScanMatch[] = [];
  const warnings: string[] = [];
  let skipped = 0;

  for (let index = 0; index < input.scanImages.length; index += 1) {
    const image = input.scanImages[index]!;
    try {
      const detections = await detectFaces(image.scanPath);
      const best = closestDetection(targetDetection.descriptor, detections);
      if (best && best.distance <= threshold) {
        scanMatches.push({ image, distance: best.distance, detection: best.detection });
      }
    } catch (error) {
      skipped += 1;
      warnings.push(`Skipped scan ${image.id}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      input.onProgress?.({
        stage: "Scanning faces",
        progress: (index + 1) / Math.max(1, input.scanImages.length),
        matched_count: scanMatches.length,
        total_count: input.scanImages.length
      });
    }
  }

  if (scanMatches.length < minMatches) {
    throw insufficientMatchesError(scanMatches.length, minMatches);
  }

  const matchedById = new Map(scanMatches.map((match) => [match.image.id, match]));
  const highRes = await input.sourceDownloader(scanMatches.map((match) => match.image));
  skipped += highRes.skipped_count;
  warnings.push(...highRes.errors);

  if (highRes.images.length < minMatches) {
    throw new Error(`Only ${highRes.images.length} high-resolution matches could be downloaded. FaceReel needs at least ${minMatches}.`);
  }

  const sortedSources = [...highRes.images].sort((a, b) => (a.takenAt ?? 0) - (b.takenAt ?? 0));
  const framePaths: string[] = [];
  const alignedFrames: Array<{ id: string; rotationDegrees: number; scale: number; eyeDistance: number }> = [];

  for (let index = 0; index < sortedSources.length; index += 1) {
    const source = sortedSources[index]!;
    const scanMatch = matchedById.get(source.id);
    if (!scanMatch) continue;

    try {
      const detection = await bestSourceDetection(source, targetDetection.descriptor, threshold, scanMatch.detection);
      const framePath = path.join(framesDir, `frame-${String(framePaths.length).padStart(5, "0")}.jpg`);
      const alignment = await writeAlignedFrame(source.sourcePath, detection, framePath);
      framePaths.push(framePath);
      alignedFrames.push({
        id: source.id,
        rotationDegrees: Number(alignment.rotationDegrees.toFixed(2)),
        scale: Number(alignment.scale.toFixed(3)),
        eyeDistance: Number(alignment.eyeDistance.toFixed(1))
      });
    } catch (error) {
      skipped += 1;
      warnings.push(`Skipped matched source ${source.id}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      input.onProgress?.({
        stage: "Aligning faces",
        progress: (index + 1) / Math.max(1, sortedSources.length),
        matched_count: framePaths.length,
        total_count: sortedSources.length
      });
    }
  }

  if (framePaths.length < minMatches) {
    throw new Error(`Only ${framePaths.length} aligned frames could be generated. FaceReel needs at least ${minMatches}.`);
  }

  const videoPath = path.join(input.outputDir, faceReelVideoFilename);
  const posterPath = path.join(input.outputDir, faceReelPosterFilename);
  await copyFile(framePaths[0]!, posterPath);
  input.onProgress?.({ stage: "Rendering video", progress: 0, matched_count: framePaths.length, total_count: framePaths.length });
  await renderVideo(framePaths, videoPath);
  input.onProgress?.({ stage: "Rendering video", progress: 1, matched_count: framePaths.length, total_count: framePaths.length });

  await writeFile(path.join(input.outputDir, "face_manifest.json"), JSON.stringify({
    threshold,
    minMatches,
    scannedCount: input.scanImages.length,
    matchedCount: scanMatches.length,
    highResCount: highRes.images.length,
    frameCount: framePaths.length,
    matches: scanMatches.map((match) => ({ id: match.image.id, distance: Number(match.distance.toFixed(4)), takenAt: match.image.takenAt })),
    alignedFrames
  }, null, 2));

  return {
    videoPath,
    posterPath,
    framePaths,
    matchedCount: framePaths.length,
    scannedCount: input.scanImages.length,
    highResCount: highRes.images.length,
    skippedCount: skipped,
    warnings: warnings.slice(0, 20),
    videoWidth: WIDTH,
    videoHeight: HEIGHT,
    matchThreshold: threshold
  };
}

export function insufficientMatchesError(matchCount: number, minimum: number) {
  const message = matchCount === 0
    ? "No matching photos found. Upload a clear photo of someone who appears in this Instagram account."
    : `Not enough matching photos found. FaceReel found ${matchCount}, but needs at least ${minimum}.`;
  return Object.assign(new Error(message), {
    code: "INSUFFICIENT_MATCHES",
    retryable: false,
  });
}

export async function mockGenerateFaceReel(input: {
  outputDir: string;
  count?: number;
  onProgress?: (event: FaceReelProgressEvent) => void;
}): Promise<FaceReelResult> {
  const framesDir = path.join(input.outputDir, "frames");
  await mkdir(framesDir, { recursive: true });
  const count = input.count ?? 8;
  const framePaths: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const framePath = path.join(framesDir, `frame-${String(index).padStart(5, "0")}.jpg`);
    const hue = index / Math.max(1, count);
    await sharp({
      create: {
        width: WIDTH,
        height: HEIGHT,
        channels: 3,
        background: {
          r: Math.round(120 + 90 * Math.sin(hue * Math.PI * 2)),
          g: Math.round(120 + 90 * Math.sin(hue * Math.PI * 2 + 2)),
          b: Math.round(120 + 90 * Math.sin(hue * Math.PI * 2 + 4))
        }
      }
    })
      .composite([
        { input: Buffer.from(`<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg"><circle cx="${WIDTH / 2}" cy="720" r="190" fill="#f6d8c8"/><circle cx="470" cy="680" r="20"/><circle cx="610" cy="680" r="20"/></svg>`), top: 0, left: 0 },
        watermarkOverlay()
      ])
      .jpeg({ quality: 90, mozjpeg: true })
      .toFile(framePath);
    framePaths.push(framePath);
    input.onProgress?.({ stage: "Aligning faces", progress: (index + 1) / count, matched_count: index + 1, total_count: count });
  }
  const videoPath = path.join(input.outputDir, faceReelVideoFilename);
  const posterPath = path.join(input.outputDir, faceReelPosterFilename);
  await copyFile(framePaths[0]!, posterPath);
  await renderVideo(framePaths, videoPath);
  return {
    videoPath,
    posterPath,
    framePaths,
    matchedCount: count,
    scannedCount: count,
    highResCount: count,
    skippedCount: 0,
    warnings: ["Mock FaceReel generation enabled."],
    videoWidth: WIDTH,
    videoHeight: HEIGHT,
    matchThreshold: DEFAULT_MATCH_THRESHOLD
  };
}

async function detectSingleTargetFace(imagePath: string): Promise<Detection> {
  const detections = await detectFaces(imagePath);
  if (detections.length === 0) throw new Error("The target image does not contain a detectable face.");
  if (detections.length > 1) throw new Error("The target image contains multiple faces. Upload a photo with one clear target face.");
  return detections[0]!;
}

export async function detectFaces(imagePath: string): Promise<Detection[]> {
  const { faceapi, tf } = await loadFaceModels();
  const bytes = await readFile(imagePath);
  const tensor = tf.node.decodeImage(bytes, 3);
  try {
    const detections = await faceapi
      .detectAllFaces(tensor as never, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.45 }))
      .withFaceLandmarks()
      .withFaceDescriptors();

    return detections.map((detection) => ({
      descriptor: detection.descriptor,
      box: {
        x: detection.detection.box.x,
        y: detection.detection.box.y,
        width: detection.detection.box.width,
        height: detection.detection.box.height
      },
      landmarks: {
        positions: detection.landmarks.positions.map((point) => ({ x: point.x, y: point.y }))
      }
    }));
  } finally {
    tensor.dispose();
  }
}

export async function findMostFrequentFace(input: {
  scanImages: LocalScanImage[];
  targetPath: string;
  matchThreshold?: number;
  onProgress?: (event: FaceReelProgressEvent) => void;
}): Promise<{
  targetPath: string;
  appearances: number;
  scannedPhotos: number;
  detectedFaces: number;
  clusterCount: number;
}> {
  const threshold = input.matchThreshold
    ?? numberFromEnv("FACEREEL_MATCH_THRESHOLD", DEFAULT_MATCH_THRESHOLD);
  const samples: FrequentFaceSample[] = [];

  for (let index = 0; index < input.scanImages.length; index += 1) {
    const image = input.scanImages[index]!;
    try {
      const detections = await detectFaces(image.scanPath);
      for (const detection of detections) {
        samples.push({ image, detection, faceCount: detections.length });
      }
    } catch {
      // A corrupt or unsupported photo should not prevent profile-wide selection.
    } finally {
      input.onProgress?.({
        stage: "Finding the most frequent face",
        progress: (index + 1) / Math.max(1, input.scanImages.length),
        matched_count: samples.length,
        total_count: input.scanImages.length,
      });
    }
  }

  if (samples.length === 0) {
    throw new Error("No detectable faces were found in this Instagram profile.");
  }

  const clusters = clusterFaceDescriptors(
    samples.map((sample) => ({
      imageId: sample.image.id,
      descriptor: sample.detection.descriptor,
    })),
    threshold,
  ).sort((a, b) =>
    b.imageIds.size - a.imageIds.size
    || b.sampleIndexes.length - a.sampleIndexes.length
  );
  const dominant = clusters[0];
  if (!dominant) throw new Error("No recurring face could be selected.");

  const representativeIndexes = [...dominant.sampleIndexes].sort((a, b) => {
    const sampleA = samples[a]!;
    const sampleB = samples[b]!;
    const singleFacePreference = Number(sampleA.faceCount !== 1) - Number(sampleB.faceCount !== 1);
    if (singleFacePreference !== 0) return singleFacePreference;
    return euclideanDistance(sampleA.detection.descriptor, dominant.centroid)
      - euclideanDistance(sampleB.detection.descriptor, dominant.centroid);
  });

  let targetWritten = false;
  for (const sampleIndex of representativeIndexes) {
    const sample = samples[sampleIndex]!;
    if (sample.faceCount === 1) {
      await copyFile(sample.image.scanPath, input.targetPath);
      targetWritten = true;
      break;
    }
    if (await writeFaceCrop(sample, input.targetPath, dominant.centroid, threshold)) {
      targetWritten = true;
      break;
    }
  }
  if (!targetWritten) {
    throw new Error("The most frequent face was found, but a clean target crop could not be created.");
  }

  return {
    targetPath: input.targetPath,
    appearances: dominant.imageIds.size,
    scannedPhotos: input.scanImages.length,
    detectedFaces: samples.length,
    clusterCount: clusters.length,
  };
}

export function clusterFaceDescriptors(
  samples: FaceDescriptorSample[],
  threshold: number,
): FaceDescriptorCluster[] {
  const clusters: Array<FaceDescriptorCluster & { descriptorCount: number }> = [];

  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
    const sample = samples[sampleIndex]!;
    let closest: (typeof clusters)[number] | undefined;
    let closestDistance = Number.POSITIVE_INFINITY;

    for (const cluster of clusters) {
      const distance = euclideanDistance(sample.descriptor, cluster.centroid);
      if (distance < closestDistance) {
        closest = cluster;
        closestDistance = distance;
      }
    }

    if (!closest || closestDistance > threshold) {
      clusters.push({
        imageIds: new Set([sample.imageId]),
        sampleIndexes: [sampleIndex],
        centroid: new Float32Array(sample.descriptor),
        descriptorCount: 1,
      });
      continue;
    }

    if (closest.imageIds.has(sample.imageId)) continue;
    closest.imageIds.add(sample.imageId);
    closest.sampleIndexes.push(sampleIndex);
    closest.descriptorCount += 1;
    for (let index = 0; index < closest.centroid.length; index += 1) {
      closest.centroid[index] = (
        (closest.centroid[index] ?? 0) * (closest.descriptorCount - 1)
        + (sample.descriptor[index] ?? 0)
      ) / closest.descriptorCount;
    }
  }

  return clusters.map(({ descriptorCount: _, ...cluster }) => cluster);
}

async function writeFaceCrop(
  sample: FrequentFaceSample,
  outputPath: string,
  centroid: Float32Array,
  threshold: number,
): Promise<boolean> {
  const metadata = await sharp(sample.image.scanPath).rotate().metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (!width || !height) return false;

  const box = sample.detection.box;
  const cropSize = Math.min(
    width,
    height,
    Math.ceil(Math.max(box.width, box.height) * 2.2),
  );
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const left = clamp(Math.round(centerX - cropSize / 2), 0, width - cropSize);
  const top = clamp(Math.round(centerY - cropSize / 2), 0, height - cropSize);

  try {
    await sharp(sample.image.scanPath)
      .rotate()
      .extract({ left, top, width: cropSize, height: cropSize })
      .jpeg({ quality: 92, mozjpeg: true })
      .toFile(outputPath);
    const detections = await detectFaces(outputPath);
    return detections.length === 1
      && euclideanDistance(detections[0]!.descriptor, centroid) <= threshold + 0.08;
  } catch {
    await rm(outputPath, { force: true });
    return false;
  }
}

async function bestSourceDetection(source: LocalSourceImage, targetDescriptor: Float32Array, threshold: number, fallback: Detection): Promise<Detection> {
  const detections = await detectFaces(source.sourcePath);
  const best = closestDetection(targetDescriptor, detections);
  if (best && best.distance <= Math.min(0.62, threshold + 0.08)) return best.detection;
  return scaleDetection(fallback, await imageScale(source.scanPath, source.sourcePath));
}

function closestDetection(target: Float32Array, detections: Detection[]): { detection: Detection; distance: number } | null {
  let best: { detection: Detection; distance: number } | null = null;
  for (const detection of detections) {
    const distance = euclideanDistance(target, detection.descriptor);
    if (!best || distance < best.distance) best = { detection, distance };
  }
  return best;
}

function euclideanDistance(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    sum += delta * delta;
  }
  return Math.sqrt(sum);
}

async function writeAlignedFrame(sourcePath: string, detection: Detection, outputPath: string): Promise<AlignmentStats> {
  const metadata = await sharp(sourcePath).rotate().metadata();
  const width = metadata.width || WIDTH;
  const height = metadata.height || HEIGHT;
  const leftEye = averagePoint(detection.landmarks.positions.slice(36, 42));
  const rightEye = averagePoint(detection.landmarks.positions.slice(42, 48));
  const eyeMid = { x: (leftEye.x + rightEye.x) / 2, y: (leftEye.y + rightEye.y) / 2 };
  const angleDegrees = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x) * 180 / Math.PI;
  const rotationDegrees = -angleDegrees;
  const eyeDistance = distance(leftEye, rightEye);
  const targetFaceWidth = numberFromEnv("FACEREEL_TARGET_FACE_WIDTH", TARGET_FACE_WIDTH);
  const targetEyeY = numberFromEnv("FACEREEL_TARGET_EYE_Y", TARGET_EYE_Y);
  const targetScale = targetFaceWidth / Math.max(1, detection.box.width);
  const maxRotation = numberFromEnv("FACEREEL_MAX_ALIGNMENT_ROTATION", MAX_ALIGNMENT_ROTATION_DEGREES);
  const minScale = numberFromEnv("FACEREEL_MIN_ALIGNMENT_SCALE", MIN_ALIGNMENT_SCALE);
  const maxScale = numberFromEnv("FACEREEL_MAX_ALIGNMENT_SCALE", MAX_ALIGNMENT_SCALE);
  const rotated = rotatedGeometry(width, height, rotationDegrees);
  const rotatedEyeMid = rotatePointInExpandedCanvas(eyeMid, width, height, rotationDegrees, rotated);
  const scale = targetScale;

  if (Math.abs(rotationDegrees) > maxRotation) {
    throw new Error(`face requires ${Math.abs(rotationDegrees).toFixed(1)}deg rotation`);
  }
  if (scale < minScale || scale > maxScale) {
    throw new Error(`face scale ${scale.toFixed(2)} is outside usable range`);
  }

  const scaled = {
    width: Math.max(1, Math.ceil(rotated.width * scale)),
    height: Math.max(1, Math.ceil(rotated.height * scale))
  };
  const placement = {
    left: Math.round(WIDTH / 2 - rotatedEyeMid.x * scale),
    top: Math.round(targetEyeY - rotatedEyeMid.y * scale),
    width: scaled.width,
    height: scaled.height
  };
  const visible = visibleRect(placement, WIDTH, HEIGHT);

  if (visible.width < WIDTH * 0.42) {
    throw new Error("aligned image has too little horizontal coverage");
  }
  if (visible.height < HEIGHT * 0.34) {
    throw new Error("aligned image has too little vertical coverage");
  }

  const visibleImage = await sharp(sourcePath)
    .rotate()
    .rotate(rotationDegrees, { background: { r: 12, g: 12, b: 14, alpha: 1 } })
    .resize(scaled.width, scaled.height, { fit: "fill" })
    .extract({
      left: visible.sourceLeft,
      top: visible.sourceTop,
      width: visible.width,
      height: visible.height
    })
    .toBuffer();

  await sharp({
    create: {
      width: WIDTH,
      height: HEIGHT,
      channels: 3,
      background: { r: 0, g: 0, b: 0 }
    }
  })
    .composite([
      { input: visibleImage, left: visible.outputLeft, top: visible.outputTop },
      watermarkOverlay()
    ])
    .jpeg({ quality: 90, mozjpeg: true })
    .toFile(outputPath);

  try {
    await assertOutputFrameAlignment(outputPath);
  } catch (error) {
    await rm(outputPath, { force: true });
    throw error;
  }

  return {
    rotationDegrees,
    scale,
    eyeDistance,
    placement
  };
}

async function assertOutputFrameAlignment(framePath: string): Promise<void> {
  const detections = await detectFaces(framePath);
  const detection = detections.sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0];
  if (!detection) throw new Error("aligned frame has no detectable face");

  const leftEye = averagePoint(detection.landmarks.positions.slice(36, 42));
  const rightEye = averagePoint(detection.landmarks.positions.slice(42, 48));
  const eyeMid = { x: (leftEye.x + rightEye.x) / 2, y: (leftEye.y + rightEye.y) / 2 };
  const eyeDeltaY = Math.abs(rightEye.y - leftEye.y);
  const faceCenterX = detection.box.x + detection.box.width / 2;

  if (Math.abs(eyeMid.x - WIDTH / 2) > 70) throw new Error("aligned frame eye center is too far from horizontal center");
  if (Math.abs(eyeMid.y - TARGET_EYE_Y) > 90) throw new Error("aligned frame eye line is too far from target height");
  if (Math.abs(faceCenterX - WIDTH / 2) > 130) throw new Error("aligned frame face is too far from horizontal center");
  if (eyeDeltaY > 22) throw new Error("aligned frame eyes are not level");
  if (detection.box.width < 190 || detection.box.width > 560) throw new Error("aligned frame face size is outside usable range");
}

async function renderVideo(framePaths: string[], outputVideo: string): Promise<void> {
  const tempDir = path.join(path.dirname(outputVideo), ".video-input");
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });
  try {
    let frameIndex = 0;
    const repeats = Math.max(1, Math.round(FPS * FRAME_HOLD_SECONDS));
    for (const framePath of framePaths) {
      for (let repeat = 0; repeat < repeats; repeat += 1) {
        await sharp(framePath).toFile(path.join(tempDir, `frame-${String(frameIndex).padStart(6, "0")}.jpg`));
        frameIndex += 1;
      }
    }
    await runFfmpeg([
      "-y",
      "-hide_banner",
      "-loglevel", "warning",
      "-framerate", String(FPS),
      "-i", path.join(tempDir, "frame-%06d.jpg"),
      "-an",
      "-c:v", "libx264",
      "-profile:v", "high",
      "-level", "4.1",
      "-pix_fmt", "yuv420p",
      "-r", String(FPS),
      "-movflags", "+faststart",
      "-preset", "medium",
      "-crf", "20",
      outputVideo
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runFfmpeg(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const message = Buffer.concat(stderr).toString("utf8").trim();
      reject(new Error(`ffmpeg exited with code ${code}${message ? `: ${message}` : ""}`));
    });
  });
}

async function loadFaceModels(): Promise<{ faceapi: typeof import("@vladmandic/face-api"); tf: typeof import("@tensorflow/tfjs-node") }> {
  const faceapi = faceapiModule ?? await import("@vladmandic/face-api");
  const tf = tfModule ?? await import("@tensorflow/tfjs-node");
  faceapiModule = faceapi;
  tfModule = tf;
  if (modelsLoaded) return { faceapi, tf };
  const modelDir = process.env.FACEAPI_MODEL_DIR || path.resolve(process.cwd(), "models", "face-api");
  if (!existsSync(modelDir)) {
    throw new Error(`Face API model directory not found: ${modelDir}. Set FACEAPI_MODEL_DIR or place models under models/face-api.`);
  }
  await Promise.all([
    faceapi.nets.ssdMobilenetv1.loadFromDisk(modelDir),
    faceapi.nets.faceLandmark68Net.loadFromDisk(modelDir),
    faceapi.nets.faceRecognitionNet.loadFromDisk(modelDir)
  ]);
  modelsLoaded = true;
  return { faceapi, tf };
}

function averagePoint(points: Point[]): Point {
  if (!points.length) return { x: 0, y: 0 };
  const total = points.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
  return { x: total.x / points.length, y: total.y / points.length };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function watermarkOverlay(): sharp.OverlayOptions {
  const width = 370;
  const height = 92;
  const svg = `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${width}" height="${height}" rx="28" fill="rgba(0,0,0,0.42)"/>
      <text x="${width / 2}" y="58" text-anchor="middle"
        font-family="Inter, Arial, sans-serif" font-size="34" font-weight="800"
        fill="rgba(255,255,255,0.90)" letter-spacing="0">${WATERMARK_TEXT}</text>
    </svg>
  `;
  return {
    input: Buffer.from(svg),
    left: WIDTH - width - 42,
    top: HEIGHT - height - 48
  };
}

async function imageScale(fromPath: string, toPath: string): Promise<{ x: number; y: number }> {
  const [fromMetadata, toMetadata] = await Promise.all([
    sharp(fromPath).rotate().metadata(),
    sharp(toPath).rotate().metadata()
  ]);
  const fromWidth = fromMetadata.width || 1;
  const fromHeight = fromMetadata.height || 1;
  const toWidth = toMetadata.width || fromWidth;
  const toHeight = toMetadata.height || fromHeight;
  return {
    x: toWidth / fromWidth,
    y: toHeight / fromHeight
  };
}

function scaleDetection(detection: Detection, scale: { x: number; y: number }): Detection {
  return {
    descriptor: detection.descriptor,
    box: {
      x: detection.box.x * scale.x,
      y: detection.box.y * scale.y,
      width: detection.box.width * scale.x,
      height: detection.box.height * scale.y
    },
    landmarks: {
      positions: detection.landmarks.positions.map((point) => ({
        x: point.x * scale.x,
        y: point.y * scale.y
      }))
    }
  };
}

function rotatedGeometry(width: number, height: number, angleDegrees: number): { width: number; height: number; minX: number; minY: number } {
  const corners = [
    rotateAroundCenter({ x: 0, y: 0 }, width, height, angleDegrees),
    rotateAroundCenter({ x: width, y: 0 }, width, height, angleDegrees),
    rotateAroundCenter({ x: width, y: height }, width, height, angleDegrees),
    rotateAroundCenter({ x: 0, y: height }, width, height, angleDegrees)
  ];
  const minX = Math.min(...corners.map((point) => point.x));
  const maxX = Math.max(...corners.map((point) => point.x));
  const minY = Math.min(...corners.map((point) => point.y));
  const maxY = Math.max(...corners.map((point) => point.y));
  return {
    width: Math.ceil(maxX - minX),
    height: Math.ceil(maxY - minY),
    minX,
    minY
  };
}

function rotatePointInExpandedCanvas(point: Point, width: number, height: number, angleDegrees: number, rotated = rotatedGeometry(width, height, angleDegrees)): Point {
  const rotatedPoint = rotateAroundCenter(point, width, height, angleDegrees);
  return {
    x: rotatedPoint.x - rotated.minX,
    y: rotatedPoint.y - rotated.minY
  };
}

function rotateAroundCenter(point: Point, width: number, height: number, angleDegrees: number): Point {
  const radians = angleDegrees * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const center = { x: width / 2, y: height / 2 };
  const x = point.x - center.x;
  const y = point.y - center.y;
  return {
    x: center.x + x * cos - y * sin,
    y: center.y + x * sin + y * cos
  };
}

function visibleRect(
  placement: { left: number; top: number; width: number; height: number },
  outputWidth: number,
  outputHeight: number
): { sourceLeft: number; sourceTop: number; outputLeft: number; outputTop: number; width: number; height: number } {
  const outputLeft = Math.max(0, placement.left);
  const outputTop = Math.max(0, placement.top);
  const sourceLeft = Math.max(0, -placement.left);
  const sourceTop = Math.max(0, -placement.top);
  const right = Math.min(outputWidth, placement.left + placement.width);
  const bottom = Math.min(outputHeight, placement.top + placement.height);
  return {
    sourceLeft,
    sourceTop,
    outputLeft,
    outputTop,
    width: Math.max(0, right - outputLeft),
    height: Math.max(0, bottom - outputTop)
  };
}

function numberFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name] || "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
