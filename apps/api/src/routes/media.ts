import { Hono } from "hono";
import type { Env } from "./../env";

// Media storage (image cards + file cards). POST requires a signed-in user
// (session or jnt_ token — checked inline because GET must stay public); GET
// serves by unguessable key with no auth: the Tauri webview authenticates with
// a keychain bearer token, and an <img> tag can't send Authorization headers,
// so a public GET behind a 122-bit-random UUID key is the only scheme that
// works on every surface.

const MAX_BYTES = 8 * 1024 * 1024;
const QUOTA_BYTES = 200 * 1024 * 1024;
// No svg — inline-served SVG is an XSS vector. Types outside this map get an
// attachment disposition so HTML/SVG/etc can never render in-origin.
const IMAGE_EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

function contentDispositionFor(mime: string, rawName: string): string {
  const clean = rawName
    .replace(/[\r\n"\\\/\x00-\x1f\x7f]/g, "")
    .trim()
    .slice(0, 150) || "download";
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_");
  const disp = mime === "application/pdf" ? "inline" : "attachment";
  return `${disp}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

export const mediaRoutes = new Hono<Env>()
  .post("/", async (c) => {
    const user = c.get("user") as { id?: string } | null;
    if (!user?.id) return c.json({ error: "unauthorized" }, 401);
    const userId = user.id;

    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    // Duck-type rather than `instanceof File` — the Workers type lib doesn't
    // expose File as a value, only a blob-with-name at runtime.
    if (!file || typeof file === "string" || typeof (file as Blob).stream !== "function") {
      return c.json({ error: "file field required" }, 400);
    }
    const blob = file as Blob & { type: string; size: number; name?: string };
    if (blob.size > MAX_BYTES) return c.json({ error: "too large (8 MB max)" }, 413);

    const imageExt = IMAGE_EXT_BY_TYPE[blob.type];
    const rawName = typeof blob.name === "string" ? blob.name : "";
    const ext = imageExt ?? (rawName.match(/[.]([A-Za-z0-9]{1,8})$/)?.[1]?.toLowerCase() || "bin");
    const contentType = blob.type || "application/octet-stream";
    const contentDisposition = imageExt ? undefined : contentDispositionFor(contentType, rawName);

    const row = await c.env.DB.prepare(`SELECT media_bytes FROM settings WHERE user_id = ?`)
      .bind(userId)
      .first<{ media_bytes: number }>();
    if ((row?.media_bytes ?? 0) + blob.size > QUOTA_BYTES) {
      return c.json({ error: "storage quota exceeded (200 MB)" }, 413);
    }

    // No userId prefix — media URLs surface on public boards. Old
    // `${userId}/uuid` keys keep serving.
    const key = `m/${crypto.randomUUID()}.${ext}`;
    // ArrayBuffer (not the stream) so the type checks cleanly under both the
    // Worker and DOM lib contexts the monorepo compiles this file in; uploads
    // are capped at 8 MB, so buffering is fine.
    await c.env.MEDIA.put(key, await blob.arrayBuffer(), {
      httpMetadata: { contentType, contentDisposition },
    });
    await c.env.DB.prepare(
      `INSERT INTO settings (user_id, tweaks, seeded, updated_at, media_bytes)
       VALUES (?, NULL, 0, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET
         media_bytes = media_bytes + excluded.media_bytes,
         updated_at = excluded.updated_at`,
    )
      .bind(userId, Date.now(), blob.size)
      .run();

    return c.json({ key, size: blob.size });
  })
  // Key contains a slash (m/uuid.ext; legacy userId/uuid.ext) — take the
  // whole tail of the path.
  .get("/*", async (c) => {
    const key = decodeURIComponent(c.req.path.replace(/^\/api\/media\//, ""));
    if (!key || key.includes("..")) return c.json({ error: "not found" }, 404);
    const obj = await c.env.MEDIA.get(key);
    if (!obj) return c.json({ error: "not found" }, 404);
    // Buffer to an ArrayBuffer so the body type is unambiguous across the
    // Worker/DOM lib split (see the put note above).
    const headers: Record<string, string> = {
      "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      etag: obj.httpEtag,
    };
    // Must be forwarded by hand — dropping it would let non-image types
    // render in-origin.
    if (obj.httpMetadata?.contentDisposition) {
      headers["content-disposition"] = obj.httpMetadata.contentDisposition;
    }
    return new Response(await obj.arrayBuffer(), { headers });
  });
