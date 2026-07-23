import type { Edge, Node, NodeChange } from "@xyflow/react";
import type { Dispatch, SetStateAction } from "react";
import { tagsOf, type Note } from "../lib";

export type NoteNodeHandlers = {
  onTextChange: (id: string, v: string) => void;
  onCommitEdit: () => void;
  onTagClick: (tag: string) => void;
  onToggleTask: (id: string, taskIndex: number) => void;
  onResize: (id: string, p: { x: number; y: number; width: number; height: number }) => void;
  onResizeEnd: (id: string, p: { x: number; y: number; width: number; height: number }) => void;
};

export type NoteNodeData = {
  note: Note;
  editing: boolean;
  dragging: boolean;
  dimmed: boolean;
  highlit: boolean;
  focused: boolean;
  fromClipboard: boolean;
  scrubFade: number;
  clickPos: { x: number; y: number } | null;
  handlers: NoteNodeHandlers;
};

export type NoteFlowNode = Node<NoteNodeData, "note">;
export type ThreadFlowEdge = Edge<{ kind: "relation" | "reply" }, "thread">;

export function buildNoteNodes(args: {
  notes: Note[];
  selectedIds: Set<string>;
  editingId: string | null;
  draggingId: string | null;
  snappingId: string | null;
  matchSet: Set<string> | null;
  focusId: string | null;
  scrubMoment: number | null;
  clipboardIds: Set<string>;
  editClickPos: { x: number; y: number } | null;
  // RF-measured node sizes, fed back from "dimensions" changes. Nodes derived
  // without `measured` count as uninitialized and RF refuses to drag/resize
  // them (error #015), so the cache must round-trip through here.
  measuredDims: Map<string, { width: number; height: number }>;
  handlers: NoteNodeHandlers;
}): NoteFlowNode[] {
  return args.notes.map((n) => {
    const editing = args.editingId === n.id;
    const dragging = args.draggingId === n.id;
    const highlit = !!args.matchSet && args.matchSet.has(n.id);
    return {
      id: n.id,
      type: "note" as const,
      position: { x: n.x, y: n.y },
      measured: args.measuredDims.get(n.id),
      selected: args.selectedIds.has(n.id),
      draggable: !editing,
      className: args.snappingId === n.id ? "snapping" : undefined,
      zIndex: editing ? 60 : dragging ? 50 : highlit ? 40 : 0,
      data: {
        note: n,
        editing,
        dragging,
        dimmed: !!args.matchSet && !args.matchSet.has(n.id),
        highlit,
        focused: args.focusId === n.id,
        fromClipboard: args.clipboardIds.has(n.id),
        scrubFade: args.scrubMoment == null ? 1 : n.t <= args.scrubMoment ? 1 : 0,
        clickPos: editing ? args.editClickPos : null,
        handlers: args.handlers,
      },
    };
  });
}

// Interpret React Flow's controlled-mode changes back into app state. Position
// changes stream during drags (and from NodeResizer's n/w handles); select
// changes come from clicks and the marquee; dimension changes carry RF's
// measured sizes, which must be cached and round-tripped onto the derived
// nodes or RF treats them as uninitialized (error #015: no drag, no resize).
export function applyNoteNodeChanges(
  changes: NodeChange<NoteFlowNode>[],
  setters: {
    setNotes: Dispatch<SetStateAction<Note[]>>;
    setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
    measuredDims: Map<string, { width: number; height: number }>;
    onDimensions: () => void;
  },
) {
  const moves = new Map<string, { x: number; y: number }>();
  const sel: Array<[string, boolean]> = [];
  let dims = false;
  for (const c of changes) {
    if (c.type === "position" && c.position) moves.set(c.id, c.position);
    else if (c.type === "select") sel.push([c.id, c.selected]);
    else if (c.type === "dimensions" && c.dimensions) {
      setters.measuredDims.set(c.id, c.dimensions);
      dims = true;
    }
  }
  if (dims) setters.onDimensions();
  if (moves.size) {
    setters.setNotes((ns) =>
      ns.map((n) => {
        const p = moves.get(n.id);
        return p ? { ...n, x: p.x, y: p.y } : n;
      }),
    );
  }
  if (sel.length) {
    setters.setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const [id, s] of sel) {
        if (s) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }
}

// Relation threads (tag-shared, shown for the hovered / lone-selected note when
// relations are on) + the always-on reply spine (each assistant note tied to
// its nearest preceding non-assistant note). Geometry lives in ThreadEdge.
export function buildThreadEdges(args: {
  notes: Note[];
  relationsOn: boolean;
  hoveredId: string | null;
  selectedIds: Set<string>;
}): ThreadFlowEdge[] {
  const { notes, relationsOn, hoveredId, selectedIds } = args;
  const out: ThreadFlowEdge[] = [];
  const mk = (id: string, source: string, target: string, kind: "relation" | "reply"): ThreadFlowEdge => ({
    id,
    source,
    target,
    type: "thread",
    data: { kind },
    selectable: false,
    focusable: false,
  });

  if (notes.some((n) => n.role === "assistant")) {
    const ordered = [...notes].sort((a, b) => a.t - b.t);
    for (let i = 0; i < ordered.length; i++) {
      const ans = ordered[i];
      if (ans.role !== "assistant") continue;
      for (let j = i - 1; j >= 0; j--) {
        if (ordered[j].role !== "assistant") {
          out.push(mk(`reply-${ordered[j].id}-${ans.id}`, ordered[j].id, ans.id, "reply"));
          break;
        }
      }
    }
  }

  if (relationsOn) {
    const activeId = hoveredId ?? (selectedIds.size === 1 ? [...selectedIds][0] : null);
    const active = activeId ? notes.find((n) => n.id === activeId) : null;
    if (active) {
      const activeTags = new Set(tagsOf(active.text));
      if (activeTags.size > 0) {
        for (const n of notes) {
          if (n.id === active.id) continue;
          if (!tagsOf(n.text).some((tag) => activeTags.has(tag))) continue;
          out.push(mk(`rel-${active.id}-${n.id}`, active.id, n.id, "relation"));
        }
      }
    }
  }

  return out;
}
