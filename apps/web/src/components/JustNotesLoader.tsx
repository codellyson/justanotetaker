import { useEffect, useState } from "react";
import JustNotes from "./JustNotes/JustNotes";
import type { Note } from "./JustNotes/lib";
import { useNotes } from "../hooks/useNotes";
import { useBoards } from "../hooks/useBoards";
import { useAllNotes } from "../hooks/useAllNotes";
import { useSettings } from "../hooks/useSettings";
import { authClient } from "../lib/auth-client";
import { BoardTabs } from "./BoardTabs";

export function JustNotesLoader() {
  const { data: session, isPending } = authClient.useSession();
  const userId = session?.user?.id;
  if (isPending || !userId) return null;
  return <Session key={userId} />;
}

function Session() {
  const boards = useBoards();
  const settings = useSettings();
  const allNotes = useAllNotes();
  if (!boards.ready || !settings.ready || !boards.activeBoard) return null;

  return (
    <>
      <BoardTabs
        boards={boards.boards}
        activeBoardId={boards.activeBoardId}
        onSwitch={boards.setActiveBoard}
        onNew={() => void boards.createBoard()}
        onRename={boards.renameBoard}
        onClose={boards.deleteBoard}
      />
      <Canvas boards={boards} settings={settings} allNotes={allNotes} />
    </>
  );
}

// Owns the notes for the active board and swaps the rendered canvas only once
// the new board's notes have loaded — so switching keeps the current canvas up
// (no blank flash) and JustNotes remounts cleanly in a single frame.
function Canvas({ boards, settings, allNotes }: {
  boards: ReturnType<typeof useBoards>;
  settings: ReturnType<typeof useSettings>;
  allNotes: ReturnType<typeof useAllNotes>;
}) {
  const activeId = boards.activeBoardId as string;
  const notes = useNotes(activeId);
  const [shown, setShown] = useState<{ id: string; notes: Note[] } | null>(null);
  // A cross-board file-tree click: switch to the target board, then focus the
  // note once that board's canvas has mounted (JustNotes remounts per board).
  const [focusReq, setFocusReq] = useState<{ boardId: string; noteId: string } | null>(null);
  // A file-tree "+" on another board: switch there, then spawn a note once that
  // board's canvas has mounted.
  const [spawnReq, setSpawnReq] = useState<string | null>(null);

  // Keep the all-boards snapshot reasonably fresh: refetch when the active
  // board changes (the active board itself renders from live notes).
  useEffect(() => {
    void allNotes.refresh();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  useEffect(() => {
    // ready ⇒ notes belong to activeId (see useNotes). Until then, hold `shown`.
    if (!notes.ready || !notes.initialNotes) return;
    setShown({ id: activeId, notes: notes.initialNotes });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes.ready, activeId]);

  if (!shown) return null;

  const board = boards.boards.find((b) => b.id === shown.id) ?? boards.activeBoard!;

  // Clicking a note in another board's tree section. Same-board clicks are
  // handled inside JustNotes (no remount needed).
  const requestBoardJump = (boardId: string, noteId: string) => {
    if (boardId === boards.activeBoardId) return;
    setFocusReq({ boardId, noteId });
    boards.setActiveBoard(boardId);
  };

  const focusNoteId =
    focusReq && shown.id === focusReq.boardId ? focusReq.noteId : undefined;

  // "+" on another board's tree row: switch to it, then spawn on mount.
  const requestBoardCreate = (boardId: string) => {
    setSpawnReq(boardId);
    boards.setActiveBoard(boardId);
  };

  const spawnRequested = spawnReq != null && shown.id === spawnReq;

  return (
    <JustNotes
      key={shown.id}
      initialNotes={shown.notes}
      tweaks={settings.tweaks}
      setTweak={settings.setTweak}
      viewMode={board.viewMode}
      onSetViewMode={(m) => boards.setBoardViewMode(shown.id, m)}
      onCreate={notes.onCreate}
      onUpdate={notes.onUpdate}
      onDelete={notes.onDelete}
      refresh={notes.refresh}
      boards={boards.boards}
      activeBoardId={shown.id}
      notesByBoard={allNotes.byBoard}
      onBoardJump={requestBoardJump}
      focusNoteId={focusNoteId}
      onFocusConsumed={() => setFocusReq(null)}
      onBoardCreate={requestBoardCreate}
      spawnRequested={spawnRequested}
      onSpawnConsumed={() => setSpawnReq(null)}
    />
  );
}
