"use client";
import { useEffect, useState } from "react";
type Job = {
  id: string;
  status: "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED";
  progress: number;
  stage: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  assets: Array<{ id: string; assetType: string; variant: string }>;
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
  const [id, setId] = useState("");
  const [job, setJob] = useState<Job>();
  const [error, setError] = useState("");
  const [access, setAccess] = useState("");
  useEffect(() => {
    void params.then((p) => setId(p.id));
  }, [params]);
  useEffect(() => {
    if (!id) return;
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
            {job.status === "FAILED" && (
              <p className="message" role="alert">
                {job.errorMessage || "Rendering failed."}{" "}
                {job.errorCode && `(${job.errorCode})`}
              </p>
            )}
            {job.status === "COMPLETED" &&
              job.assets.map((a) => (
                <a
                  className="button"
                  key={a.id}
                  href={`/api/render-jobs/${job.id}/assets/${a.id}${access ? `?access=${encodeURIComponent(access)}` : ""}`}
                >
                  {a.assetType === "MASTER_VIDEO"
                    ? "Download video"
                    : "View poster"}
                </a>
              ))}
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
