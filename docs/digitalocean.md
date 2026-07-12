# DigitalOcean Droplet Deployment

This is the recommended MVP deployment because SQLite, downloaded Instagram media, aligned frames, and generated videos need persistent local disk.

## 1. Create Droplet

Use an Ubuntu LTS Droplet with at least:

- 2 vCPU
- 4GB RAM for small jobs
- 8GB RAM recommended for concurrent face detection and FFmpeg rendering
- 80GB+ disk if you keep many completed jobs

## 2. Install Docker

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker
```

## 3. Clone And Configure

```bash
git clone <your-repo-url> facereel
cd facereel
cp .env.example .env
```

Edit `.env`:

```env
APP_URL=https://your-domain.com
ADMIN_PASSWORD=use-a-long-random-password
INSTAGRAM_RAPIDAPI_KEY=...
INSTAGRAM_RAPIDAPI_HOST=instagram120.p.rapidapi.com
FACEAPI_MODEL_DIR=/app/models/face-api
RESEND_API_KEY=
EMAIL_FROM=FaceReel <onboarding@resend.dev>
ADMIN_EMAIL=
```

Place the face-api model files in `models/face-api` before building, or mount them into the container and update `FACEAPI_MODEL_DIR`.

## 3.1 GitHub Deploy Workflow

FaceReel includes `.github/workflows/deploy.yml`, matching the InstaMosaic-style
deploy flow. On pushes to `main`, GitHub Actions SSHes into the Droplet, pulls
the latest code, rebuilds Docker, checks `/api/health`, and optionally sends a
deploy email.

Add these repository secrets in GitHub:

```text
DEPLOY_HOST=<droplet ip or hostname>
DEPLOY_USER=<ssh user, for example root or deploy>
DEPLOY_PATH=/opt/facereel
DEPLOY_SSH_KEY=<private key allowed to SSH into the droplet>
DEPLOY_PORT=22
RESEND_API_KEY=<optional, only for deploy notification email>
```

On the Droplet, the matching public key must be in the deploy user's
`~/.ssh/authorized_keys`. The repository should already be cloned at
`DEPLOY_PATH`, and `.env` plus `models/face-api` should already exist there.

Manual first deploy:

```bash
cd /opt/facereel
docker compose up -d --build
docker compose ps
```

## 4. Start App

```bash
docker compose up -d --build
docker compose logs -f app worker
```

The app listens on port `3000`.

Keep exactly one `worker` service running on small Droplets. The SQLite queue is
FIFO and each worker processes one job at a time, so one worker keeps CPU/RAM
bounded. Tune submission-email estimates with `FACEREEL_ESTIMATED_JOB_SECONDS`
in `.env` if real processing time differs from the default `480` seconds.
Use `FACEREEL_SCAN_DOWNLOAD_CONCURRENCY=6` and
`FACEREEL_SOURCE_DOWNLOAD_CONCURRENCY=3` or lower if the Droplet is memory or
network constrained.

## 5. Reverse Proxy

Point your domain to the Droplet and put Caddy or Nginx in front of the app.

Example Caddyfile:

```caddy
your-domain.com {
  reverse_proxy 127.0.0.1:3000
}
```

## 6. Backups

The compose file stores SQLite and artifacts in the `facereel-data` Docker volume.

Back it up regularly:

```bash
docker run --rm \
  -v facereel_facereel-data:/data \
  -v "$PWD/backups:/backups" \
  alpine tar czf /backups/facereel-$(date +%F).tgz /data
```

## 7. Operations

Useful commands:

```bash
docker compose ps
docker compose logs -f app worker
docker compose restart worker
docker compose exec app npm run db:init
```

For the MVP, cleanup is manual. The app stores a 7-day cleanup deadline in job metadata, but no automatic deletion job has been added yet.
