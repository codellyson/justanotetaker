import { useInternalNode, type EdgeProps } from "@xyflow/react";
import type { ThreadFlowEdge } from "./useNoteGraph";

type RfNode = { internals: { positionAbsolute: { x: number; y: number } }; measured: { width?: number; height?: number } };

// Where the center→center line exits a note's rectangle, so the thread springs
// from the card's border instead of starting hidden under it.
function borderPoint(n: RfNode, towardX: number, towardY: number) {
  const w = n.measured.width ?? 220;
  const h = n.measured.height ?? 56;
  const cx = n.internals.positionAbsolute.x + w / 2;
  const cy = n.internals.positionAbsolute.y + h / 2;
  const dx = towardX - cx, dy = towardY - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  // Scale the direction until it touches the nearest side of the half-extent box.
  const scale = 1 / Math.max(Math.abs(dx) / (w / 2), Math.abs(dy) / (h / 2));
  return { x: cx + dx * scale, y: cy + dy * scale };
}

// Floating edge between notes — ignores handle positions and draws the
// hand-drawn thread: a soft cubic curve bowed to one side, anchored to each
// note's border so it reads as a flowing connection, not a rigid strut.
export function ThreadEdge({ source, target, data }: EdgeProps<ThreadFlowEdge>) {
  const a = useInternalNode(source);
  const b = useInternalNode(target);
  if (!a || !b) return null;

  const ca = { x: a.internals.positionAbsolute.x + (a.measured.width ?? 220) / 2, y: a.internals.positionAbsolute.y + (a.measured.height ?? 56) / 2 };
  const cb = { x: b.internals.positionAbsolute.x + (b.measured.width ?? 220) / 2, y: b.internals.positionAbsolute.y + (b.measured.height ?? 56) / 2 };
  const p = borderPoint(a, cb.x, cb.y);
  const q = borderPoint(b, ca.x, ca.y);

  const dx = q.x - p.x, dy = q.y - p.y;
  const len = Math.hypot(dx, dy) || 1;
  // A generous, length-scaled bow so long threads still visibly arc.
  const bow = Math.max(26, Math.min(140, len * 0.28));
  const nx = -dy / len, ny = dx / len;
  // Two control points at 1/3 and 2/3, pulled to the same side by the SAME bow
  // so the arc is symmetric — its fullest point sits in the middle rather than
  // leaning toward either note.
  const c1x = p.x + dx / 3 + nx * bow, c1y = p.y + dy / 3 + ny * bow;
  const c2x = p.x + (dx * 2) / 3 + nx * bow, c2y = p.y + (dy * 2) / 3 + ny * bow;
  const d = `M ${p.x} ${p.y} C ${c1x} ${c1y} ${c2x} ${c2y} ${q.x} ${q.y}`;

  const kind = data?.kind ?? "relation";
  return (
    <>
      <path
        d={d}
        pathLength={1}
        className={`thread thread-${kind}` + (data?.selected ? " thread-hot" : "")}
      />
      {/* User links are clickable (select → Backspace deletes); the visible
          1.5px curve is too thin a target, so a fat invisible twin takes the
          pointer events. */}
      {kind === "link" && <path d={d} className="thread-hit" />}
    </>
  );
}
