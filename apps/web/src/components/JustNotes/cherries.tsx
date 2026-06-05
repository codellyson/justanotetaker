import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Note } from "./lib";

// Server-safe "are we on the client yet?" — used to defer rendering of
// anything that depends on window dimensions until after hydration.
function useIsClient() {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

// Subscribe to Date.now() ticks at ~1Hz, only when `active`. Pure during
// render — the impure read happens in getSnapshot, which React handles.
function useNow(active: boolean) {
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!active) return () => {};
      const id = window.setInterval(cb, 1000);
      return () => clearInterval(id);
    },
    [active],
  );
  return useSyncExternalStore(subscribe, () => Date.now(), () => 0);
}

// ── AmbientBar ─────────────────────────────────────────────────────────
export function AmbientBar({
  query,
  matchCount,
  recallIdx,
}: {
  query: string;
  matchCount: number | null;
  recallIdx: number;
}) {
  const hasQuery = query.length > 0;
  const matches = matchCount ?? 0;
  let action: React.ReactNode;
  if (!hasQuery) {
    action = <span className="a-action">type to recall &nbsp;·&nbsp; <b>esc</b> close</span>;
  } else if (matches === 0) {
    action = <span className="a-action"><b>↵</b> write “{query}”</span>;
  } else {
    action = <span className="a-action"><b>↵</b> jump &nbsp;·&nbsp; <b>↑↓</b> step &nbsp;·&nbsp; <b>⌘↵</b> write</span>;
  }
  return (
    <div className="ambient-bar" role="status" aria-live="polite">
      <span className="a-prompt">›</span>
      <span className="a-q">{query}<span className="a-cursor" /></span>
      <span className="a-sep" />
      <span className="a-meta">
        {hasQuery
          ? matches === 0
            ? <>nothing</>
            : <><span className="a-num">{recallIdx + 1}</span> / {matches}</>
          : <>ambient</>}
      </span>
      <span className="a-sep" />
      {action}
    </div>
  );
}

// ── TimeScrub ──────────────────────────────────────────────────────────
export function TimeScrub({
  notes,
  scrubMoment,
  setScrubMoment,
}: {
  notes: Note[];
  scrubMoment: number | null;
  setScrubMoment: (m: number | null) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState(0);
  const [hover, setHover] = useState(false);
  const active = scrubMoment != null;

  const oldestT = useMemo(() => {
    if (!notes.length) return 0;
    let m = Infinity;
    for (const n of notes) if (n.t < m) m = n.t;
    return m;
  }, [notes]);

  const now = useNow(active || hover);

  function posToMoment(p: number) {
    const now = Date.now();
    return now - p * (now - oldestT);
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const set = (clientY: number) => {
      const raw = (clientY - rect.top) / rect.height;
      const p = Math.max(0, Math.min(1, raw));
      setPos(p);
      setScrubMoment(posToMoment(p));
    };
    set(e.clientY);
    const onMove = (ev: PointerEvent) => set(ev.clientY);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setScrubMoment(null);
      setPos(0);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  const label = useMemo(() => {
    if (!active && !hover) return "rewind";
    const m = active ? (scrubMoment as number) : now;
    const ageMs = now - m;
    if (ageMs < 60 * 1000) return "now";
    const min = ageMs / 60000;
    if (min < 60) return `${Math.round(min)}m ago`;
    const hr = min / 60;
    if (hr < 36) return `${Math.round(hr)}h ago`;
    const d = hr / 24;
    if (d < 14) return `${Math.round(d)}d ago`;
    const w = d / 7;
    if (w < 9) return `${Math.round(w)}w ago`;
    return `${Math.round(d / 30)}mo ago`;
  }, [active, hover, scrubMoment, now]);

  const thumbY = `${pos * 100}%`;

  return (
    <div
      ref={trackRef}
      className={"scrub-track" + (active ? " active" : "")}
      onPointerDown={onPointerDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-label="Rewind canvas through time"
    >
      <span className="scrub-baseline" />
      <div className="scrub-thumb" style={{ top: thumbY }} />
      <div className="scrub-label" style={{ top: thumbY }}>
        <span className="lbl-text">{label}</span>
      </div>
    </div>
  );
}

// ── Compass ────────────────────────────────────────────────────────────
export function Compass({
  notes,
  view,
  flyHome,
}: {
  notes: Note[];
  view: { pan: { x: number; y: number }; zoom: number };
  flyHome: () => void;
}) {
  const [, setTick] = useState(0);
  const isClient = useIsClient();
  useEffect(() => {
    const onR = () => setTick((x) => x + 1);
    window.addEventListener("resize", onR);
    return () => window.removeEventListener("resize", onR);
  }, []);

  if (!isClient) return null;
  if (!notes.length) return null;

  let sx = 0, sy = 0;
  for (const n of notes) { sx += n.x; sy += n.y; }
  const cx_c = sx / notes.length;
  const cy_c = sy / notes.length;

  const cx_s = cx_c * view.zoom + view.pan.x;
  const cy_s = cy_c * view.zoom + view.pan.y;

  const W = window.innerWidth, H = window.innerHeight;
  const m = 60;

  const offLeft   = cx_s < -m;
  const offRight  = cx_s > W + m;
  const offTop    = cy_s < -m;
  const offBottom = cy_s > H + m;
  if (!(offLeft || offRight || offTop || offBottom)) return null;

  const vx = W / 2, vy = H / 2;
  const dx = cx_s - vx, dy = cy_s - vy;
  const inset = 64;
  const tx = dx > 0 ? (W - inset - vx) / dx : dx < 0 ? (inset - vx) / dx : Infinity;
  const ty = dy > 0 ? (H - inset - vy) / dy : dy < 0 ? (inset - vy) / dy : Infinity;
  const tParam = Math.min(Math.abs(tx), Math.abs(ty));
  const ex = vx + dx * tParam;
  const ey = vy + dy * tParam;

  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;

  return (
    <div className="compass-tick" style={{ left: ex, top: ey }} onClick={flyHome}>
      <span className="c-arrow" style={{ transform: `rotate(${angle}deg)` }}>
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
          <path d="M1 5.5 L9.5 5.5 M6 2 L9.5 5.5 L6 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span>notes</span>
      <kbd>h</kbd>
    </div>
  );
}

// ── InkUnderline ───────────────────────────────────────────────────────
const INK_PATHS = [
  "M2,7 C 30,4 70,9 110,6 C 150,3 180,8 198,6",
  "M3,6 C 40,9 80,4 120,7 C 160,9 185,5 197,7",
  "M2,8 C 25,5 60,8 100,5 C 145,3 175,8 198,5",
];

export function InkUnderline({ seed = 0 }: { seed?: number }) {
  const path = INK_PATHS[seed % INK_PATHS.length];
  return (
    <svg className="ink-svg" viewBox="0 0 200 12" preserveAspectRatio="none">
      <path d={path} />
    </svg>
  );
}
