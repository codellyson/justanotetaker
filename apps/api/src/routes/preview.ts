import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Env } from "../env";

const querySchema = z.object({
  url: z.string().url().max(2048),
});

type CacheEntry = { title: string | null; expires: number };
const cache = new Map<string, CacheEntry>();
const TTL_MS = 5 * 60 * 1000;
const MAX_BYTES = 1_000_000;
const TIMEOUT_MS = 5000;
const UA =
  "Mozilla/5.0 (compatible; justnotetakingbot/0.2; +https://justnotetaking.kreativekorna.com)";

function isBlockedHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) return true;
  if (/^127\./.test(lower)) return true;
  if (/^10\./.test(lower)) return true;
  if (/^192\.168\./.test(lower)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(lower)) return true;
  if (/^169\.254\./.test(lower)) return true;
  if (lower === "::1" || lower.startsWith("[::1]")) return true;
  if (lower.startsWith("[fc") || lower.startsWith("[fd")) return true;
  return false;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function extractTitle(html: string): string | null {
  const og = html.match(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
  ) || html.match(
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
  );
  if (og?.[1]) return decodeEntities(og[1].trim()).slice(0, 300);

  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t?.[1]) {
    const cleaned = decodeEntities(t[1].replace(/\s+/g, " ").trim());
    return cleaned ? cleaned.slice(0, 300) : null;
  }
  return null;
}

export const previewRoutes = new Hono<Env>().get(
  "/",
  zValidator("query", querySchema),
  async (c) => {
    const { url } = c.req.valid("query");
    const cached = cache.get(url);
    if (cached && cached.expires > Date.now()) {
      return c.json({ url, title: cached.title, cached: true });
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return c.json({ error: "invalid url" }, 400);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return c.json({ error: "unsupported protocol" }, 400);
    }
    if (isBlockedHost(parsed.hostname)) {
      return c.json({ error: "blocked host" }, 400);
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    let title: string | null = null;
    try {
      const res = await fetch(parsed.toString(), {
        signal: ac.signal,
        redirect: "follow",
        headers: { "User-Agent": UA, Accept: "text/html,*/*;q=0.5" },
      });
      if (!res.ok || !res.body) {
        return c.json({ url, title: null, error: `upstream ${res.status}` });
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      let received = 0;
      while (received < MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        acc += decoder.decode(value, { stream: true });
        if (/<\/head>/i.test(acc) || acc.length > 65536) {
          try { reader.cancel(); } catch { /* */ }
          break;
        }
      }
      acc += decoder.decode();
      title = extractTitle(acc);
    } catch {
      /* network error / timeout / abort — fall through with null title */
    } finally {
      clearTimeout(timer);
    }

    cache.set(url, { title, expires: Date.now() + TTL_MS });
    return c.json({ url, title });
  },
);
