import { A, useParams } from "@solidjs/router";
import { Clock, Download, LoaderCircle, Share2, XCircle } from "lucide-solid";
import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Badge, Button, Panel, trackUiEvent } from "../../../components/ui.tsx";

type PublicJob = {
  id: string;
  username: string;
  status: "queued" | "processing" | "completed" | "failed";
  progress: number;
  step: string;
  queuePosition: number | null;
  estimatedWaitSeconds: number | null;
  estimatedReadySeconds: number | null;
  igPostCount: number | null;
  scanCount: number;
  downloadedCount: number;
  matchedCount: number;
  skippedCount: number;
  processingSeconds: number | null;
  updatedAt: string;
  errorMessage: string | null;
  videoAvailable: boolean;
  posterAvailable: boolean;
  downloadToken?: string;
  cleanupAfter: string | null;
  warnings: string[];
};

export default function StatusPage() {
  const params = useParams();
  const [job, setJob] = createSignal<PublicJob | null>(null);
  const [error, setError] = createSignal("");
  const [downloadLoading, setDownloadLoading] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [displayedProgress, setDisplayedProgress] = createSignal(0);
  const videoVersion = createMemo(() => encodeURIComponent(job()?.updatedAt || String(Date.now())));
  const downloadUrl = createMemo(() => {
    const token = job()?.downloadToken;
    if (!token || typeof window === "undefined") return "";
    return `${window.location.origin}/api/download/${token}/video?v=${videoVersion()}`;
  });
  const videoUrl = createMemo(() => {
    const url = downloadUrl();
    if (!url) return "";
    return `${url}&preload=1`;
  });
  const posterUrl = createMemo(() => {
    const current = job();
    if (!current) return "";
    return `/api/jobs/${current.id}/preview?kind=poster&v=${videoVersion()}`;
  });

  createEffect(() => {
    const progress = job()?.progress;
    if (progress != null) requestAnimationFrame(() => setDisplayedProgress(Math.min(100, Math.max(0, Math.round(progress)))));
  });

  const statusText = createMemo(() => {
    const current = job();
    if (!current) return "Loading your FaceReel...";
    if (current.status === "failed") return "Something went wrong.";
    if (current.status === "completed") return "Your FaceReel is ready.";
    if (current.status === "queued") return current.queuePosition ? `Queued at position ${current.queuePosition}.` : "Queued.";
    return activeStatusText(current);
  });

  async function load() {
    try {
      const response = await fetch(`/api/jobs/${params.id}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to load job.");
      setJob(data.job);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load job.");
    }
  }

  onMount(() => {
    void trackUiEvent("status_page_viewed", {}, params.id);
    void load();
    const interval = window.setInterval(() => {
      const current = job();
      if (!current || (current.status !== "completed" && current.status !== "failed")) void load();
    }, 2500);
    onCleanup(() => window.clearInterval(interval));
  });

  async function downloadVideo() {
    const current = job();
    if (!current?.downloadToken || downloadLoading()) return;
    setDownloadLoading(true);
    setMessage("");
    try {
      const response = await fetch(downloadUrl());
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error || "Video is not ready yet.");
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `facereel-${current.username}-video.mp4`;
      link.style.display = "none";
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (downloadError) {
      setMessage(downloadError instanceof Error ? downloadError.message : "Unable to download the video.");
    } finally {
      setDownloadLoading(false);
    }
  }

  async function shareVideo() {
    const url = downloadUrl();
    const current = job();
    if (!url || !current) return;
    try {
      if (navigator.share) {
        await navigator.share({ title: `FaceReel for @${current.username}`, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setMessage("Video link copied.");
    } catch (shareError) {
      if (shareError instanceof DOMException && shareError.name === "AbortError") return;
      setMessage("Unable to share the video.");
    }
  }

  return (
    <div class="page">
      <header class="topbar">
        <A class="brand" href="/">
          <span class="brand-mark" aria-hidden="true" />
          <span>FaceReel</span>
        </A>
      </header>

      <Show when={error()}>
        <Panel class="form-panel">
          <XCircle size={32} />
          <h1>Job not found</h1>
          <p class="message">{error()}</p>
        </Panel>
      </Show>

      <Show when={job()}>
        {(current) => (
          <div class="status-layout">
            <Panel class="status-card">
              <div class="status-heading">
                <Badge tone={badgeTone(current().status)}>{current().status}</Badge>
                <h1>{statusText()}</h1>
                <p class="lede">@{current().username}</p>
              </div>

              <div class="progress-track" aria-label={`Progress ${displayedProgress()}%`}>
                <div class="progress-fill" style={{ width: `${displayedProgress()}%` }} />
              </div>

              <Show when={current().status !== "completed"}>
                <p class="status-current-text">{progressDetailText(current())}</p>
              </Show>

              <Show when={current().status !== "completed" && current().status !== "failed"}>
                <p class="message message-inline status-wait-message">
                  <Clock size={18} />
                  <span>{waitMessage(current())}</span>
                </p>
              </Show>

              <Show when={current().status === "completed"}>
                <div class="admin-grid compact-grid">
                  <Metric label="Instagram photos" value={current().igPostCount ?? current().scanCount} />
                  <Metric label="Face photos" value={current().matchedCount} />
                  <Metric label="Processing time" value={formatDuration(current().processingSeconds)} />
                </div>
              </Show>

              <Show when={current().status === "failed"}>
                <p class="message" role="alert">{current().errorMessage}</p>
              </Show>

              <Show when={current().status === "completed" && current().downloadToken}>
                <Show when={videoUrl()}>
                  <div class="video-preview">
                    <video
                      class="result-video"
                      src={videoUrl()}
                      poster={posterUrl()}
                      controls
                      preload="metadata"
                      playsinline
                    />
                  </div>
                </Show>
                <div class="download-list download-actions">
                  <Button type="button" onClick={downloadVideo} disabled={downloadLoading()}>
                    <Show when={downloadLoading()} fallback={<Download size={17} />}>
                      <LoaderCircle class="spin" size={17} />
                    </Show>
                    Download MP4
                  </Button>
                  <Button type="button" variant="secondary" onClick={shareVideo}>
                    <Share2 size={17} />
                    Share
                  </Button>
                </div>
                <Show when={current().cleanupAfter}>
                  <p class="message">Files are retained until {formatDate(current().cleanupAfter)}.</p>
                </Show>
              </Show>

              <Show when={message()}>
                <p class="message" role="status">{message()}</p>
              </Show>
            </Panel>
          </div>
        )}
      </Show>
    </div>
  );
}

function Metric(props: { label: string; value: unknown }) {
  return (
    <div class="metric">
      <strong>{String(props.value ?? 0)}</strong>
      <span>{props.label}</span>
    </div>
  );
}

function activeStatusText(job: PublicJob): string {
  if (job.step === "Finding photos" || job.step === "Instagram verified" || job.step === "Job created") return "Scanning Instagram...";
  if (job.step === "Scanning faces") {
    if (job.scanCount > 0) return "Scanning for face...";
    return foundInstagramText(job);
  }
  if (job.step === "Downloading matches") return foundFaceText(job);
  if (job.step === "Aligning faces" || job.step === "Rendering video") return "Processing FaceReel...";
  return "Processing FaceReel...";
}

function progressDetailText(job: PublicJob): string {
  if (job.status === "queued") return queueDetailText(job);
  if (job.status === "failed") return "Processing stopped before the FaceReel could be completed.";
  if (job.step === "Finding photos" || job.step === "Instagram verified" || job.step === "Job created") return "Looking through Instagram photos.";
  if (job.step === "Scanning faces") {
    if (job.scanCount > 0) return foundInstagramText(job);
    return "Preparing photos for face matching.";
  }
  if (job.step === "Downloading matches" || job.step === "Aligning faces") return foundFaceText(job);
  if (job.step === "Rendering video") return "Rendering the final vertical MP4.";
  return job.step;
}

function queueDetailText(job: PublicJob): string {
  const position = job.queuePosition;
  const wait = formatEstimate(job.estimatedWaitSeconds);
  if (position && position > 1) return wait ? `You're #${position} in line. Estimated wait: ${wait}.` : `You're #${position} in line.`;
  if (position === 1) return "You're next in line.";
  return "Waiting to start scanning Instagram.";
}

function waitMessage(job: PublicJob): string {
  const ready = formatEstimate(job.estimatedReadySeconds);
  const estimate = ready ? ` It should be ready in about ${ready}.` : "";
  return `This page updates automatically, but you do not need to wait here.${estimate} We'll email you when your FaceReel is ready.`;
}

function foundInstagramText(job: PublicJob): string {
  const count = job.igPostCount ?? job.scanCount;
  if (!count) return "Found Instagram photos.";
  return `Found ${formatCount(count, "Instagram photo")}.`;
}

function foundFaceText(job: PublicJob): string {
  if (!job.matchedCount) return "Scanning for face.";
  return `Found ${formatCount(job.matchedCount, "photo")} of the target face.`;
}

function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function badgeTone(status: PublicJob["status"]): "neutral" | "success" | "warning" | "danger" {
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  if (status === "queued") return "warning";
  return "neutral";
}

function formatDuration(value: unknown): string {
  if (value == null) return "0s";
  const seconds = Math.max(0, Math.round(Number(value) || 0));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes <= 0) return `${remainingSeconds}s`;
  return `${minutes}m ${remainingSeconds}s`;
}

function formatEstimate(value: unknown): string {
  if (value == null) return "";
  const seconds = Math.max(0, Math.round(Number(value) || 0));
  if (!seconds) return "";
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (!remainingMinutes) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${hours} hour${hours === 1 ? "" : "s"} ${remainingMinutes} minute${remainingMinutes === 1 ? "" : "s"}`;
}

function formatDate(value: string | null): string {
  if (!value) return "";
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
