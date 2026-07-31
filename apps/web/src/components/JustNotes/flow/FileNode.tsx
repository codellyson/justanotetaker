import { memo, useEffect, useState, type CSSProperties } from "react";
import { Handle, NodeResizer, Position, useConnection, type NodeProps } from "@xyflow/react";
import { API_BASE_URL } from "../../../lib/runtime";
import type { FileMeta } from "../lib";
import type { NoteFlowNode } from "./useNoteGraph";

export const PDF_DEFAULT_W = 380;
export const PDF_DEFAULT_H = 460;

// PDF open parameters. Without them Chromium renders the full viewer —
// toolbar, thumbnail navpane, Edge's Summarize button — leaving a 380px card
// mostly chrome. Only Chromium honors these; Firefox's pdf.js ignores
// toolbar/navpanes and keeps its own toolbar. Ignored, never breaking.
const PDF_VIEW_PARAMS = "#toolbar=0&navpanes=0&scrollbar=0&view=FitH";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function extOf(name: string): string {
  const m = name.match(/[.]([A-Za-z0-9]{1,8})$/);
  return (m?.[1] ?? "file").toUpperCase();
}

export function isPdfMeta(meta: FileMeta | null): boolean {
  return !!meta && (meta.mime === "application/pdf" || /\.pdf$/i.test(meta.name));
}

// A dropped file stored in R2, shown as a download card. While `meta` is
// absent the card is an in-flight upload placeholder. PDFs render an in-canvas
// preview via the browser's viewer, behind the same interaction shield as
// embeds (a plugin iframe would otherwise swallow drag gestures).
function FileNodeInner({ id, data, selected }: NodeProps<NoteFlowNode>) {
  const { note, dragging, dimmed, highlit, scrubFade, readOnly, handlers } = data;
  const meta = note.meta as FileMeta | null;
  const isConnectTarget = useConnection((c) => c.inProgress && c.fromNode?.id !== id);
  const pdf = isPdfMeta(meta);

  const [active, setActive] = useState(false);
  useEffect(() => {
    if (!selected) setActive(false);
  }, [selected]);

  const style: CSSProperties = {
    width: note.w ?? (pdf ? PDF_DEFAULT_W : 260),
    opacity: scrubFade ?? 1,
  };
  if (pdf) style.height = note.h ?? PDF_DEFAULT_H;

  const cls = [
    "file-card",
    pdf ? "file-card-pdf" : "",
    selected ? "selected" : "",
    dragging ? "dragging" : "",
    dimmed ? "dim" : "",
    highlit ? "hit" : "",
  ].filter(Boolean).join(" ");

  const url = meta?.key ? `${API_BASE_URL}/api/media/${meta.key}` : null;

  return (
    <>
      <NodeResizer
        isVisible={!readOnly}
        minWidth={160}
        minHeight={pdf ? 160 : 44}
        onResize={(_, p) => handlers.onResize(note.id, p)}
        onResizeEnd={(_, p) => handlers.onResizeEnd(note.id, p)}
      />
      <Handle
        type="target"
        position={Position.Left}
        className={"note-link-target" + (isConnectTarget ? " active" : "") + (readOnly ? " readonly" : "")}
      />
      <div className={cls} data-note-id={note.id} style={style}>
        {url ? (
          <a
            className="file-card-row nodrag"
            href={url}
            target="_blank"
            rel="noopener"
            title={meta!.name}
          >
            <span className="file-card-badge">{extOf(meta!.name)}</span>
            <span className="file-card-info">
              <span className="file-card-name">{meta!.name}</span>
              <span className="file-card-size">{fmtBytes(meta!.size)}</span>
            </span>
          </a>
        ) : (
          <div className="file-card-row">
            <span className="file-card-badge shimmer" aria-label="uploading" />
            <span className="file-card-info">
              <span className="file-card-name">uploading…</span>
            </span>
          </div>
        )}
        {url && pdf && (
          <div className="file-card-preview">
            <div className="file-card-preview-clip">
              <iframe
                className="nodrag"
                src={url + PDF_VIEW_PARAMS}
                title={meta!.name}
                loading="lazy"
                style={{ pointerEvents: active ? "auto" : "none" }}
              />
            </div>
            {!active && (
              <div
                className="obj-embed-shield"
                title="Double-click to interact"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setActive(true);
                }}
              />
            )}
          </div>
        )}
        {note.text && <div className="image-card-caption">{note.text}</div>}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className={"note-link-source nodrag" + (readOnly ? " readonly" : "")}
        isConnectable={!readOnly}
      />
    </>
  );
}

export default memo(FileNodeInner);
