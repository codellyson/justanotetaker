import { useCallback, useEffect, useRef, useState } from "react";
import type { Note } from "../components/JustNotes/lib";
import { remoteStorage } from "../lib/storage";
import { localNotes } from "../lib/local-notes";

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
export function useNotes() {
  const [initialNotes, setInitialNotes] = useState<Note[] | null>(null);
  const syncedRef = useRef<Set<string>>(new Set());
  const localRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Device-local notes load synchronously and always show, even offline
      // or signed-out — they're never gated on the API.
      const local = localNotes.list();
      localRef.current = new Set(local.map((n) => n.id));
      try {
        const loaded = await remoteStorage.list();
        if (cancelled) return;
        const stripped: Note[] = loaded.map((s) => ({
          id: s.id,
          x: s.x,
          y: s.y,
          w: s.w,
          h: s.h,
          t: s.t,
          text: s.text,
        }));
        syncedRef.current = new Set(stripped.map((n) => n.id));
        setInitialNotes([...stripped, ...local]);
      } catch (err) {
        console.error("[useNotes] initial load failed", err);
        if (!cancelled) setInitialNotes(local);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist a brand-new note. With { localOnly } the note is written to the
  // device-local store and never synced; otherwise it goes to the server and
  // is marked synced so subsequent onUpdate calls reach it.
  const onCreate = useCallback(async (note: Note, opts?: { localOnly?: boolean }) => {
    if (opts?.localOnly) {
      localNotes.create(note);
      localRef.current.add(note.id);
      return;
    }
    try {
      await remoteStorage.create({
        id: note.id,
        x: note.x,
        y: note.y,
        w: note.w,
        h: note.h,
        t: note.t,
        text: note.text,
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
    (id: string, patch: Partial<Pick<Note, "x" | "y" | "w" | "h" | "t" | "text">>) => {
      if (localRef.current.has(id)) {
        localNotes.update(id, patch);
        return;
      }
      if (!syncedRef.current.has(id)) return;
      void remoteStorage.update(id, patch).catch((err) => console.error("[useNotes] update failed", err));
    },
    [],
  );

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
  };
}
