# V Scout — Clip processing worker

Node + FFmpeg service that turns queued tag intervals into real MP4 clips.
Deploy once on any container platform (Cloud Run, Railway, Render, Fly.io,
Hetzner, your own VM). The worker pulls jobs from the app — no inbound
webhook from the app is required.

## Flow

1. Worker calls `POST {APP_URL}/api/public/hooks/claim-clip-jobs` with the
   shared secret. The app flips up to N pending rows to `processing`, mints a
   6-hour signed read URL for the source video and a signed upload URL for
   the destination clip. The worker never sees the backend service-role key.
2. `ffmpeg -ss <start> -i <signed_url> -t <duration> -c copy`; falls back to
   `libx264 + aac + yuv420p` when stream copy fails (keyframe issue). FFmpeg
   fetches only the byte range it needs from the signed URL, so 2–3 h source
   files are fine.
3. `PUT` the resulting MP4 to the signed upload URL.
4. `POST {APP_URL}/api/public/hooks/complete-clip-job` reports success (with
   `clip_storage_path`) or failure. The app re-queues up to 3 attempts, then
   marks the row `error` with the real technical message.

## Endpoints

- `GET /health` returns `status`, `ffmpeg`, `database`, and `storage`.
- `POST /process-clip` accepts `{ "clip_id": "...", "video_id": "...", "start_time": 0, "end_time": 15 }` and requires `X-Worker-Secret`. It immediately claims that clip when the worker has capacity. The polling loop still runs, so clips keep processing even if the app is closed.

## Deploy

### Cloud Run

```bash
cd worker
gcloud run deploy vscout-clip-worker \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 2 \
  --timeout 3600 \
  --min-instances 1 \
  --set-env-vars APP_URL=https://velarionscout.com.br,WORKER_SHARED_SECRET=<paste-secret>,CONCURRENCY=2
```

### Railway / Render / Fly.io

Point Railway at this folder, use the included `Dockerfile`, and set
the env vars below. Give the container at least 1 vCPU / 2 GB RAM. Set
`min-instances = 1` (or "always on") so the worker keeps polling.

## Env vars

Required:

| Name                          | Description                                                             |
| ----------------------------- | ----------------------------------------------------------------------- |
| `APP_URL`                     | Public URL of the V Scout app, e.g. `https://velarionscout.com.br`      |
| `WORKER_SHARED_SECRET`        | Same value stored in the app as `VIDEO_WORKER_SHARED_SECRET`            |

`VIDEO_WORKER_SHARED_SECRET` also works as an alias in the worker.

Do not put the backend service-role key in the frontend. This worker does not need it: the app backend creates signed Storage URLs after validating the shared secret.

Optional:

| Name                | Default    | Purpose                                              |
| ------------------- | ---------- | ---------------------------------------------------- |
| `CONCURRENCY`       | `2`        | Max parallel FFmpeg processes per instance           |
| `POLL_INTERVAL_MS`  | `4000`     | Idle polling cadence                                 |
| `WORKER_ID`         | hostname   | Recorded on `tag_clips` rows for observability       |
| `PORT`             | `8080`     | Health-check port                                    |

Use `/health` as the platform health check path.