import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(fileURLToPath(import.meta.url));

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(appDir, ".."),
  outputFileTracingIncludes: {
    "/api/*": ["../node_modules/@google-cloud/tasks/build/protos/**/*"],
  },
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg", "sharp", "@google-cloud/tasks", "google-gax", "@aws-sdk/client-s3", "@aws-sdk/lib-storage", "@aws-sdk/s3-request-presigner"]
};
export default config;
