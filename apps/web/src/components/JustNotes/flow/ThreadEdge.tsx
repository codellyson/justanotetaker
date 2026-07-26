import { getBezierPath, Position, useInternalNode, type EdgeProps } from "@xyflow/react";
import type { ThreadFlowEdge } from "./useNoteGraph";

type RfNode = { internals: { positionAbsolute: { x: number; y: number } }; measured: { width?: number; height?: number } };

// Where the center→center line exits a note's rectangle, plus which side it
// leaves from — so React Flow's bezier can curve out of the right edge cleanly
// instead of starting hidden under the card.
function anchor(n: RfNode, towardX: number, towardY: number) {
  const w = n.measured.width ?? 220;
  const h = n.measured.height ?? 56;
  const cx = n.internals.positionAbsolute.x + w / 2;
  const cy = n.internals.positionAbsolute.y + h / 2;
  const dx = towardX - cx, dy = towardY - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy, pos: Position.Right };
  const scale = 1 / Math.max(Math.abs(dx) / (w / 2), Math.abs(dy) / (h / 2));
  const horizontal = Math.abs(dx) / (w / 2) >= Math.abs(dy) / (h / 2);
  const pos = horizontal ? (dx > 0 ? Position.Right : Position.Left) : (dy > 0 ? Position.Bottom : Position.Top);
  return { x: cx + dx * scale, y: cy + dy * scale, pos };
}

// Floating edge between notes: anchored to each card's border, drawn with React
// Flow's own bezier path (getBezierPath) so it reads as a clean native curve.
export function ThreadEdge({ source, target, data }: EdgeProps<ThreadFlowEdge>) {
  const a = useInternalNode(source);
  const b = useInternalNode(target);
  if (!a || !b) return null;

  const ca = { x: a.internals.positionAbsolute.x + (a.measured.width ?? 220) / 2, y: a.internals.positionAbsolute.y + (a.measured.height ?? 56) / 2 };
  const cb = { x: b.internals.positionAbsolute.x + (b.measured.width ?? 220) / 2, y: b.internals.positionAbsolute.y + (b.measured.height ?? 56) / 2 };
  const s = anchor(a, cb.x, cb.y);
  const t = anchor(b, ca.x, ca.y);

  const [d] = getBezierPath({
    sourceX: s.x, sourceY: s.y, sourcePosition: s.pos,
    targetX: t.x, targetY: t.y, targetPosition: t.pos,
  });

  const kind = data?.kind ?? "relation";
  return (
    <>
      <path d={d} pathLength={1} className={`thread thread-${kind}` + (data?.selected ? " thread-hot" : "")} />
      {/* User links are clickable (select → Backspace deletes); the visible
          curve is too thin a target, so a fat invisible twin takes the hits. */}
      {kind === "link" && <path d={d} className="thread-hit" />}
    </>
  );
}
