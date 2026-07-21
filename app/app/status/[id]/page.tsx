"use client";
import { use, useEffect, useRef, useState } from "react";
type Job = {
  id: string;
  status: "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED";
  progress: number;
  stage: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  assets: Array<{ id: string; assetType: string; variant: string; contentType?: string }>;
};
const labels: Record<string, string> = {
  QUEUED: "Queued",
  DOWNLOADING_IMAGES: "Downloading your photos",
  VALIDATING_IMAGES: "Validating your photos",
  DETECTING_FACES: "Detecting faces",
  ALIGNING_FACES: "Aligning faces",
  GENERATING_FRAMES: "Creating video frames",
  ENCODING_VIDEO: "Rendering your FaceReel",
  UPLOADING_OUTPUTS: "Uploading your completed video",
  FINALIZING: "Finishing up",
  COMPLETED: "Your FaceReel is ready",
};
export default function Status({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [job, setJob] = useState<Job>();
  const [error, setError] = useState("");
  const [access, setAccess] = useState("");
  const [shareLoading, setShareLoading] = useState(false);
  const [actionMessage, setActionMessage] = useState("");
  const shareFile = useRef<File | null>(null);
  useEffect(() => {
    const queryAccess = new URLSearchParams(window.location.search).get("access") || "";
    setAccess(queryAccess);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let delay = 2500;
    const load = async () => {
      try {
        const response = await fetch(`/api/render-jobs/${id}`, {
          cache: "no-store",
          headers: queryAccess ? { "x-facereel-access": queryAccess } : {},
        });
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error || "Unable to load render");
        if (stopped) return;
        setJob(data);
        setError("");
        if (!["COMPLETED", "FAILED", "CANCELLED"].includes(data.status))
          timer = setTimeout(load, delay);
      } catch (e) {
        if (stopped) return;
        setError(e instanceof Error ? e.message : "Unable to load render");
        delay = Math.min(10000, delay * 1.5);
        timer = setTimeout(load, delay);
      }
    };
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id]);
  const videoAsset = job?.assets.find((asset) => asset.assetType === "MASTER_VIDEO");
  const posterAsset = job?.assets.find((asset) => asset.assetType === "POSTER_FRAME");
  const videoUrl = job && videoAsset ? assetUrl(job.id, videoAsset.id, access) : "";
  const posterUrl = job && posterAsset ? assetUrl(job.id, posterAsset.id, access) : "";

  async function shareVideo() {
    if (!job || !videoAsset || shareLoading) return;
    setShareLoading(true);
    setActionMessage("");
    try {
      if (!navigator.share) {
        setActionMessage("Sharing is not supported in this browser. You can download the video instead.");
        return;
      }
      let file = shareFile.current;
      if (!file) {
        const response = await fetch(videoUrl);
        if (!response.ok) throw new Error("The video could not be loaded for sharing.");
        const blob = await response.blob();
        file = new File([blob], `facereel-${job.id}.mp4`, {
          type: blob.type || videoAsset.contentType || "video/mp4",
        });
        shareFile.current = file;
      }
      if (!navigator.canShare?.({ files: [file] })) {
        setActionMessage("Sharing video files is not supported in this browser. You can download the video instead.");
        return;
      }
      if (navigator.userActivation && !navigator.userActivation.isActive) {
        setActionMessage("Your video is ready to share. Tap Share video again to open the share sheet.");
        return;
      }
      await navigator.share({
        files: [file],
        title: "My FaceReel",
        text: "Made with FaceReel.net",
      });
    } catch (shareError) {
      if (shareError instanceof DOMException && shareError.name === "AbortError") return;
      setActionMessage(shareError instanceof Error ? shareError.message : "Unable to share the video.");
    } finally {
      setShareLoading(false);
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" />
          FaceReel
        </div>
      </header>
      <section className="panel form-panel status-card">
        <h1>
          {job
            ? labels[job.stage] || job.stage.replaceAll("_", " ").toLowerCase()
            : "Loading your FaceReel…"}
        </h1>
        {job && (
          <>
            <div className="progress-track">
              <div
                className="progress-fill"
                style={{ width: `${job.progress}%` }}
              />
            </div>
            <p>
              {job.progress}% · {job.status.toLowerCase()}
            </p>
            {(job.status === "QUEUED" || job.status === "PROCESSING") && (
              <div className="status-box status-wait-message" role="status">
                <MailIcon />
                <span>
                  <strong>You don&apos;t need to stay on this page.</strong><br />
                  We&apos;ll email you when your FaceReel is ready, or if we need you to try again.
                </span>
              </div>
            )}
            {job.status === "FAILED" && (
              <p className="message" role="alert">
                {job.errorMessage || "Rendering failed."}{" "}
                {job.errorCode && `(${job.errorCode})`}
              </p>
            )}
            {job.status === "COMPLETED" && videoAsset && (
              <div className="completed-result">
                <div className="video-preview">
                  <div className="video-shell">
                    <video
                      className="result-video"
                      src={videoUrl}
                      poster={posterUrl || undefined}
                      controls
                      preload="metadata"
                      playsInline
                    >
                      Your browser does not support video playback.
                    </video>
                  </div>
                </div>
                <div className="download-list download-actions">
                  <a
                    className="button button-primary"
                    href={assetUrl(job.id, videoAsset.id, access, true)}
                  >
                    <DownloadIcon />
                    Download video
                  </a>
                  <button
                    className="button button-secondary"
                    type="button"
                    onClick={shareVideo}
                    disabled={shareLoading}
                  >
                    {shareLoading ? <SpinnerIcon /> : <ShareIcon />}
                    {shareLoading ? "Preparing video…" : "Share video"}
                  </button>
                </div>
                {actionMessage && <p className="message" role="status">{actionMessage}</p>}
              </div>
            )}
            {job.status === "COMPLETED" && !videoAsset && (
              <p className="message" role="alert">The completed video is not available yet. Please refresh this page in a moment.</p>
            )}
          </>
        )}
        {error && (
          <p className="message" role="alert">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}

function assetUrl(jobId: string, assetId: string, access: string, download = false) {
  const query = new URLSearchParams();
  if (access) query.set("access", access);
  if (download) query.set("download", "1");
  const suffix = query.size ? `?${query.toString()}` : "";
  return `/api/render-jobs/${jobId}/assets/${assetId}${suffix}`;
}

function MailIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="m8.6 10.5 6.8-4" />
      <path d="m8.6 13.5 6.8 4" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg className="spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-6.2-8.6" />
    </svg>
  );
}
