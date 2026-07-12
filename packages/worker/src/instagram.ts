import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import sharp from "sharp";
import { sanitizeInstagramUsername } from "./validation.ts";

const DEFAULT_SCAN_DOWNLOAD_CONCURRENCY = 6;
const DEFAULT_SOURCE_DOWNLOAD_CONCURRENCY = 3;
const DEFAULT_SCAN_LONG_EDGE = 768;
let localEnvLoaded = false;

export type InstagramCheckResult = {
  username: string;
  exists: boolean;
  is_public: boolean;
  estimated_photo_count: number;
  warnings: string[];
  errors: string[];
};

export type InstagramMediaItem = {
  id: string;
  scanUrl: string;
  sourceUrl: string;
  takenAt: number | null;
  width: number | null;
  height: number | null;
};

export type LocalScanImage = InstagramMediaItem & {
  scanPath: string;
};

export type LocalSourceImage = LocalScanImage & {
  sourcePath: string;
};

export type InstagramProgressEvent = {
  stage: string;
  progress: number;
  downloaded_count?: number;
  total_count?: number;
};

type JsonObject = Record<string, unknown>;

export async function checkInstagramProfile(usernameInput: string): Promise<InstagramCheckResult> {
  const username = sanitizeInstagramUsername(usernameInput);
  const payload = await rapidApiPost("profile", { username });
  const result = objectValue(payload.result);

  if (!result || !result.username) {
    return {
      username,
      exists: false,
      is_public: false,
      estimated_photo_count: 0,
      warnings: ["RapidAPI returned no profile for this username."],
      errors: []
    };
  }

  const timelineMedia = objectValue(result.edge_owner_to_timeline_media);
  return {
    username: String(result.username || username),
    exists: true,
    is_public: !Boolean(result.is_private),
    estimated_photo_count: numberValue(timelineMedia?.count),
    warnings: ["RapidAPI profile check validates visibility only; media is counted during job processing."],
    errors: []
  };
}

export async function buildInstagramMediaManifest(input: {
  username: string;
  maxImages?: number;
  onProgress?: (event: InstagramProgressEvent) => void;
}): Promise<{ items: InstagramMediaItem[]; warnings: string[]; oldest_image_post_at: string | null; newest_image_post_at: string | null }> {
  const username = sanitizeInstagramUsername(input.username);
  const warnings: string[] = [];
  const items: InstagramMediaItem[] = [];
  const seen = new Set<string>();
  let maxId = "";
  let pagesChecked = 0;

  while (true) {
    if (input.maxImages && items.length >= input.maxImages) break;
    pagesChecked += 1;
    input.onProgress?.({ stage: "Finding photos", progress: Math.min(0.95, pagesChecked * 0.08), total_count: items.length });

    const payload = await rapidApiPost("posts", { username, maxId });
    const pageItems = mediaItemsFromPostsPayload(payload);
    if (pageItems.length === 0) warnings.push("RapidAPI returned no image media on a page.");

    for (const item of pageItems) {
      if (input.maxImages && items.length >= input.maxImages) break;
      if (seen.has(item.sourceUrl)) continue;
      seen.add(item.sourceUrl);
      items.push({ ...item, id: `ig-${String(items.length).padStart(5, "0")}` });
    }

    const nextCursor = nextCursorFromPostsPayload(payload);
    if (!nextCursor || nextCursor === maxId) break;
    maxId = nextCursor;
  }

  const takenAt = items.map((item) => item.takenAt).filter((value): value is number => typeof value === "number");
  return {
    items,
    warnings,
    oldest_image_post_at: takenAt.length ? isoFromUnix(Math.min(...takenAt)) : null,
    newest_image_post_at: takenAt.length ? isoFromUnix(Math.max(...takenAt)) : null
  };
}

export async function downloadScanImages(input: {
  items: InstagramMediaItem[];
  outputDir: string;
  scanLongEdge?: number;
  onProgress?: (event: InstagramProgressEvent) => void;
}): Promise<{ images: LocalScanImage[]; skipped_count: number; errors: string[] }> {
  await mkdir(input.outputDir, { recursive: true });
  const scanLongEdge = input.scanLongEdge ?? DEFAULT_SCAN_LONG_EDGE;
  const output = new Array<LocalScanImage | null>(input.items.length).fill(null);
  const errors: string[] = [];
  let completed = 0;
  let skipped = 0;

  input.onProgress?.({ stage: "Scanning faces", progress: 0, total_count: input.items.length });
  await mapConcurrent(input.items, Math.min(downloadConcurrency("FACEREEL_SCAN_DOWNLOAD_CONCURRENCY", DEFAULT_SCAN_DOWNLOAD_CONCURRENCY), Math.max(1, input.items.length)), async (item, index) => {
    try {
      const scanPath = path.join(input.outputDir, `${item.id}-scan.jpg`);
      await downloadImage(item.scanUrl, scanPath, { longEdge: scanLongEdge, quality: 86 });
      output[index] = { ...item, scanPath };
    } catch (error) {
      skipped += 1;
      errors.push(`Skipped scan image: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      completed += 1;
      input.onProgress?.({
        stage: "Scanning faces",
        progress: completed / Math.max(1, input.items.length),
        downloaded_count: output.filter(Boolean).length,
        total_count: input.items.length
      });
    }
  });

  return { images: output.filter((item): item is LocalScanImage => Boolean(item)), skipped_count: skipped, errors: limitErrors(errors) };
}

export async function downloadSourceImages(input: {
  items: LocalScanImage[];
  outputDir: string;
  onProgress?: (event: InstagramProgressEvent) => void;
}): Promise<{ images: LocalSourceImage[]; skipped_count: number; errors: string[] }> {
  await mkdir(input.outputDir, { recursive: true });
  const output = new Array<LocalSourceImage | null>(input.items.length).fill(null);
  const errors: string[] = [];
  let completed = 0;
  let skipped = 0;

  input.onProgress?.({ stage: "Downloading matches", progress: 0, total_count: input.items.length });
  await mapConcurrent(input.items, Math.min(downloadConcurrency("FACEREEL_SOURCE_DOWNLOAD_CONCURRENCY", DEFAULT_SOURCE_DOWNLOAD_CONCURRENCY), Math.max(1, input.items.length)), async (item, index) => {
    try {
      const sourcePath = path.join(input.outputDir, `${item.id}-source.jpg`);
      await downloadImage(item.sourceUrl, sourcePath, { quality: 92 });
      output[index] = { ...item, sourcePath };
    } catch (error) {
      skipped += 1;
      errors.push(`Skipped high-res image: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      completed += 1;
      input.onProgress?.({
        stage: "Downloading matches",
        progress: completed / Math.max(1, input.items.length),
        downloaded_count: output.filter(Boolean).length,
        total_count: input.items.length
      });
    }
  });

  return { images: output.filter((item): item is LocalSourceImage => Boolean(item)), skipped_count: skipped, errors: limitErrors(errors) };
}

async function downloadImage(url: string, destination: string, options: { longEdge?: number; quality: number }): Promise<void> {
  const response = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; FaceReel/0.1; +https://facereel.local)",
      "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
    }
  }, 30_000);
  if (!response.ok) throw new Error(`Image request failed with HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  let pipeline = sharp(bytes).rotate();
  if (options.longEdge) {
    pipeline = pipeline.resize(options.longEdge, options.longEdge, { fit: "inside", withoutEnlargement: true });
  }
  await pipeline.jpeg({ quality: options.quality, mozjpeg: true }).toFile(destination);
}

function mediaItemsFromPostsPayload(payload: JsonObject): InstagramMediaItem[] {
  const result = objectValue(payload.result);
  const edges = arrayValue(result?.edges);
  const items: InstagramMediaItem[] = [];
  const seen = new Set<string>();

  for (const edge of edges) {
    const node = objectValue(objectValue(edge)?.node);
    if (!node) continue;
    const nodeTakenAt = takenAtFromMedia(node);
    const carousel = arrayValue(node.carousel_media);
    const media = carousel.length ? carousel : [node];

    for (const entry of media) {
      const mediaNode = objectValue(entry);
      if (!mediaNode || isVideoMedia(mediaNode)) continue;
      const urls = mediaUrls(mediaNode);
      if (!urls || seen.has(urls.sourceUrl)) continue;
      seen.add(urls.sourceUrl);
      items.push({
        id: "",
        ...urls,
        takenAt: takenAtFromMedia(mediaNode, nodeTakenAt),
        width: numberValue(mediaNode.original_width) || null,
        height: numberValue(mediaNode.original_height) || null
      });
    }
  }
  return items;
}

function mediaUrls(item: JsonObject): { scanUrl: string; sourceUrl: string } | null {
  const candidates = arrayValue(objectValue(item.image_versions2)?.candidates)
    .map((candidate) => objectValue(candidate))
    .filter((candidate): candidate is JsonObject => candidate !== null && typeof candidate.url === "string");
  if (!candidates.length) return null;

  const byArea = [...candidates].sort((a, b) => candidateArea(a) - candidateArea(b));
  const useful = byArea.find((candidate) => Math.max(numberValue(candidate.width), numberValue(candidate.height)) >= 640) ?? byArea.at(-1);
  const source = [...candidates].sort((a, b) => candidateArea(b) - candidateArea(a))[0];
  if (!useful || !source) return null;
  return { scanUrl: String(useful.url), sourceUrl: String(source.url) };
}

function candidateArea(candidate: JsonObject): number {
  return numberValue(candidate.width) * numberValue(candidate.height);
}

function nextCursorFromPostsPayload(payload: JsonObject): string | null {
  const pageInfo = objectValue(objectValue(payload.result)?.page_info);
  if (!pageInfo?.has_next_page) return null;
  return typeof pageInfo.end_cursor === "string" && pageInfo.end_cursor ? pageInfo.end_cursor : null;
}

function isVideoMedia(item: JsonObject): boolean {
  if (String(item.media_type) === "2") return true;
  if (["clips", "igtv", "reels", "reel"].includes(String(item.product_type || ""))) return true;
  if (arrayValue(item.video_versions).length > 0) return true;
  return Boolean(item.video_dash_manifest);
}

function takenAtFromMedia(item: JsonObject, fallback: number | null = null): number | null {
  const raw = item.taken_at ?? item.taken_at_timestamp ?? item.device_timestamp ?? fallback;
  const value = numberValue(raw);
  if (!value) return null;
  return value > 10_000_000_000 ? Math.floor(value / 1_000_000) : value;
}

async function rapidApiPost(endpoint: "profile" | "posts", body: JsonObject): Promise<JsonObject> {
  loadLocalEnv();
  const host = process.env.INSTAGRAM_RAPIDAPI_HOST || "instagram120.p.rapidapi.com";
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchWithTimeout(`https://${host}/api/instagram/${endpoint}`, {
        method: "POST",
        headers: {
          "x-rapidapi-key": rapidApiKey(),
          "x-rapidapi-host": host,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      }, 45_000);

      if (response.status >= 500 && attempt < 2) {
        await sleep(1_000 + attempt * 1_000);
        continue;
      }
      if (!response.ok) {
        const responseBody = (await response.text()).slice(0, 500).replace(/\n/g, " ");
        throw new Error(`RapidAPI request failed with HTTP ${response.status}: ${responseBody}`);
      }
      const payload = await response.json();
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("RapidAPI returned an unexpected response shape.");
      }
      return payload as JsonObject;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(1_000 + attempt * 1_000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function rapidApiKey(): string {
  loadLocalEnv();
  const key = process.env.INSTAGRAM_RAPIDAPI_KEY || process.env.RAPIDAPI_KEY;
  if (!key) throw new Error("INSTAGRAM_RAPIDAPI_KEY or RAPIDAPI_KEY is required.");
  return key;
}

function loadLocalEnv(): void {
  if (localEnvLoaded) return;
  localEnvLoaded = true;

  for (const envPath of [path.resolve(process.cwd(), ".env"), path.resolve(process.cwd(), "../.env")]) {
    if (existsSync(envPath)) loadDotenv({ path: envPath });
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function mapConcurrent<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index]!, index);
    }
  });
  await Promise.all(workers);
}

function limitErrors(errors: string[]): string[] {
  if (errors.length <= 10) return errors;
  return [...errors.slice(0, 10), `Suppressed ${errors.length - 10} additional errors.`];
}

function downloadConcurrency(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberValue(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoFromUnix(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
