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
  const { note, editing, dragging, handlers } = data;
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const col = resolveNoteColor(note.color);
  const style: CSSProperties = {
    width: note.w ?? FRAME_DEFAULT_W,
    height: note.h ?? FRAME_DEFAULT_H,
  };
  if (col) {
    (style as Record<string, string>)["--frame-tint"] = col.ink;
  }

  const cls = [
    "note-frame",
    selected ? "selected" : "",
    dragging ? "dragging" : "",
    col ? "tinted" : "",
  ].filter(Boolean).join(" ");

  return (
    <>
      <NodeResizer
        isVisible={!editing}
        minWidth={FRAME_MIN_W}
        minHeight={FRAME_MIN_H}
        onResize={(_, p) => handlers.onResize(note.id, p)}
        onResizeEnd={(_, p) => handlers.onResizeEnd(note.id, p)}
      />
      <div className={cls} data-note-id={note.id} style={style}>
        <div className="frame-label">
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
            firstNonEmpty(note.text) || "Frame"
          )}
        </div>
      </div>
    </>
  );
}

export default memo(FrameNodeInner);
