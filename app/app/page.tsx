"use client";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        body: new FormData(event.currentTarget),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Unable to submit FaceReel");
      router.push(`/status/${data.jobId}`);
    } catch (value) {
      setError(
        value instanceof Error ? value.message : "Unable to submit FaceReel",
      );
      setBusy(false);
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
      <div className="landing-layout">
        <section className="panel form-panel">
          <div className="panel-header">
            <h1>Create a face-aligned reel from Instagram photos.</h1>
            <p className="lede">
              Upload one clear target face, enter a public Instagram handle, and
              get a shareable video.
            </p>
          </div>
          <form className="form-grid" onSubmit={submit}>
            <label className="label">
              Instagram username
              <input
                className="input"
                name="username"
                required
                pattern="[A-Za-z0-9._]{1,30}"
                placeholder="yourhandle"
              />
            </label>
            <label className="label">
              Email
              <input
                className="input"
                name="email"
                required
                type="email"
                placeholder="you@example.com"
              />
            </label>
            <label className="label">
              Target face
              <input
                className="input"
                name="targetFace"
                required
                type="file"
                accept="image/jpeg,image/png,image/webp"
              />
              <span className="file-subtitle">
                JPG, PNG, or WEBP up to 15MB.
              </span>
            </label>
            <button className="button" disabled={busy}>
              {busy ? "Submitting…" : "Generate FaceReel"}
            </button>
            {error && (
              <p className="message" role="alert">
                {error}
              </p>
            )}
          </form>
        </section>
      </div>
    </div>
  );
}
