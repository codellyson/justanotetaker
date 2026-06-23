import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { useTheme } from "@codellyson/justui/react";
import type { Tweaks } from "./lib";
import { isTauri } from "../../lib/runtime";

const TWEAKS_STYLE = `
  .twk-panel{position:fixed;right:16px;bottom:16px;z-index:2147483646;width:280px;
    max-height:calc(100vh - 32px);display:flex;flex-direction:column;
    background:rgb(var(--bg-secondary) / 0.92);color:rgb(var(--text-primary));
    -webkit-backdrop-filter:blur(24px) saturate(160%);backdrop-filter:blur(24px) saturate(160%);
    border:.5px solid rgb(var(--border) / 0.7);border-radius:14px;
    box-shadow:0 12px 40px rgba(0,0,0,.25);
    font:11.5px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif;overflow:hidden}
  .twk-hd{display:flex;align-items:center;justify-content:space-between;
    padding:10px 8px 10px 14px;cursor:move;user-select:none}
  .twk-hd b{font-size:12px;font-weight:600;letter-spacing:.01em}
  .twk-x{appearance:none;border:0;background:transparent;color:rgb(var(--text-secondary));
    width:22px;height:22px;border-radius:6px;cursor:default;font-size:13px;line-height:1}
  .twk-x:hover{background:rgb(var(--accent) / .14);color:rgb(var(--text-primary))}
  .twk-body{padding:2px 14px 14px;display:flex;flex-direction:column;gap:10px;
    overflow-y:auto;overflow-x:hidden;min-height:0;
    scrollbar-width:thin;scrollbar-color:rgb(var(--border) / .7) transparent}
  .twk-body::-webkit-scrollbar{width:8px}
  .twk-body::-webkit-scrollbar-track{background:transparent;margin:2px}
  .twk-body::-webkit-scrollbar-thumb{background:rgb(var(--border) / .7);border-radius:4px;
    border:2px solid transparent;background-clip:content-box}
  .twk-body::-webkit-scrollbar-thumb:hover{background:rgb(var(--border));
    border:2px solid transparent;background-clip:content-box}
  .twk-row{display:flex;flex-direction:column;gap:5px}
  .twk-row-h{flex-direction:row;align-items:center;justify-content:space-between;gap:10px}
  .twk-lbl{display:flex;justify-content:space-between;align-items:baseline;
    color:rgb(var(--text-primary))}
  .twk-lbl>span:first-child{font-weight:500}
  .twk-val{color:rgb(var(--text-secondary));font-variant-numeric:tabular-nums}

  .twk-sect{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
    color:rgb(var(--text-secondary));padding:10px 0 0}
  .twk-sect:first-child{padding-top:0}

  .twk-slider{appearance:none;-webkit-appearance:none;width:100%;height:4px;margin:6px 0;
    border-radius:999px;background:rgb(var(--border) / .6);outline:none}
  .twk-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;
    width:14px;height:14px;border-radius:50%;background:rgb(var(--accent));
    border:.5px solid rgb(var(--border));box-shadow:0 1px 3px rgba(0,0,0,.2);cursor:default}
  .twk-slider::-moz-range-thumb{width:14px;height:14px;border-radius:50%;
    background:rgb(var(--accent));border:.5px solid rgb(var(--border));box-shadow:0 1px 3px rgba(0,0,0,.2);cursor:default}

  .twk-seg{position:relative;display:flex;padding:2px;border-radius:8px;
    background:rgb(var(--bg) / .5);user-select:none}
  .twk-seg-thumb{position:absolute;top:2px;bottom:2px;border-radius:6px;
    background:rgb(var(--bg-secondary));box-shadow:0 1px 2px rgba(0,0,0,.18);
    transition:left .15s cubic-bezier(.3,.7,.4,1),width .15s}
  .twk-seg.dragging .twk-seg-thumb{transition:none}
  .twk-seg button{appearance:none;position:relative;z-index:1;flex:1;border:0;
    background:transparent;color:inherit;font:inherit;font-weight:500;min-height:22px;
    border-radius:6px;cursor:default;padding:4px 6px;line-height:1.2;
    overflow-wrap:anywhere}

  .twk-toggle{position:relative;width:32px;height:18px;border:0;border-radius:999px;
    background:rgb(var(--border) / .8);transition:background .15s;cursor:default;padding:0}
  .twk-toggle[data-on="1"]{background:rgb(var(--accent))}
  .twk-toggle i{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;
    background:rgb(var(--bg-secondary));box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}
  .twk-toggle[data-on="1"] i{transform:translateX(14px)}

  .twk-hint{font-size:10px;color:rgb(var(--text-secondary));padding:4px 0 0;text-align:center}
  .twk-hint kbd{font-family:ui-monospace,monospace;font-size:9.5px;padding:1px 5px;
    border-radius:3px;background:rgb(var(--bg) / .5);color:rgb(var(--text-primary));margin:0 1px}

  .twk-theme-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px}
  .twk-theme-chip{appearance:none;border:1px solid rgb(var(--border) / .6);
    background:rgb(var(--bg) / .4);color:rgb(var(--text-primary));
    font:inherit;font-weight:500;padding:5px 8px;border-radius:6px;
    cursor:default;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .twk-theme-chip:hover{background:rgb(var(--accent) / .14)}
  .twk-theme-chip.active{border-color:rgb(var(--accent));
    background:rgb(var(--accent) / .18);box-shadow:inset 0 0 0 1px rgb(var(--accent) / .4)}
`;

// ── useTweaks ────────────────────────────────────────────────────────
export function useTweaks(defaults: Tweaks) {
  const [values, setValues] = useState<Tweaks>(defaults);
  const setTweak = useCallback(<K extends keyof Tweaks>(key: K, val: Tweaks[K]) => {
    setValues((prev) => ({ ...prev, [key]: val }));
  }, []);
  return [values, setTweak] as const;
}

// ── TweaksPanel shell ────────────────────────────────────────────────
export function TweaksPanel({
  open,
  onClose,
  title = "Tweaks",
  children,
}: PropsWithChildren<{ open: boolean; onClose: () => void; title?: string }>) {
  const dragRef = useRef<HTMLDivElement | null>(null);
  const [offset, setOffset] = useState({ x: 16, y: 16 });
  const PAD = 16;

  const clampToViewport = useCallback(() => {
    const panel = dragRef.current;
    if (!panel) return;
    const w = panel.offsetWidth, h = panel.offsetHeight;
    const maxRight = Math.max(PAD, window.innerWidth - w - PAD);
    const maxBottom = Math.max(PAD, window.innerHeight - h - PAD);
    setOffset((cur) => ({
      x: Math.min(maxRight, Math.max(PAD, cur.x)),
      y: Math.min(maxBottom, Math.max(PAD, cur.y)),
    }));
  }, []);

  useEffect(() => {
    if (!open) return;
    clampToViewport();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", clampToViewport);
      return () => window.removeEventListener("resize", clampToViewport);
    }
    const ro = new ResizeObserver(clampToViewport);
    ro.observe(document.documentElement);
    return () => ro.disconnect();
  }, [open, clampToViewport]);

  const onDragStart = (e: React.MouseEvent<HTMLDivElement>) => {
    const panel = dragRef.current;
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    const startRight = window.innerWidth - r.right;
    const startBottom = window.innerHeight - r.bottom;
    const move = (ev: MouseEvent) => {
      const w = panel.offsetWidth, h = panel.offsetHeight;
      const maxRight = Math.max(PAD, window.innerWidth - w - PAD);
      const maxBottom = Math.max(PAD, window.innerHeight - h - PAD);
      const rawX = startRight - (ev.clientX - sx);
      const rawY = startBottom - (ev.clientY - sy);
      setOffset({
        x: Math.min(maxRight, Math.max(PAD, rawX)),
        y: Math.min(maxBottom, Math.max(PAD, rawY)),
      });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  if (!open) return null;
  return (
    <>
      <style>{TWEAKS_STYLE}</style>
      <div
        ref={dragRef}
        className="twk-panel"
        style={{ right: offset.x, bottom: offset.y }}
      >
        <div className="twk-hd" onMouseDown={onDragStart}>
          <b>{title}</b>
          <button
            className="twk-x"
            aria-label="Close tweaks"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="twk-body">{children}</div>
      </div>
    </>
  );
}

// ── Layout helpers ──────────────────────────────────────────────────
export function TweakSection({ label }: { label: string }) {
  return <div className="twk-sect">{label}</div>;
}

function TweakRow({
  label,
  value,
  children,
}: PropsWithChildren<{ label: string; value?: string | number | null }>) {
  return (
    <div className="twk-row">
      <div className="twk-lbl">
        <span>{label}</span>
        {value != null && <span className="twk-val">{value}</span>}
      </div>
      {children}
    </div>
  );
}

// ── Controls ─────────────────────────────────────────────────────────
export function TweakSlider({
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  unit = "",
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  onChange: (v: number) => void;
}) {
  return (
    <TweakRow label={label} value={`${value}${unit}`}>
      <input
        type="range"
        className="twk-slider"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </TweakRow>
  );
}

export function TweakToggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="twk-row twk-row-h">
      <div className="twk-lbl">
        <span>{label}</span>
      </div>
      <button
        type="button"
        className="twk-toggle"
        data-on={value ? "1" : "0"}
        role="switch"
        aria-checked={!!value}
        onClick={() => onChange(!value)}
      >
        <i />
      </button>
    </div>
  );
}

export function TweakRadio<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const valueRef = useRef(value);
  useEffect(() => { valueRef.current = value; }, [value]);

  const idx = Math.max(0, options.indexOf(value));
  const n = options.length;

  const segAt = (clientX: number): T => {
    if (!trackRef.current) return value;
    const r = trackRef.current.getBoundingClientRect();
    const inner = r.width - 4;
    const i = Math.floor(((clientX - r.left - 2) / inner) * n);
    return options[Math.max(0, Math.min(n - 1, i))];
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    setDragging(true);
    const v0 = segAt(e.clientX);
    if (v0 !== valueRef.current) onChange(v0);
    const move = (ev: PointerEvent) => {
      const v = segAt(ev.clientX);
      if (v !== valueRef.current) onChange(v);
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <TweakRow label={label}>
      <div
        ref={trackRef}
        role="radiogroup"
        onPointerDown={onPointerDown}
        className={dragging ? "twk-seg dragging" : "twk-seg"}
      >
        <div
          className="twk-seg-thumb"
          style={{
            left: `calc(2px + ${idx} * (100% - 4px) / ${n})`,
            width: `calc((100% - 4px) / ${n})`,
          }}
        />
        {options.map((o) => (
          <button key={o} type="button" role="radio" aria-checked={o === value}>
            {o}
          </button>
        ))}
      </div>
    </TweakRow>
  );
}

// ── TweaksUI — the JustNotes-specific tweak set ─────────────────────
export function TweaksUI({
  t,
  setTweak,
  open,
  onClose,
}: {
  t: Tweaks;
  setTweak: <K extends keyof Tweaks>(key: K, val: Tweaks[K]) => void;
  open: boolean;
  onClose: () => void;
}) {
  const { mode, themes, themeId, setThemeId, toggleMode } = useTheme();
  return (
    <TweaksPanel open={open} onClose={onClose} title="Tweaks">
      <TweakSection label="Theme" />
      <TweakToggle label="Dark mode" value={mode === "dark"} onChange={toggleMode} />
      <TweakRow label="Palette">
        <div className="twk-theme-grid">
          {themes.map((th) => (
            <button
              key={th.id}
              type="button"
              className={"twk-theme-chip" + (th.id === themeId ? " active" : "")}
              onClick={() => setThemeId(th.id)}
              title={th.description}
            >
              {th.label}
            </button>
          ))}
        </div>
      </TweakRow>

      <TweakSection label="Canvas" />
      <TweakRadio
        label="Grid"
        value={t.grid}
        options={["dots", "lines", "off"] as const}
        onChange={(v) => setTweak("grid", v)}
      />
      <TweakToggle label="Snap to grid" value={t.snap} onChange={(v) => setTweak("snap", v)} />
      <TweakRadio
        label="Edit"
        value={t.editMode}
        options={["in place", "focused"] as const}
        onChange={(v) => setTweak("editMode", v)}
      />

      <TweakSection label="Paper" />
      {/* Tone + Body removed in the v2 design — color comes from the
          active JustUI theme (palette swatch in the bottom-right) and
          all body text is Geist. */}
      <TweakSlider
        label="Corner"
        value={t.radius}
        min={0}
        max={14}
        step={1}
        unit="px"
        onChange={(v) => setTweak("radius", v)}
      />
      <TweakSlider
        label="Width"
        value={t.noteWidth}
        min={160}
        max={320}
        step={4}
        unit="px"
        onChange={(v) => setTweak("noteWidth", v)}
      />

      <TweakSection label="Feedback" />
      <TweakToggle label="Compass" value={t.compass} onChange={(v) => setTweak("compass", v)} />

      {isTauri && (
        <>
          <TweakSection label="Clipboard" />
          <TweakToggle
            label="Auto-capture"
            value={t.clipboardCapture}
            onChange={(v) => setTweak("clipboardCapture", v)}
          />
          {t.clipboardCapture && (
            <TweakToggle
              label="Sync captures to cloud"
              value={t.clipboardSyncToCloud}
              onChange={(v) => setTweak("clipboardSyncToCloud", v)}
            />
          )}
        </>
      )}

      <div className="twk-hint">
        <kbd>⌘</kbd><kbd>,</kbd> to toggle
      </div>
    </TweaksPanel>
  );
}
