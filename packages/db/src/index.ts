import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type JobStatus = "queued" | "processing" | "completed" | "failed";

export type JobStep =
  | "Job created"
  | "Instagram verified"
  | "Finding photos"
  | "Scanning faces"
  | "Downloading matches"
  | "Aligning faces"
  | "Rendering video"
  | "Done"
  | "Failed";

export type Job = {
  id: string;
  username: string;
  email: string;
  status: JobStatus;
  progress: number;
  step: JobStep | string;
  ig_public: number | null;
  ig_post_count: number | null;
  scan_count: number;
  downloaded_count: number;
  matched_count: number;
  skipped_count: number;
  processing_started_at: string | null;
  processing_completed_at: string | null;
  created_at: string;
  updated_at: string;
  error_message: string | null;
  retry_count: number;
  target_path: string;
  output_dir: string;
  video_path: string | null;
  poster_path: string | null;
  download_token: string;
  ip_address: string | null;
  metadata: string | null;
};

export type PublicJob = {
  id: string;
  username: string;
  email: string;
  status: JobStatus;
  progress: number;
  step: string;
  queuePosition: number | null;
  igPublic: boolean | null;
  igPostCount: number | null;
  scanCount: number;
  downloadedCount: number;
  matchedCount: number;
  skippedCount: number;
  processingStartedAt: string | null;
  processingCompletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  errorMessage: string | null;
  videoAvailable: boolean;
  posterAvailable: boolean;
  downloadToken?: string;
  processingSeconds: number | null;
  oldestImagePostAt: string | null;
  newestImagePostAt: string | null;
  targetWidth: number | null;
  targetHeight: number | null;
  videoWidth: number | null;
  videoHeight: number | null;
  cleanupAfter: string | null;
  warnings: string[];
};

export type CreateJobInput = {
  id?: string;
  username: string;
  email: string;
  targetPath: string;
  outputDir: string;
  ipAddress?: string | null;
  metadata?: Record<string, unknown>;
};

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

export type QueueEstimate = {
  queuePosition: number | null;
  activeProcessingCount: number;
  jobsAhead: number;
  estimatedWaitSeconds: number;
  estimatedReadySeconds: number;
  secondsPerJob: number;
};

let db: Database.Database | null = null;

export function nowIso(date = new Date()): string {
  return date.toISOString();
}

export function appRoot(): string {
  let directory = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    const packageJson = path.join(directory, "package.json");
    if (existsSync(packageJson)) {
      try {
        const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as { workspaces?: unknown };
        if (Array.isArray(parsed.workspaces)) return directory;
      } catch {
        // Keep walking if package.json is unreadable.
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return process.cwd();
}

export function storageDir(): string {
  return path.resolve(appRoot(), "storage");
}

export function dbPath(): string {
  return path.join(storageDir(), "facereel.sqlite");
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("hex");
}

export function getDb(): Database.Database {
  if (db) return db;
  const filename = dbPath();
  mkdirSync(path.dirname(filename), { recursive: true });
  db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  initDb(db);
  return db;
}

export function initDb(database = getDb()): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      progress INTEGER NOT NULL DEFAULT 5,
      step TEXT NOT NULL DEFAULT 'Job created',
      ig_public INTEGER,
      ig_post_count INTEGER,
      scan_count INTEGER NOT NULL DEFAULT 0,
      downloaded_count INTEGER NOT NULL DEFAULT 0,
      matched_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      processing_started_at TEXT,
      processing_completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      error_message TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      target_path TEXT NOT NULL,
      output_dir TEXT NOT NULL,
      video_path TEXT,
      poster_path TEXT,
      download_token TEXT NOT NULL UNIQUE,
      ip_address TEXT,
      metadata TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_email_status ON jobs(email, status);
    CREATE INDEX IF NOT EXISTS idx_jobs_ip_status ON jobs(ip_address, status);

    CREATE TABLE IF NOT EXISTS analytics_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT,
      event TEXT NOT NULL,
      user TEXT,
      ip TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_event_created ON analytics_events(event, created_at);
    CREATE INDEX IF NOT EXISTS idx_events_job ON analytics_events(job_id, created_at);

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT,
      level TEXT NOT NULL DEFAULT 'info',
      event TEXT NOT NULL,
      user TEXT,
      message TEXT NOT NULL,
      stack TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_logs_level_created ON logs(level, created_at);
    CREATE INDEX IF NOT EXISTS idx_logs_job ON logs(job_id);

    CREATE TABLE IF NOT EXISTS downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      token TEXT NOT NULL,
      output_type TEXT NOT NULL,
      ip TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_downloads_job ON downloads(job_id, started_at);

    CREATE TABLE IF NOT EXISTS rate_limits (
      scope TEXT NOT NULL,
      identity TEXT NOT NULL,
      window_start_ms INTEGER NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY(scope, identity)
    );
  `);
}

export function closeDb(): void {
  if (!db) return;
  db.close();
  db = null;
}

export function createJob(input: CreateJobInput): Job {
  const database = getDb();
  const id = input.id ?? randomUUID();
  const createdAt = nowIso();
  const token = randomToken();
  database
    .prepare(
      `INSERT INTO jobs (
        id, username, email, status, progress, step, created_at, updated_at,
        target_path, output_dir, download_token, ip_address, metadata
      ) VALUES (
        @id, @username, @email, 'queued', 5, 'Job created', @createdAt, @createdAt,
        @targetPath, @outputDir, @downloadToken, @ipAddress, @metadata
      )`
    )
    .run({
      id,
      username: input.username,
      email: input.email,
      createdAt,
      targetPath: input.targetPath,
      outputDir: input.outputDir,
      downloadToken: token,
      ipAddress: input.ipAddress ?? null,
      metadata: JSON.stringify(input.metadata ?? {})
    });

  const job = getJob(id);
  if (!job) throw new Error("Job insert failed.");
  trackEvent({ event: "job_created", jobId: id, user: input.email, ip: input.ipAddress ?? undefined });
  logInfo({ event: "job_created", jobId: id, user: input.email, message: `Created FaceReel job for ${input.username}` });
  return job;
}

export function getJob(id: string): Job | null {
  return (getDb().prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Job | undefined) ?? null;
}

export function getJobByDownloadToken(token: string): Job | null {
  return (getDb().prepare("SELECT * FROM jobs WHERE download_token = ?").get(token) as Job | undefined) ?? null;
}

const jobPatchFields = new Set([
  "status",
  "progress",
  "step",
  "ig_public",
  "ig_post_count",
  "scan_count",
  "downloaded_count",
  "matched_count",
  "skipped_count",
  "processing_started_at",
  "processing_completed_at",
  "error_message",
  "retry_count",
  "video_path",
  "poster_path",
  "metadata"
]);

export function updateJob(id: string, patch: Partial<Job>): Job {
  const entries = Object.entries(patch).filter(([key, value]) => jobPatchFields.has(key) && value !== undefined);
  if (entries.length === 0) {
    const job = getJob(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    return job;
  }

  const updatedAt = nowIso();
  const assignments = entries.map(([key]) => `${key} = @${key}`).join(", ");
  getDb()
    .prepare(`UPDATE jobs SET ${assignments}, updated_at = @updatedAt WHERE id = @id`)
    .run({ id, updatedAt, ...Object.fromEntries(entries) });

  const job = getJob(id);
  if (!job) throw new Error(`Job not found after update: ${id}`);
  return job;
}

export function claimNextJob(): Job | null {
  const database = getDb();
  const now = nowIso();
  const row = database
    .prepare(
      `SELECT * FROM jobs
       WHERE status = 'queued'
       ORDER BY created_at ASC
       LIMIT 1`
    )
    .get() as Job | undefined;

  if (!row) return null;

  const result = database
    .prepare(
      `UPDATE jobs
       SET status = 'processing', progress = 5, step = 'Job created',
           processing_started_at = COALESCE(processing_started_at, @now),
           updated_at = @now
       WHERE id = @id AND status = 'queued'`
    )
    .run({ id: row.id, now });

  if (result.changes === 0) return null;
  return getJob(row.id);
}

export function incrementJobRetry(id: string): void {
  getDb().prepare("UPDATE jobs SET retry_count = retry_count + 1, updated_at = ? WHERE id = ?").run(nowIso(), id);
}

export function toPublicJob(job: Job, includeDownloadToken = false): PublicJob {
  const started = job.processing_started_at ? Date.parse(job.processing_started_at) : Number.NaN;
  const completed = job.processing_completed_at ? Date.parse(job.processing_completed_at) : Number.NaN;
  const processingSeconds = Number.isFinite(started) && Number.isFinite(completed)
    ? Math.max(0, Math.round((completed - started) / 1000))
    : null;
  const metadata = parseJobMetadata(job.metadata);
  const instagram = objectMetadata(metadata.instagram);
  const faceReel = objectMetadata(metadata.faceReel);

  return {
    id: job.id,
    username: job.username,
    email: job.email,
    status: job.status,
    progress: job.progress,
    step: job.step,
    queuePosition: queuePosition(job),
    igPublic: job.ig_public == null ? null : job.ig_public === 1,
    igPostCount: job.ig_post_count,
    scanCount: job.scan_count,
    downloadedCount: job.downloaded_count,
    matchedCount: job.matched_count,
    skippedCount: job.skipped_count,
    processingStartedAt: job.processing_started_at,
    processingCompletedAt: job.processing_completed_at,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    errorMessage: job.error_message,
    videoAvailable: Boolean(job.video_path),
    posterAvailable: Boolean(job.poster_path),
    ...(includeDownloadToken && job.video_path ? { downloadToken: job.download_token } : {}),
    processingSeconds,
    oldestImagePostAt: typeof instagram.oldestImagePostAt === "string" ? instagram.oldestImagePostAt : null,
    newestImagePostAt: typeof instagram.newestImagePostAt === "string" ? instagram.newestImagePostAt : null,
    targetWidth: finiteNumber(metadata.targetWidth),
    targetHeight: finiteNumber(metadata.targetHeight),
    videoWidth: finiteNumber(faceReel.videoWidth),
    videoHeight: finiteNumber(faceReel.videoHeight),
    cleanupAfter: typeof metadata.cleanupAfter === "string" ? metadata.cleanupAfter : null,
    warnings: Array.isArray(faceReel.warnings) ? faceReel.warnings.filter((value): value is string => typeof value === "string") : []
  };
}

export function estimateJobQueue(job: Job, secondsPerJob: number): QueueEstimate {
  const queuePositionValue = queuePosition(job);
  const activeProcessingCount = countActiveProcessingJobs(job.status === "processing" ? job.id : undefined);
  const queuedAhead = queuePositionValue ? Math.max(0, queuePositionValue - 1) : 0;
  const jobsAhead = job.status === "queued" ? activeProcessingCount + queuedAhead : 0;
  const normalizedSecondsPerJob = Math.max(60, Math.round(secondsPerJob));
  return {
    queuePosition: queuePositionValue,
    activeProcessingCount,
    jobsAhead,
    estimatedWaitSeconds: jobsAhead * normalizedSecondsPerJob,
    estimatedReadySeconds: (jobsAhead + (job.status === "completed" || job.status === "failed" ? 0 : 1)) * normalizedSecondsPerJob,
    secondsPerJob: normalizedSecondsPerJob
  };
}

function countActiveProcessingJobs(excludeJobId?: string): number {
  const value = getDb()
    .prepare(
      `SELECT COUNT(*) AS count
       FROM jobs
       WHERE status = 'processing'
         AND (@excludeJobId IS NULL OR id != @excludeJobId)`
    )
    .get({ excludeJobId: excludeJobId ?? null }) as { count?: number } | undefined;
  return Number(value?.count || 0);
}

function queuePosition(job: Job): number | null {
  if (job.status !== "queued") return null;
  const value = getDb()
    .prepare(
      `SELECT COUNT(*) + 1 AS position
       FROM jobs
       WHERE status = 'queued'
         AND (created_at < @createdAt OR (created_at = @createdAt AND id < @id))`
    )
    .get({ createdAt: job.created_at, id: job.id }) as { position?: number } | undefined;
  return typeof value?.position === "number" ? value.position : null;
}

export function trackEvent(input: {
  event: string;
  jobId?: string | undefined;
  user?: string | undefined;
  ip?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}): void {
  getDb()
    .prepare(
      `INSERT INTO analytics_events (job_id, event, user, ip, metadata, created_at)
       VALUES (@jobId, @event, @user, @ip, @metadata, @createdAt)`
    )
    .run({
      jobId: input.jobId ?? null,
      event: input.event,
      user: input.user ?? null,
      ip: input.ip ?? null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      createdAt: nowIso()
    });
}

export function logInfo(input: LogInput): void {
  log({ ...input, level: "info" });
}

export function logWarn(input: LogInput): void {
  log({ ...input, level: "warn" });
}

export function logError(input: LogInput): void {
  log({ ...input, level: "error" });
}

type LogInput = {
  event: string;
  message: string;
  jobId?: string | undefined;
  user?: string | undefined;
  stack?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
};

function log(input: LogInput & { level: "info" | "warn" | "error" }): void {
  getDb()
    .prepare(
      `INSERT INTO logs (job_id, level, event, user, message, stack, metadata, created_at)
       VALUES (@jobId, @level, @event, @user, @message, @stack, @metadata, @createdAt)`
    )
    .run({
      jobId: input.jobId ?? null,
      level: input.level,
      event: input.event,
      user: input.user ?? null,
      message: input.message,
      stack: input.stack ?? null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      createdAt: nowIso()
    });
}

export function recordDownloadStarted(input: { token: string; jobId: string; outputType: string; ip?: string | null }): number {
  const result = getDb()
    .prepare(
      `INSERT INTO downloads (job_id, token, output_type, ip, started_at)
       VALUES (@jobId, @token, @outputType, @ip, @startedAt)`
    )
    .run({
      jobId: input.jobId,
      token: input.token,
      outputType: input.outputType,
      ip: input.ip ?? null,
      startedAt: nowIso()
    });
  return Number(result.lastInsertRowid);
}

export function recordDownloadCompleted(downloadId: number): void {
  getDb().prepare("UPDATE downloads SET completed_at = ? WHERE id = ?").run(nowIso(), downloadId);
}

export function assertRateLimit(input: { scope: string; identity: string; limit: number; windowMs: number }): RateLimitResult {
  const now = Date.now();
  const row = getDb()
    .prepare("SELECT window_start_ms, count FROM rate_limits WHERE scope = ? AND identity = ?")
    .get(input.scope, input.identity) as { window_start_ms: number; count: number } | undefined;

  if (!row || now - row.window_start_ms >= input.windowMs) {
    getDb()
      .prepare(
        `INSERT INTO rate_limits (scope, identity, window_start_ms, count)
         VALUES (@scope, @identity, @windowStartMs, 1)
         ON CONFLICT(scope, identity) DO UPDATE SET window_start_ms = excluded.window_start_ms, count = excluded.count`
      )
      .run({ scope: input.scope, identity: input.identity, windowStartMs: now });
    return { allowed: true, remaining: Math.max(0, input.limit - 1), retryAfterSeconds: 0 };
  }

  if (row.count >= input.limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((input.windowMs - (now - row.window_start_ms)) / 1000))
    };
  }

  getDb()
    .prepare("UPDATE rate_limits SET count = count + 1 WHERE scope = ? AND identity = ?")
    .run(input.scope, input.identity);
  return { allowed: true, remaining: Math.max(0, input.limit - row.count - 1), retryAfterSeconds: 0 };
}

export function hasActiveJobForEmail(email: string): boolean {
  const value = getDb()
    .prepare("SELECT 1 FROM jobs WHERE email = ? AND status IN ('queued', 'processing') LIMIT 1")
    .get(email);
  return Boolean(value);
}

export function getDashboardMetrics(): Record<string, unknown> {
  const database = getDb();
  const totals = database
    .prepare(
      `SELECT
        COUNT(*) AS totalJobs,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completedJobs,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedJobs,
        SUM(scan_count) AS scannedPhotos,
        SUM(matched_count) AS matchedPhotos,
        SUM(downloaded_count) AS highResDownloads,
        AVG(CASE
          WHEN processing_started_at IS NOT NULL AND processing_completed_at IS NOT NULL
          THEN (julianday(processing_completed_at) - julianday(processing_started_at)) * 86400
          ELSE NULL
        END) AS averageProcessingSeconds
       FROM jobs`
    )
    .get() as Record<string, unknown>;
  const downloads = database.prepare("SELECT COUNT(*) AS count FROM downloads WHERE completed_at IS NOT NULL").get() as { count?: number };
  const recentJobs = database
    .prepare(
      `SELECT id, username, email, status, progress, step, scan_count, matched_count, downloaded_count, created_at, error_message
       FROM jobs ORDER BY created_at DESC LIMIT 25`
    )
    .all() as Record<string, unknown>[];
  const recentAnalytics = database
    .prepare("SELECT event, job_id, user, ip, created_at FROM analytics_events ORDER BY created_at DESC LIMIT 25")
    .all() as Record<string, unknown>[];
  const recentErrors = database
    .prepare("SELECT event, job_id, user, message, created_at FROM logs WHERE level = 'error' ORDER BY created_at DESC LIMIT 25")
    .all() as Record<string, unknown>[];
  const totalJobs = Number(totals.totalJobs || 0);
  const completedJobs = Number(totals.completedJobs || 0);
  return {
    ...totals,
    downloads: downloads.count || 0,
    conversion: {
      completedRate: totalJobs ? completedJobs / totalJobs : 0
    },
    recentJobs,
    recentAnalytics,
    recentErrors
  };
}

function parseJobMetadata(metadata: string | null): Record<string, unknown> {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function objectMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
