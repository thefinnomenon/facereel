import "dotenv/config";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { buildInstagramMediaManifest, downloadScanImages } from "../packages/worker/src/instagram.ts";
import { sanitizeInstagramUsername } from "../packages/worker/src/validation.ts";

const username = process.argv[2];
if (!username) {
  console.error("Usage: npm run test:download -- username");
  process.exit(1);
}

const cleanUsername = sanitizeInstagramUsername(username);
const outputDir = path.resolve("tmp", "test", cleanUsername, "scans");
await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

const started = Date.now();
const manifest = await buildInstagramMediaManifest({
  username: cleanUsername,
  maxImages: 20,
  onProgress(event) {
    console.log(`manifest: ${Math.round(event.progress * 100)}% ${event.total_count ?? 0}`);
  }
});
const result = await downloadScanImages({
  items: manifest.items,
  outputDir,
  onProgress(event) {
    console.log(`download: ${Math.round(event.progress * 100)}% ${event.stage}${typeof event.downloaded_count === "number" ? ` (${event.downloaded_count})` : ""}`);
  }
});

console.log(`manifest_items: ${manifest.items.length}`);
console.log(`scans_downloaded: ${result.images.length}`);
console.log(`skipped: ${result.skipped_count}`);
console.log(`processing_time_seconds: ${((Date.now() - started) / 1000).toFixed(2)}`);
console.log(`location: ${outputDir}`);
if (manifest.warnings.length) console.log(`warnings: ${manifest.warnings.join("; ")}`);
if (result.errors.length) console.log(`errors: ${result.errors.slice(0, 5).join("; ")}`);
