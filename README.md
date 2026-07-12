# FaceReel MVP

FaceReel creates a vertical face-aligned MP4 from public Instagram photos.

Flow:

1. User enters a public Instagram username, email, and one target-face image.
2. App checks that the Instagram profile is public.
3. Submit creates a queued SQLite job.
4. Worker builds an Instagram media manifest with scan and source URLs.
5. Worker downloads lower-resolution scan images and runs face matching in TypeScript.
6. Worker downloads high-resolution originals only for matched images.
7. Worker aligns matched faces into 1080x1920 frames and renders `facereel.mp4`.

## Stack

- SolidStart app in `app/`
- Node/TypeScript API routes and worker
- SQLite via `better-sqlite3`
- RapidAPI Instagram profile/posts client
- `@vladmandic/face-api` + `@tensorflow/tfjs-node`
- `sharp` for image normalization and frame export
- FFmpeg for MP4 rendering
- Docker Compose with local persistent storage

## Setup

```bash
cp .env.example .env
npm install
npm run db:init
npm run dev
```

Open `http://localhost:3000`.

## Required Environment

- `APP_URL`
- `ADMIN_PASSWORD`
- `INSTAGRAM_RAPIDAPI_KEY`
- `INSTAGRAM_RAPIDAPI_HOST`
- `FACEAPI_MODEL_DIR`

Optional:

- `RESEND_API_KEY`
- `EMAIL_FROM`
- `ADMIN_EMAIL`
- `FACEREEL_MATCH_THRESHOLD`
- `FACEREEL_MIN_MATCHES`
- `FACEREEL_MAX_IMAGES`
- `FACEREEL_MOCK=1` for local mock video generation without Instagram/model files.

## Face API Models

Place the face-api model files under `models/face-api` or set `FACEAPI_MODEL_DIR`.
The worker expects SSD MobileNet, 68-point landmark, and recognition models.

## Worker

Run both app and worker:

```bash
npm run dev
```

Run only the worker:

```bash
npm run worker
```

The worker processes one queued job at a time. On a small Droplet, run a single
worker process/container and do not scale the `worker` service above one replica.

Submission emails include queue position and estimated timing. Set
`FACEREEL_ESTIMATED_JOB_SECONDS` to tune the estimate; it defaults to `480`
seconds.

For small Droplets, keep per-job download fan-out modest:

```env
FACEREEL_SCAN_DOWNLOAD_CONCURRENCY=6
FACEREEL_SOURCE_DOWNLOAD_CONCURRENCY=3
```

## Deployment

DigitalOcean setup and GitHub Actions deployment are documented in
[docs/digitalocean.md](docs/digitalocean.md). The included workflow deploys
`main` by SSHing into the Droplet, pulling the repo, rebuilding Docker, and
checking `/api/health`.

## Storage

Generated files live under `storage/`:

```text
storage/
  facereel.sqlite
  jobs/<job_id>/
    target-*.jpg
    scans/
    sources/
    frames/
    face_manifest.json
    poster.jpg
    facereel.mp4
```

The app exposes generated videos through random download tokens and does not expose source-photo downloads in v1.

## Local Verification

```bash
npm run test:check -- username
npm run test:download -- username
FACEREEL_MOCK=1 npm run worker -- --once
```

FFmpeg must be installed locally and in production.
