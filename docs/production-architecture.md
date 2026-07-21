# FaceReel production architecture

## Repository audit and retained behavior

Before this migration, FaceReel was a SolidStart/Vinxi monolith. Its API saved a target upload under `storage/jobs/<jobId>`, inserted a `better-sqlite3` row, and a polling process claimed the oldest queued row. The worker used RapidAPI to check a public Instagram profile, page through photo posts, download 768px scan copies, compare SSD MobileNet/68-landmark/recognition descriptors, download high-resolution copies only for matches, and align them. The deterministic face rule is the descriptor closest to the uploaded target under the configured threshold; the target must contain exactly one face. Sharp applies EXIF rotation, normalizes geometry, rotates the eye line, crops around a fixed eye target, pads boundaries, and writes 1080×1920 JPEG frames. FFmpeg repeats each frame for 0.3 seconds at 30fps and emits H.264 High profile, yuv420p, CRF 20, fast-start MP4. The first aligned frame is the poster. There is no audio, transition selector, cancellation UI, Sentry, payment, Stripe, or meaningful production SQLite migration history.

The prior Docker image bundled the web and polling worker, used FFmpeg, ran as root, and shared a Docker volume. Deployment was a GitHub Actions SSH/Docker Compose deployment to DigitalOcean. R2 did not exist despite being an intended production boundary. Resend supplied submission/readiness email. Status polling was every two seconds and relied on the job ID/download token rather than authenticated ownership.

The new implementation retains the existing portrait MP4, timing, crop/alignment, face-selection, watermark, and encoder behavior. It replaces the frontend runtime with Next.js and separates the HTTP adapter from `processRenderJob(jobId)`.

## Lifecycle and boundaries

The Next.js submission route validates a maximum 15MiB JPG/PNG/WEBP with a 40-megapixel decoded-image ceiling, generates server-side R2 keys, uploads the target, then transactionally creates `FaceReelProject`, `SourceImage`, `RenderJob`, `RenderDispatch`, and processing-email rows. Ownership uses a random token stored only in an HttpOnly SameSite cookie; PostgreSQL stores its SHA-256 hash. Every status/asset lookup includes that ownership predicate.

`RenderDispatch` is an outbox. Submission attempts immediate dispatch without making the request depend on it. Vercel Cron calls the bearer-protected reconciliation route every five minutes; `npm run dispatch:reconcile` is the operator equivalent. Dispatch is repeatable and Cloud Task names are deterministic.

Cloud Tasks invokes `POST /internal/render-jobs/process` with only the job ID. In production the service requires Cloud Run IAM/OIDC plus the Cloud Tasks header and verifies token audience. Local mode requires `x-facereel-local-secret`. PostgreSQL row locking (`SELECT … FOR UPDATE`) serializes claims. Completed and actively heartbeating jobs are acknowledged without rendering. A 30-minute heartbeat threshold permits conservative recovery; `npm run jobs:recover` resets only stale attempts below their row-specific attempt limit.

The worker downloads the target from R2, discovers Instagram sources, preserves selected high-resolution sources in R2, renders to an attempt-scoped OS temp directory, verifies the MP4 with FFprobe, streams outputs to R2, and transactionally records assets/completion. Final keys are deterministic and unique. Incomplete local scratch is removed in `finally`. Duplicate asset inserts are ignored. Completion/failure email is claimed and retried independently with a stable Resend idempotency key; email failure never changes a completed render.

Progress is bounded and weighted: download/validation 0–25%, detection 25–45%, alignment/source retrieval 45–70%, frame/encoding 70–92%, upload 92–98%, finalization 98–100%. Writes occur on stage changes, 2-point changes, or a ten-second heartbeat. The browser polls every 2.5 seconds, backs off to ten seconds on errors, survives refresh, and stops at terminal state or teardown.

## Failure and safety model

Transient storage/database/platform interruption and encoder interruption are retryable up to `maxAttempts`. Missing/private sources, insufficient images, and invalid user inputs are terminal/user-correctable. Public responses expose a safe code/message only; bounded internal diagnostics remain in `internalError`. No signed URL, credential, FFmpeg command, or stack is returned. FFmpeg receives argument arrays. FFprobe requires a nonempty parseable H.264 1080×1920 output and plausible duration before completion.

Queued cancellation is represented by `CANCELLED`; no UI is added because the prior product had no cancellation. Future cancellation must conditionally update queued jobs and check state between major worker stages before terminating FFmpeg. A late cancellation must not remove completed assets.

R2 source images and completed assets have no automatic deletion policy. Configure an R2 lifecycle rule only for `projects/*/renders/*/temporary/*` at 24 hours. Local scratch is per-attempt and always removed. Never delete an object referenced by `SourceImage` or `RenderedAsset`. Abandoned pending uploads can later be reaped only after cross-checking the database.

## Environment

Vercel runtime uses pooled `DATABASE_URL`; migrations use direct `DIRECT_DATABASE_URL`. Prisma 7 configuration lives in `prisma.config.ts`, and build runs client generation. Configure `APP_URL`, R2 account/endpoint/bucket/access keys, Google project/location/queue/worker URL/invoker service account, `CRON_SECRET`, Instagram provider variables, and Resend variables. Cloud Tasks credentials on Vercel must be server-only workload-identity credentials where the hosting integration supports federation; otherwise use a narrowly scoped service-account credential stored as an encrypted Vercel secret. Never use `NEXT_PUBLIC_` for credentials.

Cloud Run uses pooled `DATABASE_URL`, R2/Instagram/Resend secrets from Secret Manager, `CLOUD_RUN_WORKER_URL`, `FACEAPI_MODEL_DIR`, and optional thresholds. Do not run migrations at worker startup.

## Google Cloud provisioning

Substitute project, region, and service-account values:

```bash
gcloud services enable run.googleapis.com cloudtasks.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com
gcloud artifacts repositories create facereel --repository-format=docker --location=us-central1
gcloud iam service-accounts create facereel-worker
gcloud iam service-accounts create facereel-task-invoker
gcloud iam service-accounts create facereel-task-creator
gcloud builds submit --tag us-central1-docker.pkg.dev/PROJECT/facereel/worker:SHA .
gcloud run deploy facereel-worker --image us-central1-docker.pkg.dev/PROJECT/facereel/worker:SHA --region us-central1 --no-allow-unauthenticated --service-account facereel-worker@PROJECT.iam.gserviceaccount.com --cpu 2 --memory 4Gi --concurrency 1 --min 0 --max 4 --timeout 1800 --set-secrets DATABASE_URL=facereel-database-url:latest,R2_ACCESS_KEY_ID=facereel-r2-key:latest,R2_SECRET_ACCESS_KEY=facereel-r2-secret:latest,INSTAGRAM_RAPIDAPI_KEY=facereel-instagram-key:latest,RESEND_API_KEY=facereel-resend-key:latest
gcloud run services add-iam-policy-binding facereel-worker --region us-central1 --member serviceAccount:facereel-task-invoker@PROJECT.iam.gserviceaccount.com --role roles/run.invoker
gcloud tasks queues create facereel-renders --location us-central1 --max-concurrent-dispatches 4 --max-dispatches-per-second 1 --max-attempts 3 --min-backoff 30s --max-backoff 300s --max-doublings 3
gcloud projects add-iam-policy-binding PROJECT --member serviceAccount:facereel-task-creator@PROJECT.iam.gserviceaccount.com --role roles/cloudtasks.enqueuer
```

Grant the Cloud Tasks service agent `roles/iam.serviceAccountUser` on the invoker identity only where required. The creator may enqueue but cannot invoke Cloud Run directly. Test with `gcloud auth print-identity-token --audiences WORKER_URL` and a minimal job-ID request. View logs with `gcloud run services logs read facereel-worker --region us-central1`. Roll back with `gcloud run services update-traffic facereel-worker --region us-central1 --to-revisions REVISION=100`.

Cloud Run service requests support up to 60 minutes; this deployment deliberately chooses 30 minutes to match the stale threshold and queue deadline. Expected reels are far below that. If production measurements approach 25 minutes, reject oversize requests and move the already-separated processor to Cloud Run Jobs before raising limits.

## Sizing benchmark

On 2026-07-21, the deterministic local eight-image fixture produced a 2.4-second, 1080×1920, 30fps H.264 MP4 in 2.17 seconds. `/usr/bin/time -l` reported 723,009,536 bytes maximum RSS. Final scratch after temporary repeated frames were removed was 228KiB; the MP4 was 48,363 bytes and poster 17KiB. A production render also holds TensorFlow models, downloads, aligned frames, and repeated-frame JPEGs. Start Cloud Run at 2 vCPU, 4GiB memory, concurrency 1, 30-minute timeout, min 0/max 4, with at least 10GiB ephemeral disk. Profile representative 50/200/500-photo real jobs before reducing memory or increasing concurrency. Scratch worst-case is approximately source download bytes plus scan copies plus aligned JPEGs plus `images × 0.3 × 30` repeated JPEGs and output; enforce the 500-source cap.

## Deployment order and verification

1. Provision Prisma Postgres; set pooled/direct URLs and apply `npm run db:migrate`.
2. The checked-in SQLite contained only local test artifacts, not authoritative production data, so there is no data-import script. Export anything meaningful before deletion; missing local paths cannot be migrated to R2 implicitly.
3. Build/deploy the private worker and configure Secret Manager/IAM.
4. Create/tune the queue, then configure Vercel variables and deploy Next.js.
5. Smoke-test a small and representative render, Resend delivery, duplicate task, forced worker termination/stale recovery, owner denial, and signed URL expiry.
6. Inspect queued/processing/failed/stale/unsent-email rows with Prisma Studio or targeted SQL. Run reconciliation and stale recovery repeatedly to prove idempotency.

The production migration must be applied before either new service handles traffic. Roll back web and worker revisions together; keep the additive PostgreSQL schema during rollback. Do not reintroduce SQLite.

## Dependency audit note

The preserved `@tensorflow/tfjs-node@4.22` installer currently brings old `node-pre-gyp`/`tar` code that npm flags. FaceReel never accepts or extracts user archives and this code is used only to install the pinned TensorFlow binary while building the private worker. Forcing current `tar` breaks TensorFlow's legitimate library symlink extraction, so the incompatible override is intentionally not used. Revisit this when the face runtime is upgraded; build images only in the trusted Cloud Build context and never invoke the installer at request time. The currently released Next.js also pins a PostCSS version covered by a moderate advisory; FaceReel does not stringify user-controlled CSS. Upgrade as soon as an upstream stable release resolves it.
