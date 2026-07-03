import type { Note } from "../components/JustNotes/lib";

// Device-local note store for captures the user chose NOT to sync to cloud.
// These never touch the API — they live in localStorage on this device only,
// which is the whole point of the "don't sync clipboard to cloud" setting.
// useNotes merges these with remote notes on load and routes persistence here
// for any id it knows is local.
const KEY = "justanotetaker:local-notes";

function readAll(): Note[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Note[]) : [];
  } catch (err) {
    console.error("[local-notes] read failed", err);
    return [];
  }
}

function writeAll(notes: Note[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(notes));
  } catch (err) {
    console.error("[local-notes] write failed", err);
  }
}

export const localNotes = {
  list(): Note[] {
    return readAll();
  },

  create(note: Note): void {
    const all = readAll();
    all.push(note);
    writeAll(all);
  },

  update(id: string, patch: Partial<Pick<Note, "x" | "y" | "w" | "h" | "t" | "text" | "modePos">>): void {
    const all = readAll();
    const i = all.findIndex((n) => n.id === id);
    if (i === -1) return;
    all[i] = { ...all[i], ...patch };
    writeAll(all);
  },

  remove(id: string): void {
    writeAll(readAll().filter((n) => n.id !== id));
  },
};
