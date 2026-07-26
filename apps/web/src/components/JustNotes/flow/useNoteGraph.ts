import type { Edge, Node, NodeChange } from "@xyflow/react";
import type { Dispatch, SetStateAction } from "react";
import { countTasks, tagsOf, type FrameMeta, type Note, type ObjectMeta } from "../lib";
import { FRAME_DEFAULT_W, FRAME_PAD } from "./FrameNode";

export type NoteNodeHandlers = {
  onTextChange: (id: string, v: string) => void;
  onCommitEdit: () => void;
  onTagClick: (tag: string) => void;
  onToggleTask: (id: string, taskIndex: number) => void;
  onResize: (id: string, p: { x: number; y: number; width: number; height: number }) => void;
  onResizeEnd: (id: string, p: { x: number; y: number; width: number; height: number }) => void;
  // Frames: fold/unfold the region; fly the camera to it; toggle column layout.
  onToggleCollapse: (id: string) => void;
  onToggleLayout: (id: string) => void;
  onFrameLabelClick: (id: string) => void;
  // Content notes: expand/collapse a tall note's height (peek ⇄ full).
  onToggleHeight: (id: string) => void;
  // Canvas objects: commit an object's edited state (table, embed, …).
  onObjectState: (id: string, meta: ObjectMeta) => void;
  // Task cards (Tauri): run/retry the local claude job.
  onRunTask?: (id: string) => void;
  // Canvas objects: commit a new state blob (e.g. a table edit).
  onTableState: (id: string, state: TableState) => void;
};

// What a frame's label bar reports about its members.
export type FrameStats = { count: number; done: number; total: number };

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
  // Content notes: user chose to show a tall note at full height (overrides the
  // auto-collapse-to-a-peek default).
  expanded?: boolean;
  // Set on a note that lives in a kanban column: the lane's inner width, which
  // overrides the note's own width so it fills the column.
  stackWidth?: number;
  // Frames only.
  collapsed?: boolean;
  frameLayout?: "free" | "stack";
  frameStats?: FrameStats;
  // Frames only: this column is the live drop target of a card drag.
  isDropTarget?: boolean;
  handlers: NoteNodeHandlers;
};

export type NoteFlowNode = Node<NoteNodeData>;
export type ThreadEdgeData = {
  kind: "relation" | "link";
  // Set on user-drawn links: the persisted link id, and whether it's the
  // currently selected one (drawn hot, Backspace deletes it).
  linkId?: string;
  selected?: boolean;
};
export type ThreadFlowEdge = Edge<ThreadEdgeData, "thread">;

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
  expandedIds: Set<string>;
  editClickPos: { x: number; y: number } | null;
  // RF-measured node sizes, fed back from "dimensions" changes. Nodes derived
  // without `measured` count as uninitialized and RF refuses to drag/resize
  // them (error #015), so the cache must round-trip through here.
  measuredDims: Map<string, { width: number; height: number }>;
  // The kanban column currently highlighted as a card's drop target.
  dropTargetId: string | null;
  handlers: NoteNodeHandlers;
}): NoteFlowNode[] {
  // A collapsed frame folds to its label bar and its whole subtree disappears
  // from the canvas (state + sync untouched — just not rendered). Nesting-aware:
  // collapsing a board hides its lanes and their cards, not just direct members.
  const collapsedFrames = new Set(
    args.notes
      .filter((n) => n.kind === "frame" && (n.meta as FrameMeta | null)?.collapsed)
      .map((n) => n.id),
  );
  const parentOf = new Map(args.notes.map((n) => [n.id, n.parentId ?? null]));
  const hasCollapsedAncestor = (id: string) => {
    let p = parentOf.get(id) ?? null;
    while (p) {
      if (collapsedFrames.has(p)) return true;
      p = parentOf.get(p) ?? null;
    }
    return false;
  };
  // Stack columns: members get a CSS transition (glide on re-pack) AND render at
  // the lane's inner width so a wide page fits the column instead of overflowing.
  const stackInnerW = new Map<string, number>();
  for (const n of args.notes) {
    if (n.kind === "frame" && (n.meta as FrameMeta | null)?.layout === "stack") {
      stackInnerW.set(n.id, Math.max(80, (n.w ?? FRAME_DEFAULT_W) - FRAME_PAD * 2));
    }
  }
  const stackFrameIds = new Set(stackInnerW.keys());
  const statsByFrame = new Map<string, FrameStats>();
  for (const n of args.notes) {
    if (!n.parentId || n.kind === "frame") continue;
    const s = statsByFrame.get(n.parentId) ?? { count: 0, done: 0, total: 0 };
    s.count++;
    const t = countTasks(n.text);
    s.done += t.done;
    s.total += t.total;
    statsByFrame.set(n.parentId, s);
  }

  return args.notes.filter((n) => !hasCollapsedAncestor(n.id)).map((n) => {
    const editing = args.editingId === n.id;
    const dragging = args.draggingId === n.id;
    const highlit = !!args.matchSet && args.matchSet.has(n.id);
    const selected = args.selectedIds.has(n.id);
    // zIndex contract: frames sit below EVERYTHING, always — even selected or
    // dragging — so their members stay visible and clickable on top. All other
    // kinds keep the editing/dragging/hit ladder, with selection elevated here
    // because RF's elevateNodesOnSelect is disabled (it would lift a selected
    // frame +1000 above its members).
    const zIndex =
      // A wrapping board frame sits below its nested lanes (which sit below all
      // content), so the board's fill never paints over the lanes.
      n.kind === "frame" ? (n.parentId ? -10 : -11) :
      editing ? 60 : dragging ? 50 : highlit ? 40 : selected ? 30 : 0;
    return {
      id: n.id,
      type: n.kind === "frame" ? "frame" : n.kind === "image" ? "image" : n.kind === "task" ? "task" : n.kind === "object" ? "object" : "note",
      position: { x: n.x, y: n.y },
      measured: args.measuredDims.get(n.id),
      selected,
      draggable: !editing,
      className: [
        args.snappingId === n.id ? "snapping" : "",
        n.parentId && stackFrameIds.has(n.parentId) ? "stack-member" : "",
      ].filter(Boolean).join(" ") || undefined,
      zIndex,
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
        expanded: args.expandedIds.has(n.id),
        stackWidth: n.parentId ? stackInnerW.get(n.parentId) : undefined,
        collapsed: n.kind === "frame" ? collapsedFrames.has(n.id) : undefined,
        frameLayout: n.kind === "frame" ? ((n.meta as FrameMeta | null)?.layout ?? "free") : undefined,
        frameStats: n.kind === "frame" ? statsByFrame.get(n.id) ?? { count: 0, done: 0, total: 0 } : undefined,
        isDropTarget: n.kind === "frame" ? n.id === args.dropTargetId : undefined,
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

// User-drawn links (always on) + relation threads (tag-shared, shown for the
// hovered / lone-selected note when relations are on). Geometry lives in
// ThreadEdge.
export function buildThreadEdges(args: {
  notes: Note[];
  links: { id: string; a: string; b: string }[];
  selectedLinkId: string | null;
  relationsOn: boolean;
  hoveredId: string | null;
  selectedIds: Set<string>;
}): ThreadFlowEdge[] {
  const { notes, links, selectedLinkId, relationsOn, hoveredId, selectedIds } = args;
  const out: ThreadFlowEdge[] = [];
  const mk = (id: string, source: string, target: string, kind: ThreadEdgeData["kind"]): ThreadFlowEdge => ({
    id,
    source,
    target,
    type: "thread",
    data: { kind },
    selectable: false,
    focusable: false,
  });

  const have = new Set(notes.map((n) => n.id));
  for (const l of links) {
    if (!have.has(l.a) || !have.has(l.b)) continue; // endpoint deleted/culled
    const e = mk(`link-${l.id}`, l.a, l.b, "link");
    e.data = { kind: "link", linkId: l.id, selected: l.id === selectedLinkId };
    out.push(e);
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
