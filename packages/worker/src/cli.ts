import "dotenv/config"; import { disconnectPrisma } from "@facereel/db"; import { processRenderJob } from "./index.ts";
const jobId=process.argv[2];if(!jobId)throw new Error("Usage: npm run worker:once -- <job-id>");processRenderJob(jobId).then(console.log).finally(disconnectPrisma);
