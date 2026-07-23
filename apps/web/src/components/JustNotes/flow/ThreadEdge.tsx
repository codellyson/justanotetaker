import { useInternalNode, type EdgeProps } from "@xyflow/react";
import type { ThreadFlowEdge } from "./useNoteGraph";

// Floating edge between note centers — ignores handle positions entirely and
// reproduces the hand-drawn thread look: a quadratic curve bowed perpendicular
// to the line between centers. Centers use measured node sizes, so threads
// anchor correctly on tall pages (the old SVG layer guessed 56px).
export function ThreadEdge({ source, target, data }: EdgeProps<ThreadFlowEdge>) {
  const a = useInternalNode(source);
  const b = useInternalNode(target);
  if (!a || !b) return null;

  const center = (n: NonNullable<typeof a>) => ({
    x: n.internals.positionAbsolute.x + (n.measured.width ?? 220) / 2,
    y: n.internals.positionAbsolute.y + (n.measured.height ?? 56) / 2,
  });
  const p = center(a);
  const q = center(b);
  const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
  const dx = q.x - p.x, dy = q.y - p.y;
  const len = Math.hypot(dx, dy) || 1;
  const bow = Math.min(48, len * 0.14);
  const cx = mx + (-dy / len) * bow, cy = my + (dx / len) * bow;
  const d = `M ${p.x} ${p.y} Q ${cx} ${cy} ${q.x} ${q.y}`;

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
