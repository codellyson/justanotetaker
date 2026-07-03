import { useCallback, useEffect, useState } from "react";
import type { Board, ViewMode } from "../components/JustNotes/lib";
import { remoteStorage } from "../lib/storage";

// Where the active board id lives on this device. It's a per-device
// preference (not synced) — which canvas you last looked at on this
// machine, not a property of the account.
const ACTIVE_BOARD_KEY = "justanotetaker:active-board";

function readActiveBoardId(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_BOARD_KEY);
  } catch {
    return null;
  }
}

function writeActiveBoardId(id: string | null): void {
  try {
    if (id === null) window.localStorage.removeItem(ACTIVE_BOARD_KEY);
    else window.localStorage.setItem(ACTIVE_BOARD_KEY, id);
  } catch {
    // ignore storage failures (private mode, quota, etc.)
  }
}

const bySort = (a: Board, b: Board) => a.sort - b.sort;

// useBoards owns the board list and which board is active. The active id is
// device-local (localStorage); the list itself is server-owned. Boards are
// kept sorted by `sort` so callers can render them in a stable order.
export function useBoards() {
  const [boards, setBoards] = useState<Board[]>([]);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let loaded = (await remoteStorage.listBoards()).slice().sort(bySort);
        // Every account has at least one canvas — bootstrap it on first run.
        if (loaded.length === 0) {
          const created = await remoteStorage.createBoard({ name: "Canvas" });
          loaded = [created];
        }
        if (cancelled) return;
        setBoards(loaded);
        // Prefer the device's last-active board if it still exists,
        // otherwise fall back to the first one.
        const stored = readActiveBoardId();
        const active =
          stored && loaded.some((b) => b.id === stored) ? stored : loaded[0].id;
        setActiveBoardId(active);
        writeActiveBoardId(active);
      } catch (err) {
        console.error("[useBoards] load failed", err);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setActiveBoard = useCallback((id: string) => {
    setActiveBoardId(id);
    writeActiveBoardId(id);
  }, []);

  const createBoard = useCallback(
    async (name?: string): Promise<Board | null> => {
      try {
        const board = await remoteStorage.createBoard({
          name: name ?? `Canvas ${boards.length + 1}`,
        });
        setBoards((prev) => [...prev, board].sort(bySort));
        setActiveBoard(board.id);
        return board;
      } catch (err) {
        console.error("[useBoards] create failed", err);
        return null;
      }
    },
    [boards.length, setActiveBoard],
  );

  const renameBoard = useCallback(async (id: string, name: string) => {
    setBoards((prev) => prev.map((b) => (b.id === id ? { ...b, name } : b)));
    try {
      await remoteStorage.updateBoard(id, { name });
    } catch (err) {
      console.error("[useBoards] rename failed", err);
    }
  }, []);

  const deleteBoard = useCallback(
    async (id: string) => {
      // Never let the user delete their last canvas — there'd be nothing to
      // show and no board to create notes against.
      if (boards.length <= 1) return;
      const remaining = boards.filter((b) => b.id !== id);
      setBoards(remaining);
      if (activeBoardId === id) {
        setActiveBoard(remaining[0].id);
      }
      try {
        await remoteStorage.deleteBoard(id);
      } catch (err) {
        console.error("[useBoards] delete failed", err);
      }
    },
    [boards, activeBoardId, setActiveBoard],
  );

  const setBoardViewMode = useCallback(async (id: string, viewMode: ViewMode) => {
    setBoards((prev) => prev.map((b) => (b.id === id ? { ...b, viewMode } : b)));
    try {
      await remoteStorage.updateBoard(id, { viewMode });
    } catch (err) {
      console.error("[useBoards] set view mode failed", err);
    }
  }, []);

  const activeBoard = boards.find((b) => b.id === activeBoardId) ?? null;

  return {
    boards,
    activeBoardId,
    activeBoard,
    ready,
    createBoard,
    renameBoard,
    deleteBoard,
    setActiveBoard,
    setBoardViewMode,
  };
}
