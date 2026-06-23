// Tracks which note ids originated from a clipboard auto-capture, so the
// canvas can badge them. Device-local (localStorage) and orthogonal to sync:
// it covers both synced and local-only captures, but only on the device where
// the capture happened — a clipboard-origin marker is inherently device-side.
const KEY = "justnotetaking:clipboard-ids";

function read(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function write(ids: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...ids]));
  } catch (err) {
    console.error("[clipboard-origin] write failed", err);
  }
}

export const clipboardOrigin = {
  list(): Set<string> {
    return read();
  },
  add(id: string): void {
    const ids = read();
    ids.add(id);
    write(ids);
  },
  remove(id: string): void {
    const ids = read();
    if (ids.delete(id)) write(ids);
  },
};
