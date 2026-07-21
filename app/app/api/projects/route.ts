import {
  createProjectAndJob,
  hashOwnerToken,
  newOwnerToken,
} from "@facereel/db";
import { dispatchPending } from "@facereel/dispatch";
import { storage } from "@facereel/storage";
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
export const runtime = "nodejs";
const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX = 15 * 1024 * 1024;
export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const username = sanitizeInstagramUsername(form.get("username"));
    const email = normalizeEmail(form.get("email"));
    const file = form.get("targetFace");
    if (
      !(file instanceof File) ||
      !allowed.has(file.type) ||
      file.size <= 0 ||
      file.size > MAX
    )
      return NextResponse.json(
        { error: "Upload a JPG, PNG, or WEBP target face up to 15MB." },
        { status: 400 },
      );
    const bytes = Buffer.from(await file.arrayBuffer());
    const meta = await sharp(bytes, { limitInputPixels: 40_000_000 })
      .rotate()
      .metadata();
    if (!meta.width || !meta.height)
      throw new Error("The target image could not be decoded.");
    const projectId = randomUUID();
    const sourceId = randomUUID();
    const ext =
      file.type === "image/png"
        ? "png"
        : file.type === "image/webp"
          ? "webp"
          : "jpg";
    const key = `projects/${projectId}/source/${sourceId}/target.${ext}`;
    const object = await storage().put(key, bytes, file.type);
    const token = newOwnerToken();
    let created;
    try {
      created = await createProjectAndJob({
        projectId,
        email,
        username,
        ownerTokenHash: hashOwnerToken(token),
        ownerAccessToken: token,
        source: {
          id: sourceId,
          objectKey: key,
          bucket: object.bucket,
          filename: file.name.slice(0, 255),
          contentType: file.type,
          sizeBytes: file.size,
          width: meta.width,
          height: meta.height,
        },
      });
    } catch (error) {
      await storage()
        .delete(key)
        .catch(() => {});
      throw error;
    }
    void dispatchPending(1);
    const response = NextResponse.json(
      { projectId: created.project.id, jobId: created.job.id },
      { status: 201 },
    );
    response.cookies.set("facereel_access", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return response;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "project_creation_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return NextResponse.json(
      { error: "Unable to create FaceReel project." },
      { status: 400 },
    );
  }
}

function sanitizeInstagramUsername(value: unknown): string {
  const username = String(value ?? "").trim().replace(/^@+/, "");
  if (!/^[A-Za-z0-9._]{1,30}$/.test(username) || username.includes("..")) throw new Error("Invalid Instagram username");
  return username;
}

function normalizeEmail(value: unknown): string {
  const email = String(value ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error("Invalid email");
  return email;
}
