import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

export type StoredObject = { bucket: string; key: string; sizeBytes: number; etag?: string; contentType?: string };
export interface ObjectStorage {
  put(key: string, body: Buffer | NodeJS.ReadableStream, contentType: string): Promise<StoredObject>;
  uploadFile(key: string, filePath: string, contentType: string): Promise<StoredObject>;
  downloadToFile(key: string, filePath: string): Promise<void>;
  head(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  copy(sourceKey: string, destinationKey: string): Promise<void>;
  signedUploadUrl(key: string, contentType: string, expiresSeconds?: number): Promise<string>;
  signedDownloadUrl(key: string, expiresSeconds?: number): Promise<string>;
}

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }

export function createR2Storage(): ObjectStorage {
  const bucket = required("R2_BUCKET");
  const client = new S3Client({ region: "auto", endpoint: process.env.R2_ENDPOINT || `https://${required("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: required("R2_ACCESS_KEY_ID"), secretAccessKey: required("R2_SECRET_ACCESS_KEY") } });
  return {
    async put(key, body, contentType) { const output = await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body as any, ContentType: contentType })); return { bucket, key, sizeBytes: Buffer.isBuffer(body) ? body.length : 0, ...(output.ETag ? { etag: output.ETag } : {}), contentType }; },
    async uploadFile(key, filePath, contentType) { const upload = new Upload({ client, params: { Bucket: bucket, Key: key, Body: createReadStream(filePath), ContentType: contentType } }); const output = await upload.done(); const head = await this.head(key); return head ?? { bucket, key, sizeBytes: 0, ...(output.ETag ? { etag: output.ETag } : {}), contentType }; },
    async downloadToFile(key, filePath) { const output = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key })); if (!output.Body) throw new Error("R2 object had no body"); await pipeline(output.Body as NodeJS.ReadableStream, createWriteStream(filePath)); },
    async head(key) { try { const value = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); return { bucket, key, sizeBytes: value.ContentLength ?? 0, ...(value.ETag ? { etag: value.ETag } : {}), ...(value.ContentType ? { contentType: value.ContentType } : {}) }; } catch (error: any) { if (error?.$metadata?.httpStatusCode === 404) return null; throw error; } },
    async delete(key) { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); },
    async copy(sourceKey, destinationKey) { await client.send(new CopyObjectCommand({ Bucket: bucket, Key: destinationKey, CopySource: `${bucket}/${encodeURIComponent(sourceKey).replaceAll("%2F", "/")}` })); },
    signedUploadUrl(key, contentType, expiresSeconds = 900) { return getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }), { expiresIn: Math.min(expiresSeconds, 3600) }); },
    signedDownloadUrl(key, expiresSeconds = 900) { return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: Math.min(expiresSeconds, 3600) }); }
  };
}

let singleton: ObjectStorage | undefined;
export function storage(): ObjectStorage { return singleton ??= createR2Storage(); }
