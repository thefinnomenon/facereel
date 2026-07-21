"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type CheckState =
  | "idle"
  | "checking"
  | "public"
  | "private"
  | "not_found"
  | "error";

const invalidUsernameStates: CheckState[] = ["private", "not_found", "error"];

export default function Home() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [emailTouched, setEmailTouched] = useState(false);
  const [targetFile, setTargetFile] = useState<File | null>(null);
  const [targetPreview, setTargetPreview] = useState<string | null>(null);
  const [checkState, setCheckState] = useState<CheckState>("idle");
  const [checkMessage, setCheckMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestNumber = useRef(0);

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const usernameInvalid = invalidUsernameStates.includes(checkState);
  const canSubmit =
    checkState === "public" && Boolean(targetFile) && emailValid && !busy;

  useEffect(() => {
    return () => {
      if (targetPreview) URL.revokeObjectURL(targetPreview);
    };
  }, [targetPreview]);

  useEffect(() => {
    const value = username.trim().replace(/^@+/, "");
    const currentRequest = ++requestNumber.current;

    if (value.length < 2) {
      setCheckState("idle");
      setCheckMessage("");
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setCheckState("checking");
      setCheckMessage("");
      try {
        const params = new URLSearchParams({ username: value });
        const response = await fetch(`/api/instagram/check?${params}`, {
          signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || "Unable to verify Instagram right now.");
        }
        if (currentRequest !== requestNumber.current) return;
        const state = data.status as CheckState;
        setCheckState(state);
        setCheckMessage(
          state === "private"
            ? "This Instagram profile is private."
            : state === "not_found"
              ? "Instagram profile not found."
              : state === "public"
                ? ""
                : "Unable to verify Instagram right now.",
        );
      } catch (value) {
        if (value instanceof DOMException && value.name === "AbortError") return;
        if (currentRequest !== requestNumber.current) return;
        setCheckState("error");
        setCheckMessage(
          value instanceof Error
            ? value.message
            : "Unable to verify Instagram right now.",
        );
      }
    }, 700);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [username]);

  async function retryInstagramCheck() {
    const value = username.trim().replace(/^@+/, "");
    if (value.length < 2) return;
    const currentRequest = ++requestNumber.current;
    setCheckState("checking");
    setCheckMessage("");
    try {
      const params = new URLSearchParams({ username: value });
      const response = await fetch(`/api/instagram/check?${params}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to verify Instagram right now.");
      if (currentRequest !== requestNumber.current) return;
      setCheckState(data.status);
      setCheckMessage(
        data.status === "private"
          ? "This Instagram profile is private."
          : data.status === "not_found"
            ? "Instagram profile not found."
            : "",
      );
    } catch (value) {
      if (currentRequest !== requestNumber.current) return;
      setCheckState("error");
      setCheckMessage(value instanceof Error ? value.message : "Unable to verify Instagram right now.");
    }
  }

  function selectTarget(file: File | null) {
    setTargetFile(file);
    setTargetPreview(file ? URL.createObjectURL(file) : null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        body: new FormData(event.currentTarget),
      });
      const contentType = response.headers.get("content-type") || "";
      const data = contentType.includes("application/json")
        ? await response.json()
        : null;
      if (!response.ok) {
        throw new Error(data?.error || "Unable to submit FaceReel. Please try again.");
      }
      if (!data?.jobId) throw new Error("FaceReel returned an invalid response.");
      router.push(`/status/${data.jobId}`);
    } catch (value) {
      setError(value instanceof Error ? value.message : "Unable to submit FaceReel");
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span>FaceReel</span>
        </div>
      </header>
      <div className="landing-layout">
        <section className="panel form-panel">
          <div className="panel-header">
            <h1>Create a face-aligned reel from Instagram photos.</h1>
            <p className="lede">
              Upload one clear target face, enter a public Instagram handle, and get a shareable video.
            </p>
          </div>
          <form className="form-grid" onSubmit={submit}>
            <div className="label">
              <label htmlFor="instagram-username">Instagram username</label>
              <div className={`username-field-wrap ${checkState === "public" ? "username-valid" : usernameInvalid ? "username-invalid" : ""}`}>
                <input
                  id="instagram-username"
                  className="field username-field"
                  name="username"
                  required
                  pattern="[A-Za-z0-9._]{1,30}"
                  placeholder="yourhandle"
                  autoComplete="off"
                  value={username}
                  aria-invalid={usernameInvalid}
                  aria-describedby={checkMessage ? "instagram-check-message" : undefined}
                  onChange={(event) => setUsername(event.currentTarget.value)}
                />
                <div className="username-check-control" aria-live="polite">
                  {checkState === "checking" && <Icon name="loader" label="Checking Instagram username" />}
                  {checkState === "public" && <Icon name="check" label="Instagram profile is public" />}
                  {usernameInvalid && (
                    <button className="input-icon-button" type="button" onClick={retryInstagramCheck} aria-label="Retry Instagram check">
                      <Icon name="retry" />
                    </button>
                  )}
                </div>
              </div>
              {checkMessage && (
                <p id="instagram-check-message" className={`input-message ${checkState === "private" ? "input-message-warning" : "input-message-danger"}`} role="status">
                  {checkMessage}
                </p>
              )}
            </div>

            <div className="label">
              <label htmlFor="email">Email</label>
              <div className={`email-field-wrap ${emailTouched && email ? emailValid ? "email-valid" : "email-invalid" : ""}`}>
                <input
                  id="email"
                  className="field email-field"
                  name="email"
                  required
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  aria-invalid={emailTouched && !emailValid}
                  aria-describedby={emailTouched && !emailValid ? "email-message" : undefined}
                  onChange={(event) => setEmail(event.currentTarget.value)}
                  onBlur={() => setEmailTouched(true)}
                />
                <div className="email-check-control" aria-live="polite">
                  {emailTouched && email && <Icon name={emailValid ? "check" : "error"} label={emailValid ? "Email looks good" : "Email needs attention"} />}
                </div>
              </div>
              {emailTouched && email && !emailValid && (
                <p id="email-message" className="input-message input-message-danger" role="status">Enter a valid email address.</p>
              )}
            </div>

            <label className="label">
              Target face
              <span className="file-drop">
                <input name="targetFace" required type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => selectTarget(event.currentTarget.files?.[0] ?? null)} />
                <span className="file-icon">
                  {targetPreview ? <img className="file-thumbnail" src={targetPreview} alt="Selected target face" /> : <Icon name="image" />}
                </span>
                <span className="file-meta">
                  <span className="file-title">{targetFile ? "Target face selected" : "Choose a clear face photo"}</span>
                  <span className="file-subtitle">{targetFile?.name || "One face, JPG, PNG, or WEBP up to 15MB."}</span>
                </span>
              </span>
            </label>

            <button className="button button-primary" disabled={!canSubmit}>
              <Icon name={busy ? "loader" : "sparkles"} />
              {busy ? "Creating FaceReel…" : "Generate FaceReel"}
              {!busy && <Icon name="arrow" />}
            </button>
            {error && <p className="message" role="alert">{error}</p>}
          </form>
        </section>
      </div>
    </div>
  );
}

function Icon({ name, label }: { name: "arrow" | "check" | "error" | "image" | "loader" | "retry" | "sparkles"; label?: string }) {
  const paths = {
    arrow: <><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    error: <><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></>,
    image: <><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 15-5-5L5 20"/></>,
    loader: <><path d="M21 12a9 9 0 1 1-6.2-8.6"/></>,
    retry: <><path d="M20 7v5h-5"/><path d="M18.5 16a8 8 0 1 1 1.1-7.3L20 12"/></>,
    sparkles: <><path d="m12 3-1.4 3.6L7 8l3.6 1.4L12 13l1.4-3.6L17 8l-3.6-1.4L12 3Z"/><path d="m5 14-.8 2.2L2 17l2.2.8L5 20l.8-2.2L8 17l-2.2-.8L5 14Z"/></>,
  };
  return <svg className={name === "loader" ? "spin" : undefined} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label={label} aria-hidden={label ? undefined : true}>{paths[name]}</svg>;
}
