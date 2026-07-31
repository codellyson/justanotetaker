import { useCallback, useMemo, useReducer, useRef } from "react";
import {
  Background,
  BackgroundVariant,
  PanOnScrollMode,
  ReactFlow,
  type OnNodesChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { GRID, type Note } from "../lib";
import { edgeTypes, nodeTypes } from "./FlowCanvas";
import {
  buildNoteNodes,
  buildThreadEdges,
  type NoteFlowNode,
  type NoteNodeHandlers,
  type ThreadFlowEdge,
} from "./useNoteGraph";

const EMPTY = new Set<string>();

type Props = {
  notes: Note[];
  links: { id: string; a: string; b: string }[];
  expandedIds: Set<string>;
  handlers: NoteNodeHandlers;
};

export function PublicCanvas(p: Props) {
  // buildNoteNodes sets `measured` from this map, so React Flow keeps a node
  // hidden until we've fed its size back in. The authed canvas fills the map
  // from onNodesChange; without that here every node stays 0×0 and invisible,
  // and fitView has no bounds to fit.
  const measuredDims = useRef(new Map<string, { width: number; height: number }>());
  const [measuredTick, bumpMeasured] = useReducer((n: number) => n + 1, 0);

  const onNodesChange = useCallback<OnNodesChange<NoteFlowNode>>((changes) => {
    let dims = false;
    for (const c of changes) {
      if (c.type === "dimensions" && c.dimensions) {
        measuredDims.current.set(c.id, c.dimensions);
        dims = true;
      }
    }
    if (dims) bumpMeasured();
  }, []);

  const nodes = useMemo(
    () =>
      buildNoteNodes({
        notes: p.notes,
        selectedIds: EMPTY,
        editingId: null,
        draggingId: null,
        snappingId: null,
        matchSet: null,
        focusId: null,
        scrubMoment: null,
        clipboardIds: EMPTY,
        expandedIds: p.expandedIds,
        editClickPos: null,
        measuredDims: measuredDims.current,
        dropTargetId: null,
        readOnly: true,
        handlers: p.handlers,
      }),
    [p.notes, p.expandedIds, p.handlers, measuredTick],
  );
  const edges = useMemo(
    () =>
      buildThreadEdges({
        notes: p.notes,
        links: p.links,
        selectedLinkId: null,
        relationsOn: false,
        hoveredId: null,
        selectedIds: EMPTY,
      }),
    [p.notes, p.links],
  );

  return (
    <ReactFlow<NoteFlowNode, ThreadFlowEdge>
      // jn-flow is load-bearing, not cosmetic: it flips .note from absolute to
      // relative so the RF wrapper can measure a real size. Without it every
      // node measures 0×0, stays hidden as uninitialized, and fitView has no
      // bounds — a blank canvas.
      className="jn-flow"
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
      minZoom={0.32}
      maxZoom={2.5}
      panOnScroll
      panOnScrollMode={PanOnScrollMode.Free}
      panOnScrollSpeed={1}
      zoomOnScroll={false}
      zoomActivationKeyCode={["Meta", "Control"]}
      zoomOnPinch
      zoomOnDoubleClick={false}
      panOnDrag
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      edgesFocusable={false}
      elevateNodesOnSelect={false}
      deleteKeyCode={null}
      disableKeyboardA11y
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={GRID} size={1.2} color="rgb(var(--text-secondary) / 0.12)" />
    </ReactFlow>
  );
}
