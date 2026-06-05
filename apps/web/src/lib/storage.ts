import type { Note, Tweaks } from "../components/JustNotes/lib";
import { api } from "./api-client";

// Storage owns the API round-trips for notes + settings. The UI never
// talks to the api-client directly. Phase 1 semantics: optimistic at the
// hook layer, fire-and-forget writes here, errors logged but not retried.
// Phase 2/3 will add a pending-write queue + reconnect drain.

export type StoredNote = Note & { updatedAt: number };

export type SearchMatch = StoredNote & { snippet: string };

export type StoredSettings = {
  tweaks: Tweaks | null;
  seeded: boolean;
};

export interface Storage {
  list(): Promise<StoredNote[]>;
  create(input: { id?: string; x: number; y: number; t: number; text?: string }): Promise<StoredNote>;
  update(id: string, patch: Partial<Pick<Note, "x" | "y" | "t" | "text">>): Promise<StoredNote | null>;
  remove(id: string): Promise<void>;
  search(q: string, opts?: { limit?: number; signal?: AbortSignal }): Promise<SearchMatch[]>;
  getSettings(): Promise<StoredSettings>;
  putSettings(input: { tweaks?: Tweaks | null; seeded?: boolean }): Promise<StoredSettings>;
}

function toUiNote(row: {
  id: string;
  x: number;
  y: number;
  t: number;
  text: string;
  updatedAt: number;
}): StoredNote {
  return { id: row.id, x: row.x, y: row.y, t: row.t, text: row.text, updatedAt: row.updatedAt };
}

export const remoteStorage: Storage = {
  async list() {
    const res = await api.api.notes.$get({ query: {} });
    if (!res.ok) throw new Error(`list notes: ${res.status}`);
    const { notes } = await res.json();
    return notes.map(toUiNote);
  },

  async create(input) {
    const res = await api.api.notes.$post({
      json: {
        ...(input.id ? { id: input.id } : {}),
        x: input.x,
        y: input.y,
        t: input.t,
        ...(input.text !== undefined ? { text: input.text } : {}),
      },
    });
    if (!res.ok) throw new Error(`create note: ${res.status}`);
    const { note } = await res.json();
    return toUiNote(note);
  },

  async update(id, patch) {
    const res = await api.api.notes[":id"].$patch({ param: { id }, json: patch });
    if (!res.ok) {
      if (res.status === 404) return null;
      throw new Error(`update note: ${res.status}`);
    }
    const { note } = await res.json();
    return toUiNote(note);
  },

  async remove(id) {
    const res = await api.api.notes[":id"].$delete({ param: { id } });
    if (!res.ok && res.status !== 404) throw new Error(`delete note: ${res.status}`);
  },

  async search(q, opts) {
    const res = await api.api.notes.search.$get(
      {
        query: { q, ...(opts?.limit !== undefined ? { limit: opts.limit } : {}) },
      },
      { init: { signal: opts?.signal } },
    );
    if (!res.ok) throw new Error(`search: ${res.status}`);
    const { matches } = await res.json();
    return matches.map((m) => ({
      id: m.id,
      x: m.x,
      y: m.y,
      t: m.t,
      text: m.text,
      updatedAt: m.updatedAt,
      snippet: m.snippet,
    }));
  },

  async getSettings() {
    const res = await api.api.settings.$get();
    if (!res.ok) throw new Error(`get settings: ${res.status}`);
    const { tweaks, seeded } = await res.json();
    return {
      tweaks: tweaks ? safeParseTweaks(tweaks) : null,
      seeded: Boolean(seeded),
    };
  },

  async putSettings(input) {
    const body: { tweaks?: string | null; seeded?: boolean } = {};
    if (input.tweaks !== undefined) body.tweaks = input.tweaks === null ? null : JSON.stringify(input.tweaks);
    if (input.seeded !== undefined) body.seeded = input.seeded;
    const res = await api.api.settings.$put({ json: body });
    if (!res.ok) throw new Error(`put settings: ${res.status}`);
    const { tweaks, seeded } = await res.json();
    return {
      tweaks: tweaks ? safeParseTweaks(tweaks) : null,
      seeded: Boolean(seeded),
    };
  },
};

function safeParseTweaks(raw: string): Tweaks | null {
  try {
    return JSON.parse(raw) as Tweaks;
  } catch (err) {
    console.error("[storage] malformed tweaks JSON, ignoring", err);
    return null;
  }
}
