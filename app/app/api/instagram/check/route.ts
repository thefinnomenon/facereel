import { checkInstagramProfile } from "../../../../../packages/worker/src/instagram";
import { sanitizeInstagramUsername } from "../../../../../packages/worker/src/validation";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  let username: string;
  try {
    username = sanitizeInstagramUsername(url.searchParams.get("username"));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid Instagram username." },
      { status: 400 },
    );
  }

  try {
    const result = await checkInstagramProfile(username);
    const status = result.exists ? (result.is_public ? "public" : "private") : "not_found";
    return NextResponse.json({
      status,
      username: result.username || username,
      exists: result.exists,
      public: result.is_public,
      estimatedPhotoCount: result.estimated_photo_count,
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: "instagram_check_failed",
      username,
      message: error instanceof Error ? error.message : String(error),
    }));
    return NextResponse.json(
      { error: "Unable to verify Instagram right now." },
      { status: 502 },
    );
  }
}
