import type { Board } from "./JustNotes/lib";

// Horizontal top tab bar for switching between boards (canvases). Each tab
// switches on click, renames on double-click, and closes with the ×; the +
// creates a new board. Hidden close button when only one board remains.
export function BoardTabs({ boards, activeBoardId, onSwitch, onNew, onRename, onClose }: {
  boards: Board[];
  activeBoardId: string | null;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, name: string) => void;
  onClose: (id: string) => void;
}) {
  return (
    <div className="chrome board-tabs" role="tablist" aria-label="boards">
      {boards.map((b) => {
        const active = b.id === activeBoardId;
        return (
          <div key={b.id} className={"board-tab" + (active ? " active" : "")}>
            <button
              type="button"
              role="tab"
              aria-selected={active}
              className="board-tab-name"
              title={`${b.name} — double-click to rename`}
              onClick={() => onSwitch(b.id)}
              onDoubleClick={() => {
                const name = window.prompt("Rename board", b.name)?.trim();
                if (name) onRename(b.id, name);
              }}
            >
              {b.name}
            </button>
            {boards.length > 1 && (
              <button
                type="button"
                className="board-tab-x"
                aria-label={`close ${b.name}`}
                onClick={() => {
                  if (window.confirm(`Delete "${b.name}" and its notes?`)) onClose(b.id);
                }}
              >
                ×
              </button>
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
        +
      </button>
    </div>
  );
}
