import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  findMostFrequentFace,
  generateFaceReel,
} from "../packages/worker/src/facereel.ts";
import {
  buildInstagramMediaManifest,
  downloadScanImages,
  downloadSourceImages,
  getInstagramProfileIdentity,
} from "../packages/worker/src/instagram.ts";
import { sanitizeInstagramUsername } from "../packages/worker/src/validation.ts";

const GRAPH_API_VERSION = "v24.0";
const configPath = path.resolve("marketing/campaign.json");
const statePath = path.resolve("marketing/campaign-state.json");
const lockPath = path.resolve("marketing/campaign.lock");
const dryRun = process.argv.includes("--dry-run");

type Creator = {
  username: string;
  instagramUserId?: string;
  targetFace?: string;
  caption?: string;
  enabled?: boolean;
};

type InstagramUserTag = {
  user_id: string;
  x: number;
  y: number;
};

type Config = {
  captionTemplate: string;
  creators: Creator[];
};

type CreatorState = {
  stage: "new" | "rendered" | "reel-posted" | "done";
  outputDir?: string;
  reelContainerId?: string;
  reelMediaId?: string;
  storyContainerId?: string;
  storyMediaId?: string;
  instagramUserId?: string;
};

type State = { creators: Record<string, CreatorState> };

const lock = await acquireLock();
try {
  const config = await readJson<Config>(configPath);
  const state = await readState();
  const creator = config.creators.find((item) => {
    if (item.enabled === false) return false;
    const username = sanitizeInstagramUsername(item.username).toLowerCase();
    return state.creators[username]?.stage !== "done";
  });

  if (!creator) {
    console.log("Campaign queue is empty.");
    process.exitCode = 0;
  } else {
    creator.username = sanitizeInstagramUsername(creator.username);
    const key = creator.username.toLowerCase();
    const creatorState = state.creators[key] ?? { stage: "new" };
    state.creators[key] = creatorState;

    const outputDir = creatorState.outputDir
      ?? path.resolve("marketing", "output", creator.username);
    creatorState.outputDir = outputDir;
    await mkdir(outputDir, { recursive: true });
    await saveState(state);

    if (creatorState.stage === "new") {
      await renderCreator(creator, config, outputDir);
      creatorState.stage = "rendered";
      await saveState(state);
    }

    if (dryRun) {
      console.log(`Preview ready: ${path.join(outputDir, "instagram-reel.mp4")}`);
      console.log("Run without --dry-run to post it.");
    } else {
      const accessToken = requiredEnv("INSTAGRAM_PUBLISH_ACCESS_TOKEN");
      const igUserId = requiredEnv("INSTAGRAM_PUBLISH_USER_ID");
      creatorState.instagramUserId ??= creator.instagramUserId
        ?? (await getInstagramProfileIdentity(creator.username)).userId;
      await saveState(state);
      const mediaServer = await startMediaServer(outputDir);
      const tunnel = await startTunnel(mediaServer.port);

      try {
        if (creatorState.stage === "rendered") {
          creatorState.reelContainerId ??= await createContainer({
            accessToken,
            igUserId,
            mediaType: "REELS",
            videoUrl: `${tunnel.url}/instagram-reel.mp4`,
            caption: (creator.caption ?? config.captionTemplate)
              .replaceAll("{username}", creator.username),
          });
          await saveState(state);
          await waitForContainer(creatorState.reelContainerId, accessToken);
          creatorState.reelMediaId = await publishContainer(
            creatorState.reelContainerId,
            igUserId,
            accessToken,
          );
          creatorState.stage = "reel-posted";
          await saveState(state);
          console.log(`Posted Reel ${creatorState.reelMediaId}.`);
        }

        if (creatorState.stage === "reel-posted") {
          creatorState.storyContainerId ??= await createContainer({
            accessToken,
            igUserId,
            mediaType: "STORIES",
            videoUrl: `${tunnel.url}/instagram-story.mp4`,
            userTags: [storyMention(creator.username, creatorState.instagramUserId)],
          });
          await saveState(state);
          await waitForContainer(creatorState.storyContainerId, accessToken);
          creatorState.storyMediaId = await publishContainer(
            creatorState.storyContainerId,
            igUserId,
            accessToken,
          );
          creatorState.stage = "done";
          await saveState(state);
          console.log(`Posted Story ${creatorState.storyMediaId}.`);
        }
      } finally {
        tunnel.process.kill();
        await new Promise<void>((resolve) => mediaServer.server.close(() => resolve()));
      }
    }
  }
} finally {
  await lock.close();
  await rm(lockPath, { force: true });
}

async function renderCreator(
  creator: Creator,
  config: Config,
  outputDir: string,
): Promise<void> {
  console.log(`Creating FaceReel for @${creator.username}...`);
  const manifest = await buildInstagramMediaManifest({
    username: creator.username,
    maxImages: positiveInteger(process.env.FACEREEL_MAX_IMAGES, 500),
    onProgress: (event) => progress(event.stage, event.progress),
  });
  if (manifest.items.length < 4) {
    throw new Error(`@${creator.username} has only ${manifest.items.length} usable photos.`);
  }

  const scans = await downloadScanImages({
    items: manifest.items,
    outputDir: path.join(outputDir, "scans"),
    onProgress: (event) => progress(event.stage, event.progress),
  });
  let targetFace = creator.targetFace
    ? path.resolve("marketing", creator.targetFace)
    : path.join(outputDir, "target.jpg");
  if (!creator.targetFace) {
    const selection = await findMostFrequentFace({
      scanImages: scans.images,
      targetPath: targetFace,
      onProgress: (event) => progress(event.stage, event.progress),
    });
    targetFace = selection.targetPath;
    console.log(
      `Selected the dominant face: ${selection.appearances}/${selection.scannedPhotos} photos `
      + `(${selection.clusterCount} distinct face clusters).`,
    );
  }

  const result = await generateFaceReel({
    targetPath: targetFace,
    scanImages: scans.images,
    outputDir: path.join(outputDir, "render"),
    sourceDownloader: (matches) => downloadSourceImages({
      items: matches,
      outputDir: path.join(outputDir, "sources"),
      onProgress: (event) => progress(event.stage, event.progress),
    }),
    onProgress: (event) => progress(event.stage, event.progress),
  });

  await prepareInstagramVideos(result.videoPath, outputDir);
}

async function prepareInstagramVideos(
  sourceVideo: string,
  outputDir: string,
): Promise<void> {
  const sourceDuration = Number.parseFloat((await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    sourceVideo,
  ])).trim());
  const duration = Math.max(3.1, sourceDuration);
  const reelPath = path.join(outputDir, "instagram-reel.mp4");
  const storyPath = path.join(outputDir, "instagram-story.mp4");

  await run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "warning",
    "-stream_loop", "-1", "-i", sourceVideo,
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-t", duration.toFixed(3),
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30",
    "-movflags", "+faststart", "-c:a", "aac", "-b:a", "128k",
    "-shortest", reelPath,
  ]);

  await copyFile(reelPath, storyPath);
}

async function startMediaServer(directory: string): Promise<{ server: Server; port: number }> {
  const server = createServer(async (request, response) => {
    const filename = request.url === "/instagram-story.mp4"
      ? "instagram-story.mp4"
      : request.url === "/instagram-reel.mp4"
        ? "instagram-reel.mp4"
        : null;
    if (!filename) {
      response.writeHead(404).end();
      return;
    }
    const bytes = await readFile(path.join(directory, filename));
    response.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": String(bytes.length),
      "Cache-Control": "public, max-age=3600",
    });
    response.end(request.method === "HEAD" ? undefined : bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start media server.");
  return { server, port: address.port };
}

async function startTunnel(port: number): Promise<{ process: ChildProcess; url: string }> {
  const process = spawn("ssh", [
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ServerAliveInterval=30",
    "-R", `80:127.0.0.1:${port}`,
    "nokey@localhost.run",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Media tunnel did not start.")), 60_000);
    const inspectOutput = (chunk: Buffer) => {
      const publicUrl = chunk.toString("utf8")
        .match(/https:\/\/[a-z0-9-]+\.lhr\.life/)?.[0];
      if (!publicUrl) return;
      clearTimeout(timeout);
      resolve(publicUrl);
    };
    process.once("error", reject);
    process.once("exit", (code) => {
      reject(new Error(`Media tunnel exited with code ${String(code)}.`));
    });
    process.stdout?.on("data", inspectOutput);
    process.stderr?.on("data", inspectOutput);
  });
  await waitForPublicMedia(`${url}/instagram-reel.mp4`);
  return { process, url };
}

async function waitForPublicMedia(url: string): Promise<void> {
  let lastStatus = "unreachable";
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      await run("curl", [
        "--silent", "--show-error", "--fail",
        "--head", "--max-time", "10", url,
      ]);
      return;
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Media tunnel did not serve the Reel: ${lastStatus}`);
}

async function createContainer(input: {
  accessToken: string;
  igUserId: string;
  mediaType: "REELS" | "STORIES";
  videoUrl: string;
  caption?: string;
  userTags?: InstagramUserTag[];
}): Promise<string> {
  const body = new URLSearchParams({
    media_type: input.mediaType,
    video_url: input.videoUrl,
    ...(input.caption ? { caption: input.caption, share_to_feed: "true" } : {}),
    ...(input.userTags?.length ? { user_tags: JSON.stringify(input.userTags) } : {}),
  });
  const result = await graphRequest(
    `/${input.igUserId}/media`,
    input.accessToken,
    { method: "POST", body },
  );
  return stringField(result, "id");
}

function storyMention(username: string, instagramUserId: string): InstagramUserTag {
  if (!/^\d+$/.test(instagramUserId)) {
    throw new Error(`@${username} needs a numeric Instagram user ID.`);
  }
  return {
    user_id: instagramUserId,
    x: 0.5,
    y: 0.13,
  };
}

async function waitForContainer(containerId: string, accessToken: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await graphRequest(
      `/${containerId}?fields=status_code,status`,
      accessToken,
    );
    if (result.status_code === "FINISHED") return;
    if (result.status_code === "ERROR" || result.status_code === "EXPIRED") {
      throw new Error(`Instagram rejected the video: ${String(result.status ?? result.status_code)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error("Instagram did not finish processing the video.");
}

async function publishContainer(
  containerId: string,
  igUserId: string,
  accessToken: string,
): Promise<string> {
  const result = await graphRequest(
    `/${igUserId}/media_publish`,
    accessToken,
    { method: "POST", body: new URLSearchParams({ creation_id: containerId }) },
  );
  return stringField(result, "id");
}

async function graphRequest(
  pathname: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(
    `https://graph.instagram.com/${GRAPH_API_VERSION}${pathname}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
    },
  );
  const payload: unknown = await response.json();
  if (!response.ok) {
    const error = objectValue(objectValue(payload)?.error);
    throw new Error(String(error?.message ?? `Instagram returned HTTP ${response.status}`));
  }
  const object = objectValue(payload);
  if (!object) throw new Error("Instagram returned an invalid response.");
  return object;
}

async function readState(): Promise<State> {
  try {
    return await readJson<State>(statePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { creators: {} };
    throw error;
  }
}

async function saveState(state: State): Promise<void> {
  const temporary = `${statePath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, statePath);
}

async function readJson<T>(filename: string): Promise<T> {
  return JSON.parse(await readFile(filename, "utf8")) as T;
}

async function acquireLock() {
  try {
    return await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const age = Date.now() - (await stat(lockPath)).mtimeMs;
      if (age > 3_600_000) {
        await rm(lockPath, { force: true });
        return open(lockPath, "wx", 0o600);
      }
      throw new Error("Another campaign run is already active.");
    }
    throw error;
  }
}

async function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve(Buffer.concat(stdout).toString("utf8"))
      : reject(new Error(`${command} failed: ${Buffer.concat(stderr).toString("utf8").trim()}`)));
  });
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is missing from .env.`);
  return value;
}

function stringField(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  if (typeof value !== "string" || !value) throw new Error(`Instagram response is missing ${key}.`);
  return value;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function progress(stage: string, value: number): void {
  console.log(`${stage}: ${Math.round(value * 100)}%`);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
