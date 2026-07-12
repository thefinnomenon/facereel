import { useNavigate } from "@solidjs/router";
import { ArrowRight, Check, ImagePlus, LoaderCircle, RefreshCw, Sparkles, XCircle } from "lucide-solid";
import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Button, Panel, TextInput, trackUiEvent } from "../components/ui.tsx";

type CheckState = "idle" | "checking" | "public" | "private" | "not_found" | "error";

export default function LandingPage() {
  const navigate = useNavigate();
  const [username, setUsername] = createSignal("");
  const [email, setEmail] = createSignal("");
  const [targetFile, setTargetFile] = createSignal<File | null>(null);
  const [targetPreview, setTargetPreview] = createSignal<string | null>(null);
  const [emailSettled, setEmailSettled] = createSignal(false);
  const [checkState, setCheckState] = createSignal<CheckState>("idle");
  const [message, setMessage] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);
  const [submitError, setSubmitError] = createSignal("");
  const startedAt = Date.now();
  let handleStartedTracked = false;

  const emailValid = createMemo(() => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email().trim()));
  const showEmailValidation = createMemo(() => emailSettled() && email().trim().length > 0);
  const canSubmit = createMemo(() => checkState() === "public" && Boolean(targetFile()) && emailValid() && !submitting());

  onMount(() => {
    void trackUiEvent("landing_page_loaded");
    void trackUiEvent("page_view", { page: "landing" });
  });

  onCleanup(() => {
    const preview = targetPreview();
    if (preview) URL.revokeObjectURL(preview);
  });

  createEffect(() => {
    const value = username().trim();
    if (value.length > 0 && !handleStartedTracked) {
      handleStartedTracked = true;
      void trackUiEvent("instagram_handle_started");
    }
    if (value.length < 2) {
      setCheckState("idle");
      setMessage("");
      return;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => void runInstagramCheck(controller.signal), 700);
    onCleanup(() => {
      window.clearTimeout(timeout);
      controller.abort();
    });
  });

  createEffect(() => {
    const value = email().trim();
    setEmailSettled(false);
    if (!value) return;
    const timeout = window.setTimeout(() => setEmailSettled(true), 700);
    onCleanup(() => window.clearTimeout(timeout));
  });

  async function runInstagramCheck(signal?: AbortSignal) {
    const value = username().trim();
    if (value.length < 2) return;
    setCheckState("checking");
    setMessage("");
    try {
      const params = new URLSearchParams({ username: value });
      if (emailValid()) params.set("email", email().trim());
      const response = await fetch(`/api/instagram/check?${params.toString()}`, signal ? { signal } : undefined);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Instagram check failed.");
      setCheckState(data.status);
      if (data.status === "public") setMessage("");
      else if (data.status === "private") setMessage("This Instagram profile is private.");
      else if (data.status === "not_found") setMessage("Instagram profile not found.");
      else setMessage("Unable to verify Instagram right now.");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setCheckState("error");
      setMessage(error instanceof Error ? error.message : "Unable to verify Instagram right now.");
    }
  }

  function onTargetChange(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    const existingPreview = targetPreview();
    if (existingPreview) URL.revokeObjectURL(existingPreview);
    setTargetFile(file);
    setTargetPreview(file ? URL.createObjectURL(file) : null);
    if (file) void trackUiEvent("target_face_uploaded", { bytes: file.size, mime: file.type }, undefined, email() || undefined);
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!canSubmit()) return;
    const submittedAt = Date.now();
    setSubmitting(true);
    setSubmitError("");
    void trackUiEvent("submit_clicked", { username: username().trim() }, undefined, email().trim());

    const data = new FormData(event.currentTarget as HTMLFormElement);
    try {
      const response = await fetch("/api/jobs", { method: "POST", body: data });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to create job.");
      await wait(Math.max(0, 1200 - (Date.now() - submittedAt)));
      navigate(`/status/${payload.job.id}`);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Unable to create job.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div class="page">
      <header class="topbar">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true" />
          <span>FaceReel</span>
        </div>
      </header>

      <div class="landing-layout">
        <Panel class="form-panel">
          <div class="panel-header">
            <h1>Create a face-aligned reel from Instagram photos.</h1>
            <p class="lede">Upload one target face, enter a public Instagram handle, and get a shareable video.</p>
          </div>

          <form class="form-grid" onSubmit={submit}>
            <input type="hidden" name="startedAt" value={startedAt} />
            <label class="hidden-field">
              Website
              <input name="website" autocomplete="off" tabindex="-1" />
            </label>

            <div class="label">
              <label for="instagram-username">Instagram username</label>
              <div class={`username-field-wrap ${checkState() === "public" ? "username-valid" : ["private", "not_found", "error"].includes(checkState()) ? "username-invalid" : ""}`}>
                <TextInput
                  id="instagram-username"
                  class="username-field"
                  name="username"
                  placeholder="yourhandle"
                  value={username()}
                  autocomplete="off"
                  aria-invalid={["private", "not_found", "error"].includes(checkState()) ? "true" : "false"}
                  aria-describedby={message() ? "instagram-check-message" : undefined}
                  onInput={(event) => {
                    setUsername(event.currentTarget.value);
                    setCheckState("idle");
                    setMessage("");
                  }}
                />
                <UsernameCheckControl state={checkState()} onRetry={() => void runInstagramCheck()} />
              </div>
              <InstagramMessage state={checkState()} message={message()} />
            </div>

            <label class="label">
              Email
              <div class={`email-field-wrap ${showEmailValidation() ? emailValid() ? "email-valid" : "email-invalid" : ""}`}>
                <TextInput
                  class="email-field"
                  name="email"
                  type="email"
                  placeholder="you@example.com"
                  value={email()}
                  aria-invalid={showEmailValidation() && !emailValid() ? "true" : "false"}
                  aria-describedby={showEmailValidation() && !emailValid() ? "email-message" : undefined}
                  onInput={(event) => setEmail(event.currentTarget.value)}
                  onBlur={() => setEmailSettled(email().trim().length > 0)}
                />
                <EmailCheckControl show={showEmailValidation()} valid={emailValid()} />
              </div>
              <EmailMessage show={showEmailValidation()} valid={emailValid()} />
            </label>

            <label class="label">
              Target face
              <span class="file-drop">
                <input name="targetFace" type="file" accept="image/jpeg,image/png,image/webp" onChange={onTargetChange} />
                <span class="file-icon">
                  <Show when={targetPreview()} fallback={<ImagePlus size={22} />}>
                    {(src) => <img class="file-thumbnail" src={src()} alt="Selected target face" />}
                  </Show>
                </span>
                <span class="file-meta">
                  <span class="file-title">{targetFile() ? "Target face selected" : "Choose a clear face photo"}</span>
                  <span class="file-subtitle">{targetFile()?.name || "One face, JPG, PNG, or WEBP up to 15MB."}</span>
                </span>
              </span>
            </label>

            <Button type="submit" disabled={!canSubmit()}>
              <Show when={submitting()} fallback={<Sparkles size={18} />}>
                <LoaderCircle class="spin" size={18} />
              </Show>
              {submitting() ? "Creating FaceReel..." : "Generate FaceReel"}
              <Show when={!submitting()}>
                <ArrowRight size={18} />
              </Show>
            </Button>
            <Show when={submitError()}>
              <p class="message" role="alert">{submitError()}</p>
            </Show>
          </form>
        </Panel>
      </div>
    </div>
  );
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function EmailCheckControl(props: { show: boolean; valid: boolean }) {
  return (
    <div class="email-check-control" aria-live="polite">
      <Show when={props.show && props.valid}><Check size={18} aria-label="Email looks good" /></Show>
      <Show when={props.show && !props.valid}><XCircle size={18} aria-label="Email needs attention" /></Show>
    </div>
  );
}

function EmailMessage(props: { show: boolean; valid: boolean }) {
  return (
    <Show when={props.show && !props.valid}>
      <p id="email-message" class="input-message input-message-danger" role="status">Enter a valid email address.</p>
    </Show>
  );
}

function UsernameCheckControl(props: { state: CheckState; onRetry: () => void }) {
  return (
    <div class="username-check-control" aria-live="polite">
      <Show when={props.state === "checking"}><LoaderCircle class="spin" size={18} aria-label="Checking Instagram username" /></Show>
      <Show when={props.state === "public"}><Check size={18} aria-label="Instagram profile is public" /></Show>
      <Show when={props.state === "private" || props.state === "not_found" || props.state === "error"}>
        <button class="input-icon-button" type="button" onClick={props.onRetry} aria-label="Retry Instagram check">
          <RefreshCw size={16} />
        </button>
      </Show>
    </div>
  );
}

function InstagramMessage(props: { state: CheckState; message: string }) {
  return (
    <Show when={props.state === "private" || props.state === "not_found" || props.state === "error"}>
      <p id="instagram-check-message" class={`input-message ${props.state === "private" ? "input-message-warning" : "input-message-danger"}`} role="status">
        {props.message}
      </p>
    </Show>
  );
}
