import "dotenv/config";
import { disconnectPrisma, prisma } from "@facereel/db";

const staleBefore = new Date(Date.now() - Number(process.env.RENDER_STALE_MINUTES || 30) * 60_000);
const stale = await prisma.renderJob.findMany({ where: { status: "PROCESSING", heartbeatAt: { lt: staleBefore } }, select: { id: true, attemptCount: true, maxAttempts: true } });
let recovered = 0;
for (const job of stale) {
  if (job.attemptCount >= job.maxAttempts) continue;
  await prisma.$transaction([
    prisma.renderJob.update({ where: { id: job.id }, data: { status: "QUEUED", stage: "QUEUED", errorCode: "WORKER_INTERRUPTED", errorMessage: "Rendering was interrupted and will be retried." } }),
    prisma.renderDispatch.update({ where: { renderJobId: job.id }, data: { status: "PENDING", nextAttemptAt: new Date() } }),
  ]);
  recovered += 1;
}
console.log(JSON.stringify({ recovered, staleBefore }));
await disconnectPrisma();
