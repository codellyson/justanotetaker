import type { MouseEvent as ReactMouseEvent } from "react";
import {
  Background,
  BackgroundVariant,
  PanOnScrollMode,
  ReactFlow,
  SelectionMode,
  type EdgeMouseHandler,
  type EdgeTypes,
  type NodeMouseHandler,
  type NodeTypes,
  type OnConnect,
  type OnConnectEnd,
  type OnMove,
  type OnNodeDrag,
  type OnNodesChange,
  type Viewport,
} from "@xyflow/react";
// Full stylesheet: base positioning plus NodeResizer/selection styles. Its
// node/edge cosmetics only target the built-in types (default/input/output),
// so the custom "note" node and "thread" edge stay unstyled by it.
import "@xyflow/react/dist/style.css";
import { GRID, type Tweaks } from "../lib";
import NoteNode from "./NoteNode";
import FrameNode from "./FrameNode";
import ImageNode from "./ImageNode";
import TaskNode from "./TaskNode";
import { ThreadEdge } from "./ThreadEdge";
import type { NoteFlowNode, ThreadFlowEdge } from "./useNoteGraph";

const nodeTypes: NodeTypes = { note: NoteNode, frame: FrameNode, image: ImageNode, task: TaskNode };
const edgeTypes: EdgeTypes = { thread: ThreadEdge };
// ⌘ on mac, Ctrl elsewhere — matching the old handlers, which accepted either.
const MOD_KEYS = ["Meta", "Control"];

type Props = {
  nodes: NoteFlowNode[];
  edges: ThreadFlowEdge[];
  onNodesChange: OnNodesChange<NoteFlowNode>;
  defaultViewport: Viewport;
  grid: Tweaks["grid"];
  snapEnabled: boolean;
  onMove: OnMove;
  onMoveStart: OnMove;
  onNodeClick: NodeMouseHandler<NoteFlowNode>;
  onNodeDoubleClick: NodeMouseHandler<NoteFlowNode>;
  onNodeContextMenu: NodeMouseHandler<NoteFlowNode>;
  onNodeMouseEnter: NodeMouseHandler<NoteFlowNode>;
  onNodeMouseLeave: NodeMouseHandler<NoteFlowNode>;
  onNodeDragStart: OnNodeDrag<NoteFlowNode>;
  onNodeDrag: OnNodeDrag<NoteFlowNode>;
  onNodeDragStop: OnNodeDrag<NoteFlowNode>;
  onPaneClick: (e: ReactMouseEvent) => void;
  onPaneContextMenu: (e: MouseEvent | ReactMouseEvent) => void;
  onConnect: OnConnect;
  onConnectEnd: OnConnectEnd;
  onEdgeClick: EdgeMouseHandler<ThreadFlowEdge>;
};

export function FlowCanvas(p: Props) {
  return (
    <ReactFlow<NoteFlowNode, ThreadFlowEdge>
      nodes={p.nodes}
      edges={p.edges}
      onNodesChange={p.onNodesChange}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      // View — parity with the old wheel/pointer handlers: wheel pans 1:1,
      // ⌘/Ctrl+wheel (and trackpad/touch pinch) zooms at the cursor.
      minZoom={0.32}
      maxZoom={2.5}
      panOnScroll
      panOnScrollMode={PanOnScrollMode.Free}
      panOnScrollSpeed={1}
      zoomOnScroll={false}
      zoomActivationKeyCode={MOD_KEYS}
      zoomOnPinch
      zoomOnDoubleClick={false}
      panOnDrag
      defaultViewport={p.defaultViewport}
      // Selection — ⌘/Ctrl-drag marquee, partial intersection like the old
      // AABB test; Shift+click adds to the selection.
      selectionOnDrag={false}
      selectionKeyCode={MOD_KEYS}
      selectionMode={SelectionMode.Partial}
      multiSelectionKeyCode="Shift"
      // Selection elevation is handled in buildNoteNodes' zIndex ladder — RF's
      // +1000 would lift a selected frame above its members and eat their
      // pointer events.
      elevateNodesOnSelect={false}
      // Drag — 3px click-vs-drag slop; grid snap is tweak-gated and disabled
      // while Shift is held (state fed from the orchestrator).
      nodeDragThreshold={3}
      paneClickDistance={2}
      snapToGrid={p.snapEnabled}
      snapGrid={[GRID, GRID]}
      // Connections: drag from a note's link dot onto another note.
      nodesConnectable
      onConnect={p.onConnect}
      onConnectEnd={p.onConnectEnd}
      connectionRadius={30}
      isValidConnection={(c) => c.source !== c.target}
      connectionLineStyle={{ stroke: "rgb(var(--accent))", strokeWidth: 1.5, strokeDasharray: "4 4", fill: "none" }}
      onEdgeClick={p.onEdgeClick}
      edgesFocusable={false}
      // The global keydown map stays authoritative: no RF delete key, no RF
      // arrow-nudge/Escape handling to fight the app's Escape cascade.
      deleteKeyCode={null}
      disableKeyboardA11y
      proOptions={{ hideAttribution: true }}
      onMove={p.onMove}
      onMoveStart={p.onMoveStart}
      onNodeClick={p.onNodeClick}
      onNodeDoubleClick={p.onNodeDoubleClick}
      onNodeContextMenu={p.onNodeContextMenu}
      onNodeMouseEnter={p.onNodeMouseEnter}
      onNodeMouseLeave={p.onNodeMouseLeave}
      onNodeDragStart={p.onNodeDragStart}
      onNodeDrag={p.onNodeDrag}
      onNodeDragStop={p.onNodeDragStop}
      onPaneClick={p.onPaneClick}
      onPaneContextMenu={p.onPaneContextMenu}
    >
      {p.grid !== "off" && (
        <Background
          variant={p.grid === "lines" ? BackgroundVariant.Lines : BackgroundVariant.Dots}
          gap={p.grid === "lines" ? 56 : GRID}
          size={p.grid === "lines" ? undefined : 1.2}
          lineWidth={p.grid === "lines" ? 1 : undefined}
          color={p.grid === "lines" ? "rgb(var(--text-secondary) / 0.06)" : "rgb(var(--text-secondary) / 0.12)"}
        />
      )}
    </ReactFlow>
  );
}
