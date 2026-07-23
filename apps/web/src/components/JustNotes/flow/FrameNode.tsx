import { memo, useEffect, useRef, type CSSProperties } from "react";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import { firstNonEmpty, resolveNoteColor } from "../lib";
import type { NoteFlowNode } from "./useNoteGraph";

// A containment region: a labeled, tinted rectangle other notes live inside
// (note.parentId points here). Always rendered below every other node (the
// zIndex contract in buildNoteNodes); the orchestrator owns membership and
// group-drag. The label is note.text — a one-liner, edited with a plain
// input rather than CodeMirror.
export const FRAME_DEFAULT_W = 560;
export const FRAME_DEFAULT_H = 400;
export const FRAME_MIN_W = 240;
export const FRAME_MIN_H = 160;

function FrameNodeInner({ data, selected }: NodeProps<NoteFlowNode>) {
  const { note, editing, dragging, collapsed, frameStats, handlers } = data;
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const col = resolveNoteColor(note.color);
  const style: CSSProperties = collapsed
    ? { width: note.w ?? FRAME_DEFAULT_W }
    : { width: note.w ?? FRAME_DEFAULT_W, height: note.h ?? FRAME_DEFAULT_H };
  if (col) {
    (style as Record<string, string>)["--frame-tint"] = col.ink;
  }

  const cls = [
    "note-frame",
    selected ? "selected" : "",
    dragging ? "dragging" : "",
    collapsed ? "collapsed" : "",
    col ? "tinted" : "",
  ].filter(Boolean).join(" ");

  const stats = frameStats ?? { count: 0, done: 0, total: 0 };

  return (
    <>
      <NodeResizer
        isVisible={!editing && !collapsed}
        minWidth={FRAME_MIN_W}
        minHeight={FRAME_MIN_H}
        onResize={(_, p) => handlers.onResize(note.id, p)}
        onResizeEnd={(_, p) => handlers.onResizeEnd(note.id, p)}
      />
      <div className={cls} data-note-id={note.id} style={style}>
        <div className="frame-bar">
          <button
            type="button"
            className="frame-chevron nodrag"
            title={collapsed ? "Expand" : "Collapse"}
            aria-label={collapsed ? "Expand frame" : "Collapse frame"}
            aria-expanded={!collapsed}
            onClick={(e) => {
              e.stopPropagation();
              handlers.onToggleCollapse(note.id);
            }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: collapsed ? "rotate(-90deg)" : "none" }}>
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          {editing ? (
            <input
              ref={inputRef}
              className="frame-label-input nodrag"
              defaultValue={firstNonEmpty(note.text)}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => handlers.onTextChange(note.id, e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" || e.key === "Escape") handlers.onCommitEdit();
              }}
              onBlur={() => handlers.onCommitEdit()}
            />
          ) : (
            <button
              type="button"
              className="frame-title nodrag"
              title="Fly to frame"
              onClick={(e) => {
                e.stopPropagation();
                handlers.onFrameLabelClick(note.id);
              }}
            >
              {firstNonEmpty(note.text) || "Frame"}
            </button>
          )}
          <span className="frame-stats">
            {stats.count > 0 && `${stats.count} note${stats.count === 1 ? "" : "s"}`}
            {stats.total > 0 && ` · ${stats.done}/${stats.total} ✓`}
          </span>
        </div>
      </div>
    </>
  );
}

export default memo(FrameNodeInner);
