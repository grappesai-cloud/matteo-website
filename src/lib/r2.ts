// === R2 STORAGE (S3-compatible) ===
// All persistent data (catalog, landing, orders, pickup state) and uploaded
// product images live in Cloudflare R2 — self-hosted-friendly, no Vercel.
// Everything is namespaced under the `mattman/` key prefix so the bucket can be
// shared with other projects without collisions.
//
// Fallback: when R2 env vars are absent (local dev), callers use a gitignored
// .data/*.json file instead, so the admin still works offline.

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

const PREFIX = 'mattman';

function env(name: string): string | undefined {
  return process.env[name] || (import.meta.env as any)[name] || undefined;
}

export function r2Configured(): boolean {
  return Boolean(
    env('R2_ACCOUNT_ID') &&
      env('R2_ACCESS_KEY_ID') &&
      env('R2_SECRET_ACCESS_KEY') &&
      env('R2_BUCKET') &&
      env('R2_PUBLIC_BASE_URL'),
  );
}

let cached: S3Client | null = null;
function client(): S3Client {
  if (cached) return cached;
  if (!r2Configured()) throw new Error('R2 nu e configurat (R2_* lipsesc).');
  cached = new S3Client({
    region: 'auto',
    endpoint: `https://${env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env('R2_ACCESS_KEY_ID')!,
      secretAccessKey: env('R2_SECRET_ACCESS_KEY')!,
    },
    // R2 rejects the default streaming checksum middleware on PUT.
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
  return cached;
}

function bucket(): string {
  return env('R2_BUCKET')!;
}

/** Full object key under the project prefix (collapses accidental slashes). */
function fullKey(key: string): string {
  return `${PREFIX}/${key.replace(/^\/+/, '')}`;
}

/** Public URL for a stored object key (the part after the project prefix). */
export function r2PublicUrl(key: string): string {
  const base = env('R2_PUBLIC_BASE_URL')!.replace(/\/+$/, '');
  return `${base}/${encodeURI(fullKey(key))}`;
}

async function streamToBuffer(body: any): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (typeof body.transformToByteArray === 'function') {
    return Buffer.from(await body.transformToByteArray());
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Read + JSON-parse an object. Returns null when the key doesn't exist. */
export async function r2GetJson<T>(key: string): Promise<T | null> {
  return (await r2GetJsonMeta<T>(key)).value;
}

/**
 * Read + JSON-parse an object together with its ETag (for optimistic concurrency).
 * `value` is null when the key doesn't exist; `etag` is null when there's nothing
 * to match against (missing object) — callers pass it back to r2PutJsonConditional.
 */
export async function r2GetJsonMeta<T>(key: string): Promise<{ value: T | null; etag: string | null }> {
  try {
    const out = await client().send(
      new GetObjectCommand({ Bucket: bucket(), Key: fullKey(key) }),
    );
    const buf = await streamToBuffer(out.Body);
    const etag = out.ETag || null;
    if (!buf.length) return { value: null, etag };
    return { value: JSON.parse(buf.toString('utf-8')) as T, etag };
  } catch (err: any) {
    const code = err?.name || err?.Code || err?.$metadata?.httpStatusCode;
    if (code === 'NoSuchKey' || code === 'NotFound' || code === 404) return { value: null, etag: null };
    throw err;
  }
}

/** Thrown when a conditional write loses the race (another writer got there first). */
export class R2PreconditionFailed extends Error {
  constructor() { super('R2 conditional write precondition failed'); this.name = 'R2PreconditionFailed'; }
}

function isPreconditionError(err: any): boolean {
  const name = err?.name || err?.Code;
  const status = err?.$metadata?.httpStatusCode;
  return name === 'PreconditionFailed' || status === 412;
}

/** Write a value as pretty JSON. */
export async function r2PutJson(key: string, value: unknown): Promise<void> {
  await client().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: fullKey(key),
      Body: JSON.stringify(value, null, 2),
      ContentType: 'application/json',
      CacheControl: 'no-store',
    }),
  );
}

/**
 * Conditional write for optimistic concurrency. Pass the `etag` from r2GetJsonMeta:
 *   • etag string → writes only if the object is UNCHANGED (If-Match).
 *   • etag null   → writes only if the object still DOESN'T exist (If-None-Match: *).
 * Throws R2PreconditionFailed when the object changed under us, so the caller can
 * re-read and retry the whole read-modify-write. Returns the new ETag.
 */
export async function r2PutJsonConditional(
  key: string,
  value: unknown,
  etag: string | null,
): Promise<string | null> {
  try {
    const out = await client().send(
      new PutObjectCommand({
        Bucket: bucket(),
        Key: fullKey(key),
        Body: JSON.stringify(value, null, 2),
        ContentType: 'application/json',
        CacheControl: 'no-store',
        ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' }),
      }),
    );
    return out.ETag || null;
  } catch (err: any) {
    if (isPreconditionError(err)) throw new R2PreconditionFailed();
    throw err;
  }
}

/** Upload a binary object (e.g. an image) and return its public URL. */
export async function r2PutObject(
  key: string,
  body: Buffer | Uint8Array,
  contentType?: string,
): Promise<string> {
  await client().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: fullKey(key),
      Body: body,
      ContentType: contentType || 'application/octet-stream',
    }),
  );
  return r2PublicUrl(key);
}

/** Delete an object by its key (the part after the project prefix). */
export async function r2Delete(key: string): Promise<void> {
  await client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: fullKey(key) }));
}
