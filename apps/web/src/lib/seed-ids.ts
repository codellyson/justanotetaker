// Persisted so the "clear starter notes" helper survives reloads.
const KEY = "justnotetaking:seed-ids";

export const seedIdStore = {
  list(): string[] {
    try {
      const raw = localStorage.getItem(KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? (arr as string[]) : [];
    } catch {
      return [];
    }
  },
  write(ids: string[]): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(ids));
    } catch (err) {
      console.error("[seed-ids] write failed", err);
    }
  },
  clear(): void {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  },
};
