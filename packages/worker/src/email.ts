import { prisma } from "@facereel/db";
import { appUrl } from "./validation.ts";
type Kind = "COMPLETION" | "FAILURE" | "PROCESSING";
export async function sendPendingEmail(
  jobId: string,
  kind: Kind,
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
    const ready = kind === "COMPLETION";
    const failed = kind === "FAILURE";
    const subject = ready
      ? "Your FaceReel is ready"
      : failed
        ? "We could not create your FaceReel"
        : "We're creating your FaceReel";
    const statusUrl = `${appUrl()}/status/${jobId}?access=${encodeURIComponent(job.project.ownerAccessToken)}`;
    const failureReason = job.errorMessage || "We could not create a FaceReel from the submitted photos.";
    const text = failed
      ? `${subject} for @${job.project.instagramUsername}.\n\n${failureReason}\n\nView status: ${statusUrl}`
      : `${subject} for @${job.project.instagramUsername}.\n\nView status: ${statusUrl}`;
    const html = failed
      ? `<h1>${escapeHtml(subject)}</h1><p>FaceReel for <strong>@${escapeHtml(job.project.instagramUsername)}</strong>.</p><p>${escapeHtml(failureReason)}</p><p><a href="${statusUrl}">View status</a></p>`
      : `<h1>${escapeHtml(subject)}</h1><p>FaceReel for <strong>@${escapeHtml(job.project.instagramUsername)}</strong>.</p><p><a href="${statusUrl}">View status</a></p>`;
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
function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
