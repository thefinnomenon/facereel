import { readdirSync } from "node:fs";
import path from "node:path";
import { detectFaces } from "../packages/worker/src/facereel.ts";

const jobId = process.argv[2];
if (!jobId) throw new Error("Usage: npx tsx scripts/check-frame-alignment.ts <job-id>");

const framesDir = path.resolve("storage", "jobs", jobId, "frames");
const frames = readdirSync(framesDir)
  .filter((name) => name.endsWith(".jpg"))
  .sort()
  .map((name) => path.join(framesDir, name));

const measurements = [];
for (const frame of frames) {
  const detections = await detectFaces(frame);
  const detection = detections.sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0];
  if (!detection) {
    measurements.push({ frame: path.basename(frame), detected: false });
    continue;
  }
  const leftEye = averagePoint(detection.landmarks.positions.slice(36, 42));
  const rightEye = averagePoint(detection.landmarks.positions.slice(42, 48));
  measurements.push({
    frame: path.basename(frame),
    detected: true,
    eyeCenterX: Math.round((leftEye.x + rightEye.x) / 2),
    eyeCenterY: Math.round((leftEye.y + rightEye.y) / 2),
    eyeDeltaY: Number(Math.abs(rightEye.y - leftEye.y).toFixed(1)),
    faceCenterX: Math.round(detection.box.x + detection.box.width / 2),
    faceCenterY: Math.round(detection.box.y + detection.box.height / 2),
    faceWidth: Math.round(detection.box.width)
  });
}

const detected = measurements.filter((item) => item.detected);
const summary = {
  frames: frames.length,
  detected: detected.length,
  averageEyeCenterX: average(detected.map((item) => item.eyeCenterX)),
  averageEyeCenterY: average(detected.map((item) => item.eyeCenterY)),
  maxEyeDeltaY: max(detected.map((item) => item.eyeDeltaY)),
  averageFaceCenterX: average(detected.map((item) => item.faceCenterX)),
  averageFaceWidth: average(detected.map((item) => item.faceWidth)),
  undetectedFrames: measurements.filter((item) => !item.detected).map((item) => item.frame)
};

console.log(JSON.stringify({ summary, sample: measurements.slice(0, 5) }, null, 2));

function averagePoint(points: Array<{ x: number; y: number }>): { x: number; y: number } {
  const total = points.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
  return { x: total.x / points.length, y: total.y / points.length };
}

function average(values: unknown[]): number | null {
  const numeric = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!numeric.length) return null;
  return Math.round(numeric.reduce((sum, value) => sum + value, 0) / numeric.length);
}

function max(values: unknown[]): number | null {
  const numeric = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!numeric.length) return null;
  return Math.max(...numeric);
}
