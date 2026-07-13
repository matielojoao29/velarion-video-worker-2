// V Scout — FFmpeg clip worker.
//
// Polls the app for pending clip jobs, cuts a clip with FFmpeg,
// uploads the MP4 back via a signed upload URL, and reports completion.

import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { request as undiciRequest } from "undici";

const APP_URL = requireAnyEnv(["APP_URL", "PUBLIC_APP_URL", "VSCOUT_APP_URL"]).replace(/\/$/, "");
const SECRET = requireAnyEnv(["WORKER_SHARED_SECRET", "VIDEO_WORKER_SHARED_SECRET"]);
const WORKER_ID = process.env.WORKER_ID || hostname();
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 2));
const POLL_INTERVAL_MS = Math.max(1000, Number(process.env.POLL_INTERVAL_MS || 4000));

let inFlight = 0;
const seen = new Set();

function requireAnyEnv(names) {
  for (const name of names) {
    const v = process.env[name];
    if (v) return v;
  }
  console.error(`Missing required env var. Set one of: ${names.join(", ")}`);
  process.exit(1);
}

function authorized(req) {
  const direct = req.headers["x-worker-secret"];
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return direct === SECRET || bearer === SECRET;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function truncate(value, max) {
  return String(value || "").slice(0, max);
}

function redactArgs(args) {
  const copy = [...args];
  const i = copy.indexOf("-i");
  if (i >= 0 && copy[i + 1]) copy[i + 1] = "<signed_source_url>";
  return `ffmpeg ${copy.join(" ")}`;
}

function runFfmpeg(args, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let timer;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        ff.kill("SIGKILL");
        reject(new Error(`ffmpeg timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    }
    ff.stderr.on("data", (c) => (stderr += c.toString()));
    ff.on("close", (code) => {
      if (timer) clearTimeout(timer);
      code === 0 ? resolve(stderr) : reject(new Error(stderr || `ffmpeg exit ${code}`));
    });
    ff.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

async function checkFfmpeg() {
  try {
    await runFfmpeg(["-version"], 5000);
    return true;
  } catch {
    return false;
  }
}

async function checkAppBridge() {
  try {
    const res = await undiciRequest(`${APP_URL}/api/public/hooks/worker-health`, {
      method: "GET",
      headers: { "x-worker-secret": SECRET },
    });
    if (res.statusCode !== 200) return { database: false, storage: false };
    const data = await res.body.json();
    return { database: !!data.database, storage: !!data.storage };
  } catch {
    return { database: false, storage: false };
  }
}

async function healthPayload() {
  const [ffmpeg, bridge] = await Promise.all([checkFfmpeg(), checkAppBridge()]);
  return {
    status: ffmpeg && bridge.database && bridge.storage ? "ok" : "error",
    ffmpeg,
    database: bridge.database,
    storage: bridge.storage,
    worker_id: WORKER_ID,
    in_flight: inFlight,
  };
}

async function claimJobs(batch, clipId) {
  const body = { worker_id: WORKER_ID, batch_size: batch };
  if (clipId) body.clip_id = clipId;
  const res = await undiciRequest(`${APP_URL}/api/public/hooks/claim-clip-jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-worker-secret": SECRET },
    body: JSON.stringify(body),
  });
  if (res.statusCode !== 200) {
    const bodyText = await res.body.text();
    throw new Error(`claim failed ${res.statusCode}: ${bodyText}`);
  }
  const data = await res.body.json();
  return data.jobs || [];
}

async function reportOutcome(clipId, payload) {
  try {
    const res = await undiciRequest(`${APP_URL}/api/public/hooks/complete-clip-job`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-worker-secret": SECRET },
      body: JSON.stringify({ clip_id: clipId, worker_id: WORKER_ID, ...payload }),
    });
    if (res.statusCode !== 200) {
      console.error(`report ${clipId} status ${res.statusCode}`, await res.body.text());
    }
  } catch (err) {
    console.error(`report ${clipId} threw`, err);
  }
}

async function ffmpegCut(sourceUrl, start, duration, outputPath) {
  const commonInput = [
    "-hide_banner", "-loglevel", "error",
    "-ss", String(start),
    "-i", sourceUrl,
    "-t", String(duration),
    "-movflags", "+faststart",
  ];
  const copyArgs = [...commonInput, "-c", "copy", "-y", outputPath];
  try {
    const output = await runFfmpeg(copyArgs);
    const st = await stat(outputPath);
    if (st.size > 4096) return { command: redactArgs(copyArgs), output: truncate(output, 12000) };
  } catch (err) {
    console.warn("stream copy failed:", err.message.slice(0, 200));
  }
  const encodeArgs = [
    ...commonInput,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k",
    "-y", outputPath,
  ];
  const output = await runFfmpeg(encodeArgs);
  return { command: redactArgs(encodeArgs), output: truncate(output, 12000) };
}

async function uploadClip(uploadUrl, filePath) {
  const buf = await readFile(filePath);
  const res = await undiciRequest(uploadUrl, {
    method: "PUT",
    headers: { "content-type": "video/mp4" },
    body: buf,
  });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const body = await res.body.text();
    throw new Error(`upload failed ${res.statusCode}: ${body}`);
  }
}

async function processJob(job) {
  if (seen.has(job.clip_id)) return;
  seen.add(job.clip_id);
  inFlight++;
  const tmp = await mkdtemp(join(tmpdir(), "clip-"));
  const outPath = join(tmp, "clip.mp4");
  console.log(`[${job.clip_id}] attempt=${job.attempts} video=${job.video_id || job.source_storage_path} start=${job.start_seconds}s dur=${job.duration_seconds}s`);
  let ffmpegResult = { command: "", output: "" };
  try {
    ffmpegResult = await ffmpegCut(job.source_signed_url, job.start_seconds, job.duration_seconds, outPath);
    await uploadClip(job.upload_signed_url, outPath);
    await reportOutcome(job.clip_id, {
      ok: true,
      attempts: job.attempts,
      clip_storage_path: job.clip_storage_path,
      video_storage_path: job.source_storage_path,
      ffmpeg_command: ffmpegResult.command,
      ffmpeg_output: ffmpegResult.output,
    });
    console.log(`[${job.clip_id}] done`);
  } catch (err) {
    console.error(`[${job.clip_id}] failed:`, err.message);
    await reportOutcome(job.clip_id, {
      ok: false,
      attempts: job.attempts,
      error: truncate(err.message || err, 500),
      video_storage_path: job.source_storage_path,
      clip_storage_path: job.clip_storage_path,
      ffmpeg_command: ffmpegResult.command,
      ffmpeg_output: ffmpegResult.output || truncate(err.message || err, 12000),
    });
  } finally {
    seen.delete(job.clip_id);
    inFlight--;
    try { await rm(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
}

async function tick() {
  const capacity = CONCURRENCY - inFlight;
  if (capacity <= 0) return;
  try {
    const jobs = await claimJobs(capacity);
    for (const job of jobs) processJob(job).catch((e) => console.error("processJob crashed", e));
  } catch (err) {
    console.error("poll failed:", err.message);
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://worker.local");

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    const payload = await healthPayload();
    sendJson(res, payload.status === "ok" ? 200 : 503, payload);
    return;
  }

  if (req.method === "POST" && url.pathname === "/process-clip") {
    if (!authorized(req)) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }
    if (CONCURRENCY - inFlight <= 0) {
      sendJson(res, 202, { ok: true, accepted: false, reason: "worker_busy" });
      return;
    }
    try {
      const body = await readJson(req);
      if (!body.clip_id) {
        sendJson(res, 400, { ok: false, error: "clip_id required" });
        return;
      }
      const jobs = await claimJobs(1, body.clip_id);
      if (jobs.length === 0) {
        sendJson(res, 202, { ok: true, accepted: false, reason: "no_claimable_job" });
        return;
      }
      processJob(jobs[0]).catch((e) => console.error("processJob crashed", e));
      sendJson(res, 202, { ok: true, accepted: true, clip_id: body.clip_id });
      return;
    } catch (err) {
      sendJson(res, 500, { ok: false, error: truncate(err.message || err, 500) });
      return;
    }
  }

  sendJson(res, 404, { ok: false, error: "not_found" });
}).listen(Number(process.env.PORT || 8080), () => {
  console.log(`worker ${WORKER_ID} listening on ${process.env.PORT || 8080}`);
});

console.log(`worker ${WORKER_ID} polling ${APP_URL} every ${POLL_INTERVAL_MS}ms, concurrency=${CONCURRENCY}`);
setInterval(tick, POLL_INTERVAL_MS);
tick();
