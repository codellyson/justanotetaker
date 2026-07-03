import type { ModePos, Note, Tweaks } from "../components/JustNotes/lib";
import { api } from "./api-client";

export type StoredNote = Note & { updatedAt: number };

export type DeletedNote = StoredNote & { deletedAt: number };

export type SearchMatch = StoredNote & { snippet: string };

export type StoredSettings = {
  tweaks: Tweaks | null;
  seeded: boolean;
};

export interface Storage {
  list(): Promise<StoredNote[]>;
  create(input: { id?: string; x: number; y: number; w?: number | null; h?: number | null; t: number; text?: string; modePos?: ModePos | null }): Promise<StoredNote>;
  update(id: string, patch: Partial<Pick<Note, "x" | "y" | "w" | "h" | "t" | "text" | "modePos">>): Promise<StoredNote | null>;
  remove(id: string): Promise<void>;
  listDeleted(): Promise<DeletedNote[]>;
  restore(id: string): Promise<StoredNote | null>;
  search(q: string, opts?: { limit?: number; signal?: AbortSignal }): Promise<SearchMatch[]>;
  previewUrl(url: string, opts?: { signal?: AbortSignal }): Promise<string | null>;
  getSettings(): Promise<StoredSettings>;
  putSettings(input: { tweaks?: Tweaks | null; seeded?: boolean }): Promise<StoredSettings>;
}

function toUiNote(row: {
  id: string;
  x: number;
  y: number;
  w?: number | null;
  h?: number | null;
  t: number;
  text: string;
  updatedAt: number;
  modePos?: ModePos | null;
}): StoredNote {
  return {
    id: row.id,
    x: row.x,
    y: row.y,
    w: row.w ?? null,
    h: row.h ?? null,
    t: row.t,
    text: row.text,
    updatedAt: row.updatedAt,
    modePos: row.modePos ?? null,
  };
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
        ...(input.w !== undefined ? { w: input.w } : {}),
        ...(input.h !== undefined ? { h: input.h } : {}),
        t: input.t,
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.modePos !== undefined ? { modePos: input.modePos } : {}),
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

  async listDeleted() {
    const res = await api.api.notes.deleted.$get();
    if (!res.ok) throw new Error(`list deleted: ${res.status}`);
    const { notes } = await res.json();
    return notes.map((n) => ({
      id: n.id,
      x: n.x,
      y: n.y,
      w: n.w ?? null,
      h: n.h ?? null,
      t: n.t,
      text: n.text,
      updatedAt: n.updatedAt,
      modePos: n.modePos ?? null,
      deletedAt: n.deletedAt ?? 0,
    }));
  },

  async restore(id) {
    const res = await api.api.notes[":id"].restore.$post({ param: { id } });
    if (!res.ok) {
      if (res.status === 404) return null;
      throw new Error(`restore: ${res.status}`);
    }
    const { note } = await res.json();
    return toUiNote(note);
  },

  async previewUrl(url, opts) {
    try {
      const res = await api.api.preview.$get(
        { query: { url } },
        { init: { signal: opts?.signal } },
      );
      if (!res.ok) return null;
      const data = (await res.json()) as { title?: string | null };
      return data.title ?? null;
    } catch {
      return null;
    }
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
      w: null,
      h: null,
      t: m.t,
      text: m.text,
      updatedAt: m.updatedAt,
      modePos: null,
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
