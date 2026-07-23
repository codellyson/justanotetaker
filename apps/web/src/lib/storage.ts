import type { Board, Note, NoteKind, NoteMeta, Tweaks } from "../components/JustNotes/lib";
import { api, readBearer } from "./api-client";
import { API_BASE_URL } from "./runtime";

export type StoredNote = Note & { updatedAt: number };

// A note tagged with the board it lives on — used to build the cross-board
// file tree, which needs every board's notes at once (not just the active one).
export type BoardNote = StoredNote & { boardId: string | null };

export type DeletedNote = StoredNote & { deletedAt: number };

export type SearchMatch = StoredNote & { snippet: string };

export type StoredSettings = {
  tweaks: Tweaks | null;
  seeded: boolean;
};

// A user-drawn relationship between two notes (undirected; pair normalized
// a < b server-side).
export type NoteLink = { id: string; a: string; b: string };

export interface Storage {
  list(boardId: string): Promise<StoredNote[]>;
  listAll(): Promise<BoardNote[]>;
  create(input: { id?: string; boardId: string; x: number; y: number; w?: number | null; h?: number | null; t: number; text?: string; kind?: NoteKind; color?: string | null; parentId?: string | null; meta?: NoteMeta | null }): Promise<StoredNote>;
  update(id: string, patch: Partial<Pick<Note, "x" | "y" | "w" | "h" | "t" | "text" | "kind" | "color" | "parentId" | "meta">>): Promise<StoredNote | null>;
  remove(id: string): Promise<void>;
  listBoards(): Promise<Board[]>;
  createBoard(input: { name: string; sort?: number }): Promise<Board>;
  updateBoard(id: string, patch: Partial<Pick<Board, "name" | "sort">>): Promise<Board | null>;
  deleteBoard(id: string): Promise<void>;
  listDeleted(): Promise<DeletedNote[]>;
  restore(id: string): Promise<StoredNote | null>;
  search(q: string, opts?: { limit?: number; signal?: AbortSignal }): Promise<SearchMatch[]>;
  previewUrl(url: string, opts?: { signal?: AbortSignal }): Promise<string | null>;
  getSettings(): Promise<StoredSettings>;
  putSettings(input: { tweaks?: Tweaks | null; seeded?: boolean }): Promise<StoredSettings>;
  listLinks(boardId: string): Promise<NoteLink[]>;
  createLink(input: { id?: string; boardId: string; aId: string; bId: string }): Promise<NoteLink>;
  removeLink(id: string): Promise<void>;
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
  kind?: string | null;
  color?: string | null;
  role?: string | null;
  parentId?: string | null;
  meta?: unknown;
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
    kind: (row.kind as NoteKind) ?? "card",
    color: row.color ?? null,
    role: row.role ?? null,
    parentId: row.parentId ?? null,
    meta: (row.meta as NoteMeta | null) ?? null,
  };
}

export const remoteStorage: Storage = {
  async list(boardId) {
    const res = await api.api.notes.$get({ query: { board: boardId } });
    if (!res.ok) throw new Error(`list notes: ${res.status}`);
    const { notes } = await res.json();
    return notes.map(toUiNote);
  },

  // Every board's notes in one call — the API returns all of the user's notes
  // when no board filter is given, each carrying its board_id.
  async listAll() {
    const res = await api.api.notes.$get({ query: {} });
    if (!res.ok) throw new Error(`list all notes: ${res.status}`);
    const { notes } = await res.json();
    return notes.map((n) => ({ ...toUiNote(n), boardId: n.boardId ?? null }));
  },

  async create(input) {
    const res = await api.api.notes.$post({
      json: {
        ...(input.id ? { id: input.id } : {}),
        boardId: input.boardId,
        x: input.x,
        y: input.y,
        ...(input.w !== undefined ? { w: input.w } : {}),
        ...(input.h !== undefined ? { h: input.h } : {}),
        t: input.t,
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
        ...(input.meta !== undefined ? { meta: input.meta } : {}),
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

  async listBoards() {
    const res = await api.api.boards.$get();
    if (!res.ok) throw new Error(`list boards: ${res.status}`);
    const { boards } = await res.json();
    return boards.map((b) => ({ id: b.id, name: b.name, sort: b.sort }));
  },

  async createBoard(input) {
    const res = await api.api.boards.$post({
      json: {
        name: input.name,
        ...(input.sort !== undefined ? { sort: input.sort } : {}),
      },
    });
    if (!res.ok) throw new Error(`create board: ${res.status}`);
    const { board } = await res.json();
    return { id: board.id, name: board.name, sort: board.sort };
  },

  async updateBoard(id, patch) {
    const res = await api.api.boards[":id"].$patch({ param: { id }, json: patch });
    if (!res.ok) {
      if (res.status === 404) return null;
      throw new Error(`update board: ${res.status}`);
    }
    const { board } = await res.json();
    return { id: board.id, name: board.name, sort: board.sort };
  },

  async deleteBoard(id) {
    const res = await api.api.boards[":id"].$delete({ param: { id } });
    if (!res.ok && res.status !== 404) throw new Error(`delete board: ${res.status}`);
  },

  async listDeleted() {
    const res = await api.api.notes.deleted.$get();
    if (!res.ok) throw new Error(`list deleted: ${res.status}`);
    const { notes } = await res.json();
    return notes.map((n) => ({
      ...toUiNote(n),
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
      kind: "card" as NoteKind,
      color: null,
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

  async listLinks(boardId) {
    const res = await api.api.links.$get({ query: { board: boardId } });
    if (!res.ok) throw new Error(`list links: ${res.status}`);
    const { links } = await res.json();
    return links.map((l) => ({ id: l.id, a: l.aId, b: l.bId }));
  },

  async createLink(input) {
    const res = await api.api.links.$post({
      json: {
        ...(input.id ? { id: input.id } : {}),
        boardId: input.boardId,
        aId: input.aId,
        bId: input.bId,
      },
    });
    if (!res.ok) throw new Error(`create link: ${res.status}`);
    const { link } = await res.json();
    return { id: link.id, a: link.aId, b: link.bId };
  },

  async removeLink(id) {
    const res = await api.api.links[":id"].$delete({ param: { id } });
    if (!res.ok && res.status !== 404) throw new Error(`delete link: ${res.status}`);
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

// Multipart upload for image cards. Raw fetch rather than the typed hono
// client (which doesn't do FormData cleanly); auth mirrors api-client — cookie
// session in the browser, keychain bearer in Tauri.
export async function uploadMedia(file: File): Promise<{ key: string; size: number }> {
  const form = new FormData();
  form.append("file", file);
  const headers: Record<string, string> = {};
  const bearer = await readBearer();
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${API_BASE_URL}/api/media`, {
    method: "POST",
    body: form,
    credentials: "include",
    headers,
  });
  if (!res.ok) throw new Error(`upload media: ${res.status}`);
  return (await res.json()) as { key: string; size: number };
}

function safeParseTweaks(raw: string): Tweaks | null {
  try {
    return JSON.parse(raw) as Tweaks;
  } catch (err) {
    console.error("[storage] malformed tweaks JSON, ignoring", err);
    return null;
  }
}
