import "dotenv/config";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { mockGenerateFaceReel } from "../packages/worker/src/facereel.ts";

const outputDir = path.resolve("tmp", "test", "facereel");
await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

const result = await mockGenerateFaceReel({
  outputDir,
  onProgress(event) {
    console.log(`progress: ${Math.round(event.progress * 100)}% ${event.stage}`);
  }
});

console.log(`video: ${result.videoPath}`);
console.log(`poster: ${result.posterPath}`);
console.log(`frames: ${result.framePaths.length}`);
