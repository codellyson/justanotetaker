import { useCallback, useEffect, useRef, useState } from "react";
import { remoteStorage, type BoardNote } from "../lib/storage";

export type NotesByBoard = Map<string, BoardNote[]>;

function group(notes: BoardNote[]): NotesByBoard {
  const map: NotesByBoard = new Map();
  for (const n of notes) {
    if (!n.boardId) continue;
    const arr = map.get(n.boardId);
    if (arr) arr.push(n);
    else map.set(n.boardId, [n]);
  }
  return map;
}

// Loads every board's notes so the file tree can list them all at once. This is
// a read-only side-channel for the tree — the canvas keeps owning the live notes
// for the active board (useNotes). Refetched on demand (e.g. after a board
// switch) so other boards' entries stay reasonably fresh.
export function useAllNotes() {
  const [byBoard, setByBoard] = useState<NotesByBoard>(() => new Map());
  const [ready, setReady] = useState(false);
  const cancelledRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const all = await remoteStorage.listAll();
      if (cancelledRef.current) return;
      setByBoard(group(all));
    } catch (err) {
      console.error("[useAllNotes] load failed", err);
    } finally {
      if (!cancelledRef.current) setReady(true);
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    void refresh();
    return () => {
      cancelledRef.current = true;
    };
  }, [refresh]);

  return { byBoard, ready, refresh };
}
