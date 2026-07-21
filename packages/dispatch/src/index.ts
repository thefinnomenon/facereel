import { CloudTasksClient, protos } from "@google-cloud/tasks";
import { prisma } from "@facereel/db";

export interface RenderDispatcher {
  dispatch(jobId: string): Promise<string>;
}

export function createDispatcher(): RenderDispatcher {
  if (process.env.CLOUD_TASKS_MODE === "local")
    return {
      async dispatch(jobId) {
        const url = `${process.env.LOCAL_WORKER_URL || "http://127.0.0.1:8080"}/internal/render-jobs/process`;
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-facereel-local-secret":
              process.env.LOCAL_WORKER_SECRET || "local-development-only",
          },
          body: JSON.stringify({ jobId }),
        });
        if (!response.ok)
          throw new Error(`Local worker returned ${response.status}`);
        return `local/${jobId}`;
      },
    };
  const project = required("GOOGLE_CLOUD_PROJECT");
  const credentials = parseGoogleCredentials();
  const client = new CloudTasksClient({
    projectId: project,
    ...(credentials ? { credentials } : {}),
  });
  const location = required("CLOUD_TASKS_LOCATION");
  const queue = required("CLOUD_TASKS_QUEUE");
  const parent = client.queuePath(project, location, queue);
  return {
    async dispatch(jobId) {
      const taskName = client.taskPath(
        project,
        location,
        queue,
        `render-${jobId}`,
      );
      const task: protos.google.cloud.tasks.v2.ITask = {
        name: taskName,
        dispatchDeadline: { seconds: 1800 },
        httpRequest: {
          httpMethod: "POST",
          url: `${required("CLOUD_RUN_WORKER_URL")}/internal/render-jobs/process`,
          headers: { "Content-Type": "application/json" },
          body: Buffer.from(JSON.stringify({ jobId })).toString("base64"),
          oidcToken: {
            serviceAccountEmail: required(
              "CLOUD_TASKS_INVOKER_SERVICE_ACCOUNT",
            ),
            audience: required("CLOUD_RUN_WORKER_URL"),
          },
        },
      };
      try {
        const [created] = await client.createTask({ parent, task });
        return created.name || taskName;
      } catch (error: any) {
        if (error?.code === 6) return taskName;
        throw error;
      }
    },
  };
}

function parseGoogleCredentials():
  | { client_email: string; private_key: string }
  | undefined {
  const encoded = process.env.GOOGLE_CREDENTIALS;
  if (!encoded) return undefined;
  const value = JSON.parse(encoded) as {
    client_email?: unknown;
    private_key?: unknown;
  };
  if (
    typeof value.client_email !== "string" ||
    typeof value.private_key !== "string"
  )
    throw new Error("GOOGLE_CREDENTIALS is not a service-account credential");
  return { client_email: value.client_email, private_key: value.private_key };
}

export async function dispatchPending(
  limit = 20,
): Promise<{ sent: number; failed: number }> {
  const rows = await prisma.renderDispatch.findMany({
    where: { status: "PENDING", nextAttemptAt: { lte: new Date() } },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  const dispatcher = createDispatcher();
  let sent = 0;
  let failed = 0;
  for (const row of rows)
    try {
      const taskName = await dispatcher.dispatch(row.renderJobId);
      await prisma.renderDispatch.update({
        where: { id: row.id },
        data: {
          status: "SENT",
          taskName,
          sentAt: new Date(),
          attemptCount: { increment: 1 },
          lastError: null,
        },
      });
      sent++;
    } catch (error) {
      failed++;
      const attempts = row.attemptCount + 1;
      await prisma.renderDispatch.update({
        where: { id: row.id },
        data: {
          attemptCount: attempts,
          lastError: safeError(error),
          nextAttemptAt: new Date(
            Date.now() + Math.min(300_000, 5_000 * 2 ** Math.min(attempts, 6)),
          ),
        },
      });
    }
  return { sent, failed };
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
