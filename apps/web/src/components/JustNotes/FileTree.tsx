import { useMemo, useState } from "react";
import type { Board, Note } from "./lib";
import { firstNonEmpty } from "./lib";
import type { NotesByBoard } from "../../hooks/useAllNotes";

type Entry = { id: string; title: string; t: number };

function toEntries(notes: { id: string; text: string; t: number }[]): Entry[] {
  return notes
    .map((n) => ({ id: n.id, title: firstNonEmpty(n.text).trim() || "Untitled", t: n.t }))
    // Stable order by id — never reshuffles when a note is edited/selected, and
    // is identical whether the board is active (live) or not (snapshot).
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function FileTree({
  boards,
  activeBoardId,
  liveNotes,
  notesByBoard,
  selectedIds,
  onSelectNote,
}: {
  boards: Board[];
  activeBoardId: string;
  liveNotes: Note[];
  notesByBoard: NotesByBoard;
  selectedIds: Set<string>;
  onSelectNote: (boardId: string, noteId: string) => void;
}) {
  // The active board starts open; others collapsed. Toggling is per-session.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([activeBoardId]));

  // Active board's entries come from the live canvas notes (so edits/creates
  // show immediately); other boards from the all-boards snapshot.
  const entriesByBoard = useMemo(() => {
    const map = new Map<string, Entry[]>();
    for (const b of boards) {
      const source =
        b.id === activeBoardId
          ? liveNotes
          : (notesByBoard.get(b.id) ?? []);
      map.set(b.id, toEntries(source));
    }
    return map;
  }, [boards, activeBoardId, liveNotes, notesByBoard]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <nav className="chrome file-tree" aria-label="Notes">
      <div className="ft-head">Notes</div>
      <div className="ft-scroll">
        {boards.map((b) => {
          const entries = entriesByBoard.get(b.id) ?? [];
          const open = expanded.has(b.id);
          return (
            <div className="ft-board" key={b.id}>
              <button
                type="button"
                className={"ft-board-row" + (b.id === activeBoardId ? " active" : "")}
                onClick={() => toggle(b.id)}
                aria-expanded={open}
              >
                <span className={"ft-caret" + (open ? " open" : "")} aria-hidden="true">›</span>
                <span className="ft-board-name">{b.name}</span>
                <span className="ft-count">{entries.length}</span>
              </button>
              {open && (
                <ul className="ft-notes">
                  {entries.length === 0 ? (
                    <li className="ft-empty">no notes</li>
                  ) : (
                    entries.map((e) => (
                      <li key={e.id}>
                        <button
                          type="button"
                          className={"ft-note" + (selectedIds.has(e.id) ? " selected" : "")}
                          onClick={() => onSelectNote(b.id, e.id)}
                          title={e.title}
                        >
                          {e.title}
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
