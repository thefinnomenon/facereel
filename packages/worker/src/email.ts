import { prisma } from "@facereel/db";
import { appUrl } from "./validation.ts";
export type EmailKind = "COMPLETION" | "FAILURE" | "PROCESSING";
export async function sendPendingEmail(
  jobId: string,
  kind: EmailKind,
): Promise<void> {
  const delivery = await prisma.emailDelivery.findUnique({
    where: { renderJobId_kind: { renderJobId: jobId, kind } },
  });
  if (!delivery || delivery.status === "SENT") return;
  const staleSendingBefore = new Date(Date.now() - 10 * 60_000);
  if (delivery.status === "SENDING" && delivery.updatedAt >= staleSendingBefore) return;
  const claimed = await prisma.emailDelivery.updateMany({
    where: {
      id: delivery.id,
      OR: [
        { status: { in: ["PENDING", "FAILED"] } },
        { status: "SENDING", updatedAt: { lt: staleSendingBefore } },
      ],
    },
    data: { status: "SENDING", attemptCount: { increment: 1 } },
  });
  if (!claimed.count) return;
  const job = await prisma.renderJob.findUniqueOrThrow({
    where: { id: jobId },
    include: { project: true },
  });
  try {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error("RESEND_API_KEY is not configured");
    const statusUrl = `${appUrl()}/status/${jobId}?access=${encodeURIComponent(job.project.ownerAccessToken)}`;
    const { subject, text, html } = buildEmailContent({
      kind,
      username: job.project.instagramUsername,
      statusUrl,
      errorMessage: job.errorMessage,
    });
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "Idempotency-Key": delivery.id,
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || "FaceReel <onboarding@resend.dev>",
        to: job.email,
        subject,
        text,
        html,
      }),
    });
    if (!response.ok)
      throw new Error(
        `Resend returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`,
      );
    const body = (await response.json()) as { id?: string };
    await prisma.$transaction([
      prisma.emailDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "SENT",
          sentAt: new Date(),
          providerMessageId: body.id ?? null,
          lastError: null,
        },
      }),
      prisma.renderJob.update({
        where: { id: jobId },
        data:
          kind === "COMPLETION"
            ? { completionEmailSentAt: new Date() }
            : kind === "FAILURE"
              ? { failureEmailSentAt: new Date() }
              : {},
      }),
    ]);
  } catch (error) {
    await prisma.emailDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "FAILED",
        lastError: (error instanceof Error
          ? error.message
          : String(error)
        ).slice(0, 500),
      },
    });
    console.error(
      JSON.stringify({
        event: "email_delivery_failed",
        jobId,
        kind,
        message: String(error),
      }),
    );
  }
}

export function buildEmailContent(input: {
  kind: EmailKind;
  username: string;
  statusUrl: string;
  errorMessage?: string | null;
}) {
  const ready = input.kind === "COMPLETION";
  const failed = input.kind === "FAILURE";
  const subject = ready
    ? "Your FaceReel is ready"
    : failed
      ? "We could not create your FaceReel"
      : "We're creating your FaceReel";
  const intro = `FaceReel for @${input.username}.`;
  const failureReason = input.errorMessage || "We could not create a FaceReel from the submitted photos.";
  const processingNotice = "You don't need to stay on the status page. We'll email you when your FaceReel is ready, or if we need you to try again.";
  const detail = failed ? failureReason : input.kind === "PROCESSING" ? processingNotice : "";
  const text = `${subject}\n\n${intro}${detail ? `\n\n${detail}` : ""}\n\nView status: ${input.statusUrl}`;
  const html = `<h1>${escapeHtml(subject)}</h1><p>FaceReel for <strong>@${escapeHtml(input.username)}</strong>.</p>${detail ? `<p>${escapeHtml(detail)}</p>` : ""}<p><a href="${input.statusUrl}">View status</a></p>`;
  return { subject, text, html };
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
