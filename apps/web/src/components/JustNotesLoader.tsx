import { useEffect, useRef, useState } from "react";
import JustNotes from "./JustNotes/JustNotes";
import type { Note } from "./JustNotes/lib";
import { uid } from "./JustNotes/lib";
import { useNotes } from "../hooks/useNotes";
import { useBoards } from "../hooks/useBoards";
import { useAllNotes } from "../hooks/useAllNotes";
import { useSettings } from "../hooks/useSettings";
import { authClient } from "../lib/auth-client";
import { ONBOARDING_SEED } from "../lib/onboarding-seed";
import { seedIdStore } from "../lib/seed-ids";
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
  const [shown, setShown] = useState<{ id: string; notes: Note[]; seedIds: string[] } | null>(null);
  const seededRef = useRef<string | null>(null);
  // A cross-board file-tree click: switch to the target board, then focus the
  // note once that board's canvas has mounted (JustNotes remounts per board).
  const [focusReq, setFocusReq] = useState<{ boardId: string; noteId: string } | null>(null);

  // Keep the all-boards snapshot reasonably fresh: refetch when the active
  // board changes (the active board itself renders from live notes).
  useEffect(() => {
    void allNotes.refresh();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  useEffect(() => {
    // ready ⇒ notes belong to activeId (see useNotes). Until then, hold `shown`.
    if (!notes.ready || !notes.initialNotes) return;

    // Onboarding seeds go into a brand-new account's sole empty board only.
    const canSeed = boards.boards.length === 1;
    if (canSeed && notes.initialNotes.length === 0 && !settings.seeded && seededRef.current !== activeId) {
      seededRef.current = activeId;
      const now = Date.now();
      const seeds: Note[] = ONBOARDING_SEED.map((s, i) => ({
        id: uid(),
        x: s.x,
        y: s.y,
        w: null,
        h: null,
        t: now - i * 1000,
        text: s.text,
        modePos: null,
      }));
      seeds.forEach((n) => void notes.onCreate(n));
      settings.markSeeded();
      const ids = seeds.map((n) => n.id);
      seedIdStore.write(ids);
      setShown({ id: activeId, notes: seeds, seedIds: ids });
    } else {
      // Mark seeded once the first board resolves, so onboarding never fires
      // for a board the user creates with +.
      if (!settings.seeded) settings.markSeeded();
      setShown({ id: activeId, notes: notes.initialNotes, seedIds: seedIdStore.list() });
    }
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

  return (
    <JustNotes
      key={shown.id}
      initialNotes={shown.notes}
      seedIds={shown.seedIds}
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
    />
  );
}
