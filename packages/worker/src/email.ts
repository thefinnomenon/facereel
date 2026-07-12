import { logError, trackEvent } from "@facereel/db";
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
  const queueText = queueSummaryText(input);
  const queueHtml = queueSummaryHtml(input);
  await sendEmail({
    to: input.to,
    subject: input.estimatedWaitSeconds && input.estimatedWaitSeconds > 0 ? "Your FaceReel is queued" : "Your FaceReel is processing",
    text: `Your FaceReel for @${input.username} was submitted.\n\n${queueText}\n\nStatus: ${appUrl()}/status/${input.jobId}`,
    html: `
      <h1 style="font-size:22px">Your FaceReel was submitted</h1>
      <p>We received your FaceReel for @${escapeHtml(input.username)}.</p>
      ${queueHtml}
      <p><a href="${appUrl()}/status/${input.jobId}">View status</a></p>
    `,
    event: "processing_email_sent",
    jobId: input.jobId,
    user: input.to
  });
}

export async function sendReadyEmail(input: EmailInput): Promise<void> {
  await sendEmail({
    to: input.to,
    subject: "Your FaceReel is ready",
    text: `Your FaceReel for @${input.username} is ready.\n\nDownload it here: ${appUrl()}/status/${input.jobId}`,
    html: `
      <h1 style="font-size:22px">Your FaceReel is ready</h1>
      <p>Your FaceReel for @${escapeHtml(input.username)} is ready.</p>
      <p><a href="${appUrl()}/status/${input.jobId}">Download video</a></p>
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
  if (!apiKey) return;

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
