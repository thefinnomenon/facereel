import { prisma } from "@facereel/db";
export const runtime = "nodejs";
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ ok: true, database: "postgresql" });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
