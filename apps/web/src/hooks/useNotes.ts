import { useCallback, useEffect, useRef, useState } from "react";
import type { Note } from "../components/JustNotes/lib";
import { remoteStorage } from "../lib/storage";
import { localNotes } from "../lib/local-notes";

// Server rows carry a few persistence-only fields; the canvas only wants the
// Note shape. Shared by the initial load and refresh so they never drift.
function strip(rows: Awaited<ReturnType<typeof remoteStorage.list>>): Note[] {
  return rows.map((s) => ({
    id: s.id,
    x: s.x,
    y: s.y,
    w: s.w,
    h: s.h,
    t: s.t,
    text: s.text,
    kind: s.kind,
    color: s.color,
    role: s.role,
    parentId: s.parentId,
    meta: s.meta,
  }));
}

// useNotes is the bridge between server state and the canvas. It owns:
//   - the one-time initial fetch (for JustNotes' initialNotes prop)
//   - the "synced ids" ref that tracks which notes the server knows about
//   - the "local ids" ref for device-only notes (clipboard captures the user
//     opted not to sync) — these persist to localStorage, never the API
//   - the persist callbacks JustNotes fires at the right edges
//
// It deliberately does NOT own the live notes array — JustNotes keeps
// useState<Note[]> internally for the existing optimistic edit/drag/undo
// loops to work unchanged. The hook is a side-channel for persistence.
export function useNotes(boardId: string | null) {
  // `loaded` carries the notes AND the board they belong to, so a switch can
  // tell whether the current notes match the requested board (ready) or are
  // still the previous board's while the new one loads.
  const [loaded, setLoaded] = useState<{ boardId: string; notes: Note[] } | null>(null);
  const syncedRef = useRef<Set<string>>(new Set());
  const localRef = useRef<Set<string>>(new Set());
  // onCreate is a stable callback but needs the current board id — keep it in
  // a ref updated each render so the callback identity never changes.
  const boardIdRef = useRef(boardId);
  boardIdRef.current = boardId;

  useEffect(() => {
    if (boardId === null) return;
    let cancelled = false;
    (async () => {
      // Device-local notes load synchronously and always show, even offline
      // or signed-out — they're never gated on the API.
      const local = localNotes.list();
      localRef.current = new Set(local.map((n) => n.id));
      try {
        const rows = await remoteStorage.list(boardId);
        if (cancelled) return;
        const stripped = strip(rows);
        syncedRef.current = new Set(stripped.map((n) => n.id));
        setLoaded({ boardId, notes: [...stripped, ...local] });
      } catch (err) {
        console.error("[useNotes] initial load failed", err);
        if (!cancelled) setLoaded({ boardId, notes: local });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [boardId]);

  // Notes are "ready" only when what we hold matches the requested board —
  // during a switch the previous board's notes are held but not surfaced.
  const initialNotes = loaded && loaded.boardId === boardId ? loaded.notes : null;

  // Persist a brand-new note. With { localOnly } the note is written to the
  // device-local store and never synced; otherwise it goes to the server and
  // is marked synced so subsequent onUpdate calls reach it.
  const onCreate = useCallback(async (note: Note, opts?: { localOnly?: boolean }) => {
    if (opts?.localOnly) {
      localNotes.create(note);
      localRef.current.add(note.id);
      return;
    }
    const boardId = boardIdRef.current;
    if (!boardId) return;
    try {
      await remoteStorage.create({
        id: note.id,
        boardId,
        x: note.x,
        y: note.y,
        w: note.w,
        h: note.h,
        t: note.t,
        text: note.text,
        kind: note.kind,
        color: note.color,
        parentId: note.parentId ?? null,
        meta: note.meta ?? null,
      });
      syncedRef.current.add(note.id);
    } catch (err) {
      console.error("[useNotes] create failed", err);
    }
  }, []);

  // Patch text/position/timestamp. Routes to the local store for device-only
  // ids; otherwise the server. No-op for ids that are neither yet synced nor
  // local — the next create call will pick up state from JustNotes' useState.
  const onUpdate = useCallback(
    (id: string, patch: Partial<Pick<Note, "x" | "y" | "w" | "h" | "t" | "text" | "kind" | "color" | "parentId" | "meta">>) => {
      if (localRef.current.has(id)) {
        localNotes.update(id, patch);
        return;
      }
      if (!syncedRef.current.has(id)) return;
      void remoteStorage.update(id, patch).catch((err) => console.error("[useNotes] update failed", err));
    },
    [],
  );

  // Re-fetch the server notes for the current board and return them. Used to
  // pull in notes created out-of-band (another device, or an agent via the
  // MCP server) without a full reload. Marks every returned note as synced so
  // subsequent edits reach the server; the caller decides how to merge.
  const refresh = useCallback(async (): Promise<Note[]> => {
    const boardId = boardIdRef.current;
    if (!boardId) return [];
    try {
      const stripped = strip(await remoteStorage.list(boardId));
      stripped.forEach((n) => syncedRef.current.add(n.id));
      return stripped;
    } catch (err) {
      console.error("[useNotes] refresh failed", err);
      return [];
    }
  }, []);

  // Delete. Local-only ids are removed from the device store; synced ids are
  // soft-deleted on the server. No-op if neither.
  const onDelete = useCallback((id: string) => {
    if (localRef.current.has(id)) {
      localNotes.remove(id);
      localRef.current.delete(id);
      return;
    }
    if (!syncedRef.current.has(id)) return;
    void remoteStorage.remove(id).catch((err) => console.error("[useNotes] delete failed", err));
    syncedRef.current.delete(id);
  }, []);

  return {
    initialNotes,
    ready: initialNotes !== null,
    onCreate,
    onUpdate,
    onDelete,
    refresh,
  };
}
