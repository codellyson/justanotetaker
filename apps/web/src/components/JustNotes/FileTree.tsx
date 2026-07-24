import { useMemo, useState } from "react";
import type { Board, Note } from "./lib";
import { firstNonEmpty } from "./lib";
import type { NotesByBoard } from "../../hooks/useAllNotes";

const PIN_KEY = "justanotetaker.sidebar.pinned";

type Entry = { id: string; title: string; t: number };

// The tree shows plain-text titles, so strip the markdown the note stores:
// leading block markers (heading/quote/list/task) then inline emphasis, code,
// highlight, and link syntax. A bare `#tag` (no space) is left intact.
function plainTitle(text: string): string {
  let s = firstNonEmpty(text).trim();
  if (!s) return "Untitled";
  s = s
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s+/, "")
    .replace(/^(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?/, "");
  s = s
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/==([^=]+)==/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  return s.trim() || "Untitled";
}

function toEntries(notes: { id: string; text: string; t: number }[]): Entry[] {
  return notes
    .map((n) => ({ id: n.id, title: plainTitle(n.text), t: n.t }))
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
  onNoteContextMenu,
  onCreateNote,
  onSwitchBoard,
  onCreateBoard,
  onRenameBoard,
  onDeleteBoard,
}: {
  boards: Board[];
  activeBoardId: string;
  liveNotes: Note[];
  notesByBoard: NotesByBoard;
  selectedIds: Set<string>;
  onSelectNote: (boardId: string, noteId: string) => void;
  onNoteContextMenu?: (boardId: string, noteId: string, x: number, y: number) => void;
  onCreateNote: (boardId: string) => void;
  onSwitchBoard: (id: string) => void;
  onCreateBoard: () => void;
  onRenameBoard: (id: string, name: string) => void;
  onDeleteBoard: (id: string) => void;
}) {
  // The active board starts open; others collapsed. Toggling is per-session.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([activeBoardId]));
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Collapsed to a slim rail by default; peeks open on hover, and the toggle
  // pins it open. Pin state persists so a board switch (which remounts this
  // component) keeps it.
  const [pinned, setPinned] = useState<boolean>(() => {
    try { return localStorage.getItem(PIN_KEY) === "1"; } catch { return false; }
  });
  const [hovered, setHovered] = useState(false);
  const open = pinned || hovered;
  const togglePin = () =>
    setPinned((p) => {
      const next = !p;
      try { localStorage.setItem(PIN_KEY, next ? "1" : "0"); } catch { /* blocked */ }
      return next;
    });

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

  const startRename = (b: Board) => {
    setConfirmDeleteId(null);
    setRenameDraft(b.name);
    setRenameId(b.id);
  };
  const commitRename = () => {
    if (renameId) {
      const name = renameDraft.trim();
      if (name) onRenameBoard(renameId, name);
    }
    setRenameId(null);
  };

  return (
    <nav
      className={"file-tree" + (open ? " ft-open" : " ft-collapsed") + (pinned ? " ft-pinned" : "")}
      aria-label="Notes"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="ft-surface">
      <div className="ft-head">
        <button
          type="button"
          className="ft-toggle"
          title={pinned ? "Unpin sidebar" : "Keep sidebar open"}
          aria-label={pinned ? "Unpin sidebar" : "Keep sidebar open"}
          aria-pressed={pinned}
          onClick={togglePin}
        >
          {ICON.panel}
        </button>
        <span className="ft-head-title">Notes</span>
        <button
          type="button"
          className="ft-head-add"
          title="New board"
          aria-label="New board"
          onClick={onCreateBoard}
        >
          {ICON.plus}
        </button>
      </div>
      <div className="ft-scroll">
        {boards.map((b) => {
          const entries = entriesByBoard.get(b.id) ?? [];
          const open = expanded.has(b.id);
          const active = b.id === activeBoardId;
          const renaming = renameId === b.id;
          const confirming = confirmDeleteId === b.id;
          const canDelete = boards.length > 1;
          return (
            <div className="ft-board" key={b.id}>
              <div className={"ft-board-row" + (active ? " active" : "")}>
                <button
                  type="button"
                  className="ft-caret-btn"
                  onClick={() => toggle(b.id)}
                  aria-expanded={open}
                  aria-label={(open ? "Collapse " : "Expand ") + b.name}
                >
                  <span className={"ft-caret" + (open ? " open" : "")} aria-hidden="true">
                    {ICON.caret}
                  </span>
                </button>
                {renaming ? (
                  <input
                    className="ft-rename-input"
                    value={renameDraft}
                    autoFocus
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") commitRename();
                      else if (e.key === "Escape") setRenameId(null);
                    }}
                    onBlur={commitRename}
                  />
                ) : confirming ? null : (
                  <button
                    type="button"
                    className="ft-board-name"
                    title={b.name}
                    onClick={() => {
                      setExpanded((prev) => new Set(prev).add(b.id));
                      onSwitchBoard(b.id);
                    }}
                  >
                    {b.name}
                  </button>
                )}

                {!renaming && !confirming && (
                  <div className="ft-row-tail">
                    <div className="ft-board-actions">
                      <button
                        type="button"
                        className="ft-icon-btn"
                        title={"New note in " + b.name}
                        aria-label={"New note in " + b.name}
                        onClick={() => {
                          setExpanded((prev) => new Set(prev).add(b.id));
                          onCreateNote(b.id);
                        }}
                      >
                        {ICON.plus}
                      </button>
                      <button
                        type="button"
                        className="ft-icon-btn"
                        title={"Rename " + b.name}
                        aria-label={"Rename " + b.name}
                        onClick={() => startRename(b)}
                      >
                        {ICON.pencil}
                      </button>
                      {canDelete && (
                        <button
                          type="button"
                          className="ft-icon-btn ft-del"
                          title={"Delete " + b.name}
                          aria-label={"Delete " + b.name}
                          onClick={() => { setRenameId(null); setConfirmDeleteId(b.id); }}
                        >
                          {ICON.trash}
                        </button>
                      )}
                    </div>
                    <span className="ft-count">{entries.length}</span>
                  </div>
                )}

                {confirming && (
                  <div className="ft-confirm">
                    <span className="ft-confirm-label">delete?</span>
                    <button
                      type="button"
                      className="ft-confirm-btn danger"
                      onClick={() => { setConfirmDeleteId(null); onDeleteBoard(b.id); }}
                    >
                      yes
                    </button>
                    <button
                      type="button"
                      className="ft-confirm-btn"
                      onClick={() => setConfirmDeleteId(null)}
                    >
                      no
                    </button>
                  </div>
                )}
              </div>

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
                          onContextMenu={(ev) => {
                            ev.preventDefault();
                            ev.stopPropagation();
                            onNoteContextMenu?.(b.id, e.id, ev.clientX, ev.clientY);
                          }}
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
      </div>
    </nav>
  );
}

const ICON = {
  panel: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M9 4v16" />
    </svg>
  ),
  plus: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  caret: (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  ),
  pencil: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  ),
  trash: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    </svg>
  ),
};
