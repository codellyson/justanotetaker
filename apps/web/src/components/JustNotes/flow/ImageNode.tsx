import { memo, type CSSProperties } from "react";
import { Handle, NodeResizer, Position, useConnection, type NodeProps } from "@xyflow/react";
import { API_BASE_URL } from "../../../lib/runtime";
import type { ImageMeta } from "../lib";
import type { NoteFlowNode } from "./useNoteGraph";

// An uploaded picture on the canvas. `meta` carries the R2 key + natural
// dimensions; while it's absent the card is an in-flight upload placeholder.
// `text` is an optional caption (searchable). Resize keeps aspect.
function ImageNodeInner({ id, data, selected }: NodeProps<NoteFlowNode>) {
  const { note, dragging, dimmed, highlit, scrubFade, handlers } = data;
  const meta = note.meta as ImageMeta | null;
  const isConnectTarget = useConnection((c) => c.inProgress && c.fromNode?.id !== id);

  const style: CSSProperties = {
    width: note.w ?? 360,
    opacity: scrubFade ?? 1,
  };

  const cls = [
    "image-card",
    selected ? "selected" : "",
    dragging ? "dragging" : "",
    dimmed ? "dim" : "",
    highlit ? "hit" : "",
  ].filter(Boolean).join(" ");

  return (
    <>
      <NodeResizer
        isVisible
        keepAspectRatio
        minWidth={80}
        minHeight={60}
        onResize={(_, p) => handlers.onResize(note.id, p)}
        onResizeEnd={(_, p) => handlers.onResizeEnd(note.id, p)}
      />
      <Handle
        type="target"
        position={Position.Left}
        className={"note-link-target" + (isConnectTarget ? " active" : "")}
      />
      <div className={cls} data-note-id={note.id} style={style}>
        {meta?.key ? (
          <img
            className="image-card-img"
            src={`${API_BASE_URL}/api/media/${meta.key}`}
            alt={meta.alt ?? ""}
            width={meta.w}
            height={meta.h}
            draggable={false}
            loading="lazy"
          />
        ) : (
          <div
            className="image-card-shimmer"
            style={{ aspectRatio: `${note.w ?? 4} / ${note.h ?? 3}` }}
            aria-label="uploading"
          />
        )}
        {note.text && <div className="image-card-caption">{note.text}</div>}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="note-link-source nodrag"
        isConnectable
      />
    </>
  );
}

export default memo(ImageNodeInner);
