import { memo, useEffect, useState, type CSSProperties } from "react";
import { Handle, NodeResizer, Position, useConnection, type NodeProps } from "@xyflow/react";
import { emptyTable, embedSrc, type EmbedState, type ObjectMeta, type TableState } from "../lib";
import type { NoteFlowNode, NoteNodeHandlers } from "./useNoteGraph";

// A live canvas object: a widget you and an agent both edit (agent via the MCP
// set_object_state tool → the note's meta.state, which the poll/merge pulls in).
// The kind is generic; this dispatches on objectType. State is held locally so
// typing stays smooth, and re-synced when it changes out-of-band.
function ObjectNodeInner({ id, data, selected }: NodeProps<NoteFlowNode>) {
  const { note, dragging, dimmed, highlit, scrubFade, stackWidth, handlers } = data;
  const isConnectTarget = useConnection((c) => c.inProgress && c.fromNode?.id !== id);
  const meta = note.meta as ObjectMeta | null;
  const objectType = meta?.objectType ?? "table";

  const hasUrl = objectType === "embed" && !!(meta?.state as EmbedState | undefined)?.url;
  const style: CSSProperties = { width: stackWidth ?? note.w ?? (objectType === "embed" ? 480 : 440), opacity: scrubFade ?? 1 };
  if (hasUrl) style.height = note.h ?? 340;
  const cls = [
    "canvas-object", `obj-${objectType}`,
    selected ? "selected" : "", dragging ? "dragging" : "",
    dimmed ? "dim" : "", highlit ? "hit" : "",
  ].filter(Boolean).join(" ");

  return (
    <>
      <NodeResizer isVisible={!!selected} minWidth={220} minHeight={80}
        onResize={(_, p) => handlers.onResize(note.id, p)}
        onResizeEnd={(_, p) => handlers.onResizeEnd(note.id, p)} />
      <Handle type="target" position={Position.Left} className={"note-link-target" + (isConnectTarget ? " active" : "")} />
      <div className={cls} data-note-id={note.id} style={style}>
        {objectType === "embed"
          ? <EmbedWidget id={note.id} state={(meta?.state as EmbedState) ?? { url: "" }} selected={!!selected} handlers={handlers} />
          : <TableWidget id={note.id} state={(meta?.state as TableState) ?? emptyTable()} handlers={handlers} />}
      </div>
      <Handle type="source" position={Position.Right} className="note-link-source nodrag" isConnectable />
    </>
  );
}

function TableWidget({ id, state: metaState, handlers }: { id: string; state: TableState; handlers: NoteNodeHandlers }) {
  // Mirror meta.state locally so typing is smooth; adopt external (agent) writes
  // when they differ from what we hold.
  const [state, setState] = useState<TableState>(metaState);
  const metaJson = JSON.stringify(metaState);
  useEffect(() => {
    if (metaJson !== JSON.stringify(state)) setState(metaState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metaJson]);
  const edit = (next: TableState) => { setState(next); handlers.onObjectState(id, { objectType: "table", state: next }); };
  const setCell = (r: number, c: number, v: string) =>
    edit({ ...state, rows: state.rows.map((row, ri) => (ri === r ? row.map((cell, ci) => (ci === c ? v : cell)) : row)) });
  const setHeader = (c: number, v: string) =>
    edit({ ...state, columns: state.columns.map((col, ci) => (ci === c ? v : col)) });
  const addCol = () => edit({ columns: [...state.columns, ""], rows: state.rows.map((row) => [...row, ""]) });
  const delCol = (c: number) => edit({ columns: state.columns.filter((_, ci) => ci !== c), rows: state.rows.map((row) => row.filter((_, ci) => ci !== c)) });
  const addRow = () => edit({ ...state, rows: [...state.rows, state.columns.map(() => "")] });
  const delRow = (r: number) => edit({ ...state, rows: state.rows.filter((_, ri) => ri !== r) });

  const cols = state.columns.length;
  return (
    <>
      <div className="obj-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr)) 22px` }}>
        {state.columns.map((col, ci) => (
          <div className="obj-cell obj-th" key={"h" + ci}>
            <input className="obj-input nodrag" value={col} placeholder={`Col ${ci + 1}`} onChange={(e) => setHeader(ci, e.target.value)} />
            {cols > 1 && <button type="button" className="obj-del nodrag" title="Delete column" onClick={(e) => { e.stopPropagation(); delCol(ci); }}>×</button>}
          </div>
        ))}
        <div className="obj-cell obj-th obj-corner">
          <button type="button" className="obj-add nodrag" title="Add column" onClick={(e) => { e.stopPropagation(); addCol(); }}>+</button>
        </div>
        {state.rows.map((row, ri) => (
          <div className="obj-row-contents" key={"r" + ri} style={{ display: "contents" }}>
            {Array.from({ length: cols }).map((_, ci) => (
              <div className="obj-cell obj-td" key={ri + "-" + ci}>
                <input className="obj-input nodrag" value={row[ci] ?? ""} onChange={(e) => setCell(ri, ci, e.target.value)} />
              </div>
            ))}
            <div className="obj-cell obj-td obj-rowend">
              <button type="button" className="obj-del nodrag" title="Delete row" onClick={(e) => { e.stopPropagation(); delRow(ri); }}>×</button>
            </div>
          </div>
        ))}
      </div>
      <button type="button" className="obj-add-row nodrag" onClick={(e) => { e.stopPropagation(); addRow(); }}>+ row</button>
    </>
  );
}

function EmbedWidget({ id, state: metaState, selected, handlers }: { id: string; state: EmbedState; selected: boolean; handlers: NoteNodeHandlers }) {
  const [draft, setDraft] = useState(metaState.url);
  useEffect(() => { setDraft(metaState.url); }, [metaState.url]);
  // Interaction is opt-in: a shield sits over the iframe so drag/resize keep
  // pointer capture (a cross-origin iframe would steal it and stick the gesture).
  // Double-click lifts the shield to use the content; deselecting drops it back.
  const [active, setActive] = useState(false);
  useEffect(() => { if (!selected) setActive(false); }, [selected]);
  const commit = (url: string) => handlers.onObjectState(id, { objectType: "embed", state: { ...metaState, url: url.trim() } });

  const src = embedSrc(metaState.url);
  let host = metaState.url;
  try { host = new URL(metaState.url).hostname.replace(/^www\./, ""); } catch { /* keep raw */ }
  // Tauri intercepts window.open to the system browser; the web opens a tab.
  const open = () => window.open(metaState.url, "_blank", "noopener");

  // The bar is the grab handle — a cross-origin iframe swallows pointer events,
  // so without it there's nothing to drag the node by. Deliberately NOT nodrag.
  const bar = metaState.url ? (
    <div className="obj-embed-bar">
      <span className="obj-embed-bar-title" title={metaState.url}>{metaState.title || host}</span>
      <button type="button" className="obj-embed-bar-open nodrag" title="Open in browser" onClick={(e) => { e.stopPropagation(); open(); }}>↗</button>
    </div>
  ) : null;

  let body;
  if (!metaState.url) {
    body = (
      <div className="obj-embed-empty">
        <input
          className="obj-embed-input nodrag"
          placeholder="Paste a link (YouTube, Figma, Spotify, a page…)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") commit(draft); }}
          onBlur={() => draft.trim() && commit(draft)}
        />
      </div>
    );
  } else if (src) {
    body = (
      <div className="obj-embed-frame">
        <iframe
          className="nodrag"
          src={src}
          title={metaState.title || metaState.url}
          loading="lazy"
          allow="autoplay; encrypted-media; picture-in-picture; clipboard-write; fullscreen"
          allowFullScreen
          style={{ pointerEvents: active ? "auto" : "none" }}
        />
        {!active && (
          <div
            className="obj-embed-shield"
            title="Double-click to interact"
            onDoubleClick={(e) => { e.stopPropagation(); setActive(true); }}
          />
        )}
      </div>
    );
  } else {
    // Not embeddable on the web → a link card. (A real browser for any site is
    // the desktop-only webview object.)
    body = (
      <div className="obj-embed-card">
        <div className="obj-embed-url">{metaState.url}</div>
        <button type="button" className="obj-embed-open nodrag" onClick={(e) => { e.stopPropagation(); open(); }}>Open ↗</button>
      </div>
    );
  }

  return (<>{bar}<div className="obj-embed-body">{body}</div></>);
}

export default memo(ObjectNodeInner);
