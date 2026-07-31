import { useMemo } from "react";
import { Background, BackgroundVariant, PanOnScrollMode, ReactFlow } from "@xyflow/react";
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
        measuredDims: new Map(),
        dropTargetId: null,
        readOnly: true,
        handlers: p.handlers,
      }),
    [p.notes, p.expandedIds, p.handlers],
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
      nodes={nodes}
      edges={edges}
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
