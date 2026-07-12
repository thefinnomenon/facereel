import { logError, logWarn, trackEvent } from "@facereel/db";
import { appUrl } from "./validation.ts";

type EmailInput = {
  to: string;
  jobId: string;
  username: string;
};

type ProcessingEmailInput = EmailInput & {
  queuePosition?: number | null;
  estimatedWaitSeconds?: number | null;
  estimatedReadySeconds?: number | null;
};

export async function sendProcessingEmail(input: ProcessingEmailInput): Promise<void> {
  const statusUrl = `${appUrl()}/status/${input.jobId}`;
  const queueText = queueSummaryText(input);
  const queueHtml = queueSummaryHtml(input);
  await sendEmail({
    to: input.to,
    subject: input.estimatedWaitSeconds && input.estimatedWaitSeconds > 0 ? "Your FaceReel is queued" : "We're creating your FaceReel",
    text: [
      `Your FaceReel for @${input.username} was submitted.`,
      "",
      queueText,
      "",
      "This usually takes 5-10 minutes on the server.",
      "You do not need to keep the status page open. We'll email you again as soon as the video is ready.",
      "Please keep the Instagram profile public until processing finishes.",
      "",
      `You can follow the progress here: ${statusUrl}`
    ].join("\n"),
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#17202a">
        <h1 style="font-size:22px">We're creating your FaceReel</h1>
        <p>Your FaceReel for <strong>@${escapeHtml(input.username)}</strong> was submitted.</p>
        ${queueHtml}
        <p>This usually takes 5-10 minutes on the server.</p>
        <p>You do not need to keep the status page open. We'll email you again as soon as the video is ready.</p>
        <p>Please keep the Instagram profile public until processing finishes.</p>
        <p><a href="${statusUrl}" style="display:inline-block;background:#17202a;color:white;padding:12px 16px;border-radius:6px;text-decoration:none">View Status</a></p>
      </div>
    `,
    event: "processing_email_sent",
    jobId: input.jobId,
    user: input.to
  });
}

export async function sendReadyEmail(input: EmailInput): Promise<void> {
  const statusUrl = `${appUrl()}/status/${input.jobId}`;
  await sendEmail({
    to: input.to,
    subject: "Your FaceReel is ready",
    text: [
      `Your FaceReel for @${input.username} is ready.`,
      "",
      `Watch and download it here: ${statusUrl}`
    ].join("\n"),
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#17202a">
        <h1 style="font-size:22px">Your FaceReel is ready</h1>
        <p>Your FaceReel for <strong>@${escapeHtml(input.username)}</strong> is ready.</p>
        <p><a href="${statusUrl}" style="display:inline-block;background:#17202a;color:white;padding:12px 16px;border-radius:6px;text-decoration:none">Watch and Download</a></p>
      </div>
    `,
    event: "ready_email_sent",
    jobId: input.jobId,
    user: input.to
  });
}

export async function sendAdminJobCreatedEmail(input: {
  jobId: string;
  username: string;
  customerEmail: string;
  ip?: string;
}): Promise<void> {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return;
  await sendEmail({
    to: adminEmail,
    subject: `New FaceReel started: @${input.username}`,
    text: `A new FaceReel was submitted for @${input.username} by ${input.customerEmail}.\n\nStatus: ${appUrl()}/status/${input.jobId}`,
    html: `
      <h1 style="font-size:22px">New FaceReel started</h1>
      <p><strong>@${escapeHtml(input.username)}</strong> submitted a FaceReel.</p>
      <p>Customer: ${escapeHtml(input.customerEmail)}</p>
      <p>IP: ${escapeHtml(input.ip || "unknown")}</p>
      <p><a href="${appUrl()}/status/${input.jobId}">View job</a></p>
    `,
    event: "admin_job_created_email_sent",
    jobId: input.jobId,
    user: input.customerEmail
  });
}

async function sendEmail(input: {
  to: string;
  subject: string;
  text: string;
  html: string;
  event: string;
  jobId: string;
  user: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logWarn({
      event: "email_skipped",
      jobId: input.jobId,
      user: input.user,
      message: "RESEND_API_KEY is not set; email was skipped.",
      metadata: { attemptedEvent: input.event, subject: input.subject }
    });
    return;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || "FaceReel <onboarding@resend.dev>",
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html
    })
  });

  if (!response.ok) {
    const body = await response.text();
    const message = `Resend request failed with HTTP ${response.status}: ${body.slice(0, 300)}`;
    logError({ event: input.event, jobId: input.jobId, user: input.user, message });
    throw new Error(message);
  }

  trackEvent({ event: input.event, jobId: input.jobId, user: input.user });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function queueSummaryText(input: ProcessingEmailInput): string {
  const ready = input.estimatedReadySeconds ? ` Estimated completion: ${formatDuration(input.estimatedReadySeconds)}.` : "";
  if (input.queuePosition && input.queuePosition > 1) {
    const wait = input.estimatedWaitSeconds ? ` Estimated wait before processing: ${formatDuration(input.estimatedWaitSeconds)}.` : "";
    return `You are #${input.queuePosition} in line.${wait}${ready}`;
  }
  if (input.estimatedWaitSeconds && input.estimatedWaitSeconds > 0) {
    return `You are next in line. Estimated wait before processing: ${formatDuration(input.estimatedWaitSeconds)}.${ready}`;
  }
  return `We will start processing it as soon as the worker is available.${ready}`;
}

function queueSummaryHtml(input: ProcessingEmailInput): string {
  return `<p>${escapeHtml(queueSummaryText(input))}</p>`;
}

function formatDuration(secondsInput: number): string {
  const seconds = Math.max(0, Math.round(secondsInput));
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (!remainingMinutes) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${hours} hour${hours === 1 ? "" : "s"} ${remainingMinutes} minute${remainingMinutes === 1 ? "" : "s"}`;
}
