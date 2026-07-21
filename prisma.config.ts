import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "packages/db/prisma/schema.prisma",
  migrations: { path: "packages/db/prisma/migrations" },
  // Client generation does not connect. Migration commands must set one of these URLs.
  datasource: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://generate-only:generate-only@127.0.0.1:5432/generate-only" }
});
