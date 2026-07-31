# FaceReel

FaceReel is a Next.js application plus a private Cloud Run video worker. It creates a 1080×1920 H.264 MP4 from a target face and matching public Instagram photos while keeping durable state in Prisma Postgres and media in private Cloudflare R2.

## Production architecture

- `app/`: Next.js 16 application for Vercel, project submission, authorized status polling, and signed output redirects.
- `packages/db`: Prisma 7 PostgreSQL schema/client and atomic render claiming.
- `packages/storage`: streamed Cloudflare R2/S3-compatible storage abstraction.
- `packages/dispatch`: Google Cloud Tasks dispatch and durable outbox reconciliation.
- `packages/worker`: private HTTP service and unchanged face alignment/FFmpeg pipeline.

The browser talks only to Next.js. A render submission creates the job and outbox row in one serializable transaction. Cloud Tasks sends only `{ "jobId": "…" }`; the worker atomically claims the row, loads authoritative project/source metadata, renders into ephemeral scratch space, uploads deterministic output keys, commits asset metadata and completion together, then attempts the independently idempotent Resend delivery.

## Local development

Use Node 22.16.0. Copy `.env.example` to `.env`, start PostgreSQL/R2-compatible storage, then:

```bash
npm install
npm run db:generate
npm run db:migrate:dev
npm run dev
```

`CLOUD_TASKS_MODE=local` dispatches to the local authenticated worker endpoint. There is no SQLite or automatic local database fallback.

Useful checks:

```bash
npm run typecheck
npm run build
npm run test:facereel
npm run dispatch:reconcile
npm run jobs:recover
```

## Instagram campaign publishing

Configure `INSTAGRAM_PAGE_ACCESS_TOKEN` with a Facebook Page access token and
`INSTAGRAM_BUSINESS_ACCOUNT_ID` with the connected Instagram Professional
account ID. Set `META_APP_ID` and `META_APP_SECRET` for the app used to issue the
token. Keep credentials in an untracked `.env` file or encrypted hosting
configuration.

Check the configured token before publishing:

```bash
npm run instagram:token:check
```

Use `marketing/campaign.json` to configure public creator targets and captions.
The campaign runner keeps local queue state, locks, and generated media in
ignored files under `marketing/`.

See [docs/production-architecture.md](docs/production-architecture.md) for the repository audit, failure model, environment variables, deployment sequence, IAM, retention, sizing, and rollback commands.
