import { lazy, memo, Suspense, useState, type CSSProperties } from "react";
import { Handle, NodeResizer, Position, useConnection, type NodeProps } from "@xyflow/react";
import {
  RECENCY_ALPHA,
  PAPER_W,
  firstNonEmpty,
  recencyOf,
  resolveNoteColor,
  restAfterFirst,
} from "../lib";
import { renderBody, renderHeadline } from "../markdown";
import { CmMeasureBridge } from "./CmMeasureBridge";
import type { NoteFlowNode } from "./useNoteGraph";

// CodeMirror pulls in ~65KB gzipped; load it only when the focused editor
// opens so it never touches the initial bundle or the canvas cards.
const CmEditor = lazy(() => import("../CmEditor"));

function NoteNodeInner({ id, data, selected }: NodeProps<NoteFlowNode>) {
  const { note, editing, dragging, dimmed, highlit, focused, fromClipboard, scrubFade, clickPos, handlers } = data;
  // Bumped on every canvas pan/zoom while editing → CmEditor re-measures.
  const [measureTick, setMeasureTick] = useState(0);
  // While a connection drag is in flight from another note, the whole card
  // becomes a drop target (the cover handle switches its pointer-events on).
  // Selector returns a primitive so the store subscription stays stable.
  const isConnectTarget = useConnection((c) => c.inProgress && c.fromNode?.id !== id);
  const rec = recencyOf(note.t);

  const first = firstNonEmpty(note.text);
  const rest = restAfterFirst(note.text);
  const headingMatch = first.trim().match(/^(#{1,6})\s+/);
  const headingLevel = headingMatch ? Math.min(headingMatch[1].length, 3) : 0;
  const isHeading = headingLevel > 0;
  // When the note opens with a block (code fence, list, task, quote, ordered
  // item, rule, or image), render the whole text through renderBody rather
  // than treating the first line as a headline — otherwise a task list's
  // first item becomes an un-checkable title and the toggle indices drift.
  const startsWithBlock = /^\s*(`{3,}|>|[-*]\s+\[[ xX]\]|[-*]\s|\d+\.\s|!\[[^\]]*\]\(|(-{3,}|\*{3,})\s*$)/.test(first);
  const onToggle = (taskIndex: number) => handlers.onToggleTask(note.id, taskIndex);

  const cls = [
    "note",
    `rec-${rec}`,
    editing ? "editing" : "",
    dragging ? "dragging" : "",
    dimmed ? "dim" : "",
    highlit ? "hit" : "",
    focused ? "focused" : "",
    selected ? "selected" : "",
    `kind-${note.kind}`,
    note.color ? "tinted" : "",
    isHeading && !editing ? "has-heading" : "",
  ].filter(Boolean).join(" ");

  // A tinted note carries its own bg/ink and opts out of the recency fade so
  // the color stays true; the fade only applies to plain cards.
  const col = resolveNoteColor(note.color);
  // Body text: on a tinted note follow its ink (the theme's text-secondary is
  // unreadable on a light tint); otherwise the usual dimmed secondary.
  const bodyColor = col ? `rgb(${col.ink})` : "rgb(var(--text-secondary))";
  const style: CSSProperties = {
    backgroundColor: col ? col.bg : "rgb(var(--bg-secondary))",
    color: col ? `rgb(${col.ink})` : "rgb(var(--text-primary))",
    opacity: (note.kind === "card" && !col ? RECENCY_ALPHA[rec] : 1) * (scrubFade ?? 1),
  };
  // Exposed so a tinted note can re-point the muted theme tokens at its ink,
  // keeping list/quote/mark colors legible in both the rendered view and editor.
  if (col) (style as Record<string, string | number>)["--note-ink"] = col.ink;
  if (note.kind === "page") {
    style.width = note.w ?? PAPER_W;
    style.minHeight = note.h ?? 200;
  } else {
    // card (legacy): resizable, else content-height from CSS.
    if (note.w != null) style.width = note.w;
    if (note.h != null) {
      style.maxHeight = "none";
      if (!editing) style.height = note.h;
    }
  }

  return (
    <>
      <NodeResizer
        isVisible={!editing}
        minWidth={120}
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
        {editing ? (
          <>
            <CmMeasureBridge onViewportChange={() => setMeasureTick((v) => v + 1)} />
            <Suspense fallback={<div className="note-cm note-cm-loading" />}>
              <CmEditor
                value={note.text}
                onChange={(v) => handlers.onTextChange(note.id, v)}
                onCommit={handlers.onCommitEdit}
                className="note-cm nodrag"
                clickPos={clickPos}
                measureSignal={measureTick}
              />
            </Suspense>
          </>
        ) : startsWithBlock ? (
          <div className="note-rest" style={{ color: bodyColor }}>
            {renderBody(note.text, { onToggle })}
          </div>
        ) : (
          <>
            {first
              ? <div className={"note-first" + (headingLevel ? ` md-h md-h${headingLevel}` : "")}>{renderHeadline(first)}</div>
              : <div className="note-first" style={{ opacity: 0.35 }}>empty</div>}
            {rest && <div className="note-rest" style={{ color: bodyColor }}>{renderBody(rest, { onToggle })}</div>}
          </>
        )}
        {!editing && fromClipboard && (
          <div className="note-clip" title="captured from clipboard" aria-label="captured from clipboard">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="8" y="2" width="8" height="4" rx="1" />
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
            </svg>
          </div>
        )}
        {!editing && <div className="note-pad-cover" aria-hidden="true" />}
      </div>
      {/* Drag from this dot onto another note to link them (nodrag so the
          gesture starts a connection, not a card drag). */}
      <Handle
        type="source"
        position={Position.Right}
        className="note-link-source nodrag"
        isConnectable={!editing}
      />
    </>
  );
}

export default memo(NoteNodeInner);
