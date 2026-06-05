import { useCallback, useEffect, useRef, useState } from "react";
import type { Note } from "../components/JustNotes/lib";
import { remoteStorage } from "../lib/storage";

// useNotes is the bridge between server state and the canvas. It owns:
//   - the one-time initial fetch (for JustNotes' initialNotes prop)
//   - the "synced ids" ref that tracks which notes the server knows about
//   - the persist callbacks JustNotes fires at the right edges
//
// It deliberately does NOT own the live notes array — JustNotes keeps
// useState<Note[]> internally for the existing optimistic edit/drag/undo
// loops to work unchanged. The hook is a side-channel for persistence.
export function useNotes() {
  const [initialNotes, setInitialNotes] = useState<Note[] | null>(null);
  const syncedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = await remoteStorage.list();
        if (cancelled) return;
        const stripped: Note[] = loaded.map((s) => ({
          id: s.id,
          x: s.x,
          y: s.y,
          t: s.t,
          text: s.text,
        }));
        syncedRef.current = new Set(stripped.map((n) => n.id));
        setInitialNotes(stripped);
      } catch (err) {
        console.error("[useNotes] initial load failed", err);
        if (!cancelled) setInitialNotes([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist a brand-new note. Marks the id as synced on success so
  // subsequent onUpdate calls actually reach the server.
  const onCreate = useCallback(async (note: Note) => {
    try {
      await remoteStorage.create({
        id: note.id,
        x: note.x,
        y: note.y,
        t: note.t,
        text: note.text,
      });
      syncedRef.current.add(note.id);
    } catch (err) {
      console.error("[useNotes] create failed", err);
    }
  }, []);

  // Patch text/position/timestamp on a note that's already been persisted.
  // No-op for never-synced ids — the next create call will pick up the
  // current state from JustNotes' useState.
  const onUpdate = useCallback(
    (id: string, patch: Partial<Pick<Note, "x" | "y" | "t" | "text">>) => {
      if (!syncedRef.current.has(id)) return;
      void remoteStorage.update(id, patch).catch((err) => console.error("[useNotes] update failed", err));
    },
    [],
  );

  // Soft-delete on the server. No-op if never synced.
  const onDelete = useCallback((id: string) => {
    if (!syncedRef.current.has(id)) return;
    void remoteStorage.remove(id).catch((err) => console.error("[useNotes] delete failed", err));
    syncedRef.current.delete(id);
  }, []);

  // First-visit SEED dump. Persists each note in parallel and marks the
  // ids as synced. Caller is responsible for also setting settings.seeded
  // (so a partial failure here doesn't perma-block re-seeding).
  const seedAndMarkSynced = useCallback(async (seed: Note[]) => {
    await Promise.all(
      seed.map((n) =>
        remoteStorage
          .create({ id: n.id, x: n.x, y: n.y, t: n.t, text: n.text })
          .then(() => syncedRef.current.add(n.id))
          .catch((err) => console.error("[useNotes] seed create failed", err)),
      ),
    );
  }, []);

  return {
    initialNotes,
    ready: initialNotes !== null,
    onCreate,
    onUpdate,
    onDelete,
    seedAndMarkSynced,
  };
}
