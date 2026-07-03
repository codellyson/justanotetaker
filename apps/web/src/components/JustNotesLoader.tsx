import { useEffect, useRef, useState } from "react";
import JustNotes from "./JustNotes/JustNotes";
import type { Board, Note, ViewMode } from "./JustNotes/lib";
import { uid } from "./JustNotes/lib";
import { useNotes } from "../hooks/useNotes";
import { useBoards } from "../hooks/useBoards";
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
  if (!boards.ready || !settings.ready || !boards.activeBoard) return null;

  const active = boards.activeBoard;
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
      <BoardCanvas
        key={active.id}
        board={active}
        settings={settings}
        onSetViewMode={(m) => boards.setBoardViewMode(active.id, m)}
      />
    </>
  );
}

// One board's canvas. Keyed by board id in Session, so switching boards
// remounts this with a fresh notes load for that board.
function BoardCanvas({ board, settings, onSetViewMode }: {
  board: Board;
  settings: ReturnType<typeof useSettings>;
  onSetViewMode: (m: ViewMode) => void;
}) {
  const notes = useNotes(board.id);
  const [resolved, setResolved] = useState<Note[] | null>(null);
  const [seedIds, setSeedIds] = useState<string[]>([]);
  const doneRef = useRef(false);

  useEffect(() => {
    if (!notes.ready || !notes.initialNotes) return;
    if (doneRef.current) return;
    doneRef.current = true;

    // Onboarding seeds go into the first board a brand-new user lands on.
    if (notes.initialNotes.length === 0 && !settings.seeded) {
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
      setSeedIds(ids);
      setResolved(seeds);
    } else {
      setSeedIds(seedIdStore.list());
      setResolved(notes.initialNotes);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes.ready]);

  if (!resolved) return null;

  return (
    <JustNotes
      initialNotes={resolved}
      seedIds={seedIds}
      tweaks={settings.tweaks}
      setTweak={settings.setTweak}
      viewMode={board.viewMode}
      onSetViewMode={onSetViewMode}
      onCreate={notes.onCreate}
      onUpdate={notes.onUpdate}
      onDelete={notes.onDelete}
    />
  );
}
