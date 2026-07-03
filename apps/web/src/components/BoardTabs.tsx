import { useState } from "react";
import type { Board } from "./JustNotes/lib";

const XIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);
const PlusIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

// Horizontal top tab bar for switching between boards (canvases). Click to
// switch, double-click to rename inline, × to arm an inline delete confirm
// ("delete?"), + to add. No native dialogs — everything is in-canvas.
export function BoardTabs({ boards, activeBoardId, onSwitch, onNew, onRename, onClose }: {
  boards: Board[];
  activeBoardId: string | null;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, name: string) => void;
  onClose: (id: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const commit = (id: string, value: string) => {
    const name = value.trim();
    if (name) onRename(id, name);
    setEditingId(null);
  };

  return (
    <div className="chrome board-tabs" role="tablist" aria-label="boards">
      {boards.map((b) => {
        const active = b.id === activeBoardId;
        const editing = editingId === b.id;
        return (
          <div
            key={b.id}
            className={"board-tab" + (active ? " active" : "")}
            onMouseLeave={() => setConfirmId((c) => (c === b.id ? null : c))}
          >
            {editing ? (
              <input
                className="board-tab-input"
                autoFocus
                defaultValue={b.name}
                onFocus={(e) => e.currentTarget.select()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commit(b.id, e.currentTarget.value);
                  else if (e.key === "Escape") setEditingId(null);
                }}
                onBlur={(e) => commit(b.id, e.currentTarget.value)}
              />
            ) : (
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className="board-tab-name"
                title={`${b.name} — double-click to rename`}
                onClick={() => onSwitch(b.id)}
                onDoubleClick={() => { setConfirmId(null); setEditingId(b.id); }}
              >
                {b.name}
              </button>
            )}

            {!editing && boards.length > 1 && (
              confirmId === b.id ? (
                <button
                  type="button"
                  className="board-tab-del"
                  title="Delete this board and its notes"
                  onClick={() => { onClose(b.id); setConfirmId(null); }}
                >
                  delete?
                </button>
              ) : (
                <button
                  type="button"
                  className="board-tab-x"
                  aria-label={`close ${b.name}`}
                  onClick={() => setConfirmId(b.id)}
                >
                  {XIcon}
                </button>
              )
            )}
          </div>
        );
      })}
      <button
        type="button"
        className="board-tab-new"
        aria-label="new board"
        title="New board"
        onClick={onNew}
      >
        {PlusIcon}
      </button>
    </div>
  );
}
