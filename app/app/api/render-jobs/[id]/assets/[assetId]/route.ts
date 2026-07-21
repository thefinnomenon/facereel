import { hashOwnerToken, prisma } from "@facereel/db";
import { storage } from "@facereel/storage";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; assetId: string }> },
) {
  const token = new URL(request.url).searchParams.get("access") || (await cookies()).get("facereel_access")?.value;
  if (!token) return new Response("Not authorized", { status: 401 });
  const { id, assetId } = await params;
  const asset = await prisma.renderedAsset.findFirst({
    where: {
      id: assetId,
      renderJobId: id,
      renderJob: { project: { ownerTokenHash: hashOwnerToken(token) } },
    },
  });
  if (!asset) return new Response("Not found", { status: 404 });
  return NextResponse.redirect(
    await storage().signedDownloadUrl(asset.r2ObjectKey, 300),
  );
}
