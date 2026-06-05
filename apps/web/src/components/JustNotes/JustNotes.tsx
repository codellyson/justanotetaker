import React, {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  AMBER,
  GRID,
  INK_MS,
  PALETTES,
  WARM_MS,
  firstNonEmpty,
  recencyOf,
  restAfterFirst,
  uid,
  type Note,
  type Palette,
  type Tweaks,
} from "./lib";
import { renderBody, renderHeadline } from "./markdown";
import { AmbientBar, Compass, InkUnderline, TimeScrub } from "./cherries";
import { TweaksUI } from "./tweaks";
import { remoteStorage } from "../../lib/storage";

type Persist = {
  onCreate: (note: Note) => void | Promise<void>;
  onUpdate: (id: string, patch: Partial<Pick<Note, "x" | "y" | "t" | "text">>) => void;
  onDelete: (id: string) => void;
};

export type JustNotesProps = Persist & {
  initialNotes: Note[];
  tweaks: Tweaks;
  setTweak: <K extends keyof Tweaks>(key: K, val: Tweaks[K]) => void;
};

type View = { pan: { x: number; y: number }; zoom: number };

type UndoOp =
  | { type: "create"; id: string }
  | { type: "edit"; id: string; prevText: string; prevT: number }
  | { type: "delete"; note: Note }
  | { type: "move"; id: string; prevX: number; prevY: number };

// ── App ────────────────────────────────────────────────────────────────
export default function JustNotes(props: JustNotesProps) {
  const { initialNotes, tweaks: t, setTweak, onCreate, onUpdate, onDelete } = props;
  const [tweaksOpen, setTweaksOpen] = useState(false);

  const [notes, setNotes] = useState<Note[]>(initialNotes);
  const notesRef = useRef(notes);
  useEffect(() => { notesRef.current = notes; }, [notes]);

  const [view, setView] = useState<View>({ pan: { x: 0, y: 0 }, zoom: 1 });
  const viewRef = useRef(view);
  useEffect(() => { viewRef.current = view; }, [view]);
  const [smooth, setSmooth] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [glowingId, setGlowingId] = useState<string | null>(null);
  const [savedTickId, setSavedTickId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [inkId, setInkId] = useState<string | null>(null);
  const [inkSeed, setInkSeed] = useState(0);

  const [ambientOpen, setAmbientOpen] = useState(false);
  const [recallQuery, setRecallQuery] = useState("");
  const [recallIdx, setRecallIdx] = useState(0);

  const [scrubMoment, setScrubMoment] = useState<number | null>(null);

  const warmRef = useRef(new Map<string, number>());
  const [, setWarmTick] = useState(0);

  const [helpOpen, setHelpOpen] = useState(false);
  const [interacted, setInteracted] = useState(false);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const historyRef = useRef<UndoOp[]>([]);
  const editSnapshotRef = useRef<{ id: string; isNew: boolean; prevText: string; prevT: number } | null>(null);
  const prevViewRef = useRef<View | null>(null);
  const tweakRef = useRef<Tweaks>(t);
  useEffect(() => { tweakRef.current = t; }, [t]);

  // Center the canvas around the seed cluster on first paint.
  useEffect(() => {
    if (!canvasRef.current) return;
    const r = canvasRef.current.getBoundingClientRect();
    setView({ pan: { x: r.width / 2, y: r.height / 2 - 40 }, zoom: 1 });
  }, []);

  // Warm-trail tick
  useEffect(() => {
    const id = window.setInterval(() => {
      const m = warmRef.current;
      const now = Date.now();
      let any = false;
      for (const [k, exp] of m) {
        if (exp <= now) m.delete(k);
        else any = true;
      }
      if (any) setWarmTick((x) => x + 1);
    }, 4000);
    return () => clearInterval(id);
  }, []);

  function markWarm(id: string) {
    warmRef.current.set(id, Date.now() + WARM_MS);
    setWarmTick((x) => x + 1);
  }

  const markInteracted = () => { if (!interacted) setInteracted(true); };

  function animateView(next: View) {
    setSmooth(true);
    setView(next);
    window.setTimeout(() => setSmooth(false), 400);
  }

  function screenToCanvas(sx: number, sy: number, v: View = viewRef.current) {
    return { x: (sx - v.pan.x) / v.zoom, y: (sy - v.pan.y) / v.zoom };
  }
  function snap(v: number) {
    return Math.round(v / GRID) * GRID;
  }

  function pushOp(op: UndoOp) {
    historyRef.current.push(op);
    if (historyRef.current.length > 80) historyRef.current.shift();
  }
  function undo() {
    const op = historyRef.current.pop();
    if (!op) return;
    if (op.type === "create") setNotes((ns) => ns.filter((n) => n.id !== op.id));
    else if (op.type === "edit") setNotes((ns) => ns.map((n) => n.id === op.id ? { ...n, text: op.prevText, t: op.prevT } : n));
    else if (op.type === "delete") setNotes((ns) => [...ns, op.note]);
    else if (op.type === "move") setNotes((ns) => ns.map((n) => n.id === op.id ? { ...n, x: op.prevX, y: op.prevY } : n));
  }

  function spawnAt(canvasX: number, canvasY: number, initialText = "") {
    const id = uid();
    const w = tweakRef.current.noteWidth;
    const x = canvasX - w / 2;
    const y = canvasY - 22;
    setNotes((ns) => [...ns, { id, x, y, t: Date.now(), text: initialText }]);
    editSnapshotRef.current = { id, isNew: true, prevText: "", prevT: Date.now() };
    setEditingId(id);
  }

  function spawnAtCenter(initialText = "") {
    let v = viewRef.current;
    const W = window.innerWidth, H = window.innerHeight;
    if (v.zoom < 0.95) {
      v = { pan: { x: W / 2, y: H / 2 }, zoom: 1 };
      animateView(v);
      prevViewRef.current = null;
    }
    const c = { x: (W / 2 - v.pan.x) / v.zoom, y: (H / 2 - v.pan.y) / v.zoom };
    spawnAt(c.x, c.y, initialText);
  }

  function startEditingExisting(id: string) {
    if (editingId === id) return;
    if (editingId) commitEditing();
    const n = notesRef.current.find((x) => x.id === id);
    if (!n) return;
    editSnapshotRef.current = { id, isNew: false, prevText: n.text, prevT: n.t };
    setEditingId(id);
  }

  function commitEditing() {
    const id = editingId;
    if (!id) return;
    const snap = editSnapshotRef.current;
    const cur = notesRef.current.find((n) => n.id === id);
    const isEmpty = !cur || !cur.text.trim();

    if (isEmpty) {
      if (cur && snap && !snap.isNew) pushOp({ type: "delete", note: { ...cur } });
      setNotes((ns) => ns.filter((n) => n.id !== id));
      // Empty-commit on a previously-synced note → soft-delete on server.
      // No-op if never synced (spawned then never given text).
      if (!snap?.isNew) onDelete(id);
    } else {
      const now = Date.now();
      if (snap?.isNew) pushOp({ type: "create", id });
      else if (snap && (snap.prevText !== cur.text)) pushOp({ type: "edit", id, prevText: snap.prevText, prevT: snap.prevT });
      setNotes((ns) => ns.map((n) => n.id === id ? { ...n, t: now } : n));
      // First commit on a new note → persist create. Subsequent edits → patch.
      if (snap?.isNew) {
        void onCreate({ ...cur, t: now });
      } else {
        onUpdate(id, { text: cur.text, t: now });
      }
      if (tweakRef.current.glow) {
        setGlowingId(id);
        setSavedTickId(id);
        window.setTimeout(() => setGlowingId((g) => g === id ? null : g), 720);
        window.setTimeout(() => setSavedTickId((s) => s === id ? null : s), 1100);
      }
      if (tweakRef.current.ink) {
        setInkSeed((s) => s + 1);
        setInkId(id);
        window.setTimeout(() => setInkId((s) => s === id ? null : s), INK_MS + 200);
      }
      if (tweakRef.current.warmTrail) markWarm(id);
    }
    setEditingId(null);
    editSnapshotRef.current = null;
  }

  function updateNoteText(id: string, text: string) {
    setNotes((ns) => ns.map((n) => n.id === id ? { ...n, text } : n));
  }

  function frameNotes(list: Note[]) {
    if (!list.length) return;
    const W = window.innerWidth, H = window.innerHeight;
    const NW = tweakRef.current.noteWidth, NH = 150;
    let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    for (const n of list) {
      xmin = Math.min(xmin, n.x);
      ymin = Math.min(ymin, n.y);
      xmax = Math.max(xmax, n.x + NW);
      ymax = Math.max(ymax, n.y + NH);
    }
    const padX = 160, padY = 180;
    const bw = Math.max(1, xmax - xmin);
    const bh = Math.max(1, ymax - ymin);
    const zoom = Math.max(0.32, Math.min(1, Math.min((W - padX * 2) / bw, (H - padY * 2) / bh)));
    const cx = (xmin + xmax) / 2, cy = (ymin + ymax) / 2;
    const pan = { x: W / 2 - cx * zoom, y: H / 2 - cy * zoom };
    animateView({ pan, zoom });
  }
  function panToNote(n: Note) {
    const v = viewRef.current;
    const NW = tweakRef.current.noteWidth;
    const cx = n.x + NW / 2, cy = n.y + 60;
    const pan = { x: window.innerWidth / 2 - cx * v.zoom, y: window.innerHeight / 2 - cy * v.zoom };
    animateView({ pan, zoom: v.zoom });
  }
  function toggleOverview() {
    const v = viewRef.current;
    if (v.zoom < 0.95 && prevViewRef.current) {
      animateView(prevViewRef.current);
      prevViewRef.current = null;
    } else {
      prevViewRef.current = v;
      frameNotes(notesRef.current);
    }
  }
  function flyTo(n: Note) {
    const W = window.innerWidth, H = window.innerHeight;
    const cx = n.x + tweakRef.current.noteWidth / 2, cy = n.y + 60;
    animateView({ pan: { x: W / 2 - cx, y: H / 2 - cy }, zoom: 1 });
    prevViewRef.current = null;
  }
  function flyHome() {
    const list = notesRef.current;
    if (!list.length) return;
    let sx = 0, sy = 0;
    for (const n of list) { sx += n.x; sy += n.y; }
    const cx = sx / list.length + tweakRef.current.noteWidth / 2;
    const cy = sy / list.length + 60;
    const W = window.innerWidth, H = window.innerHeight;
    animateView({ pan: { x: W / 2 - cx, y: H / 2 - cy }, zoom: 1 });
    prevViewRef.current = null;
  }

  const onCanvasMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (!target.dataset.canvas) return;
    e.preventDefault();
    markInteracted();
    const startSX = e.clientX, startSY = e.clientY;
    const startPan = { ...viewRef.current.pan };
    let moved = false;
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startSX, dy = ev.clientY - startSY;
      if (!moved && dx * dx + dy * dy > 9) moved = true;
      if (moved) setView((v) => ({ ...v, pan: { x: startPan.x + dx, y: startPan.y + dy } }));
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (moved) return;
      if (viewRef.current.zoom < 0.95) {
        if (prevViewRef.current) { animateView(prevViewRef.current); prevViewRef.current = null; }
        return;
      }
      if (editingId) { commitEditing(); return; }
      if (ambientOpen) { closeAmbient(); return; }
      const c = screenToCanvas(ev.clientX, ev.clientY);
      spawnAt(c.x, c.y);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId, ambientOpen]);

  const onNoteMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>, id: string) => {
    if (e.button !== 0) return;
    if (editingId === id) return;
    e.stopPropagation();
    markInteracted();
    if (viewRef.current.zoom < 0.95) {
      const n = notesRef.current.find((x) => x.id === id);
      if (n) flyTo(n);
      return;
    }
    const note = notesRef.current.find((n) => n.id === id);
    if (!note) return;
    const startSX = e.clientX, startSY = e.clientY;
    const startX = note.x, startY = note.y;
    let moved = false;
    setDraggingId(id);

    const onMove = (ev: MouseEvent) => {
      const dxs = ev.clientX - startSX, dys = ev.clientY - startSY;
      if (!moved && dxs * dxs + dys * dys > 9) moved = true;
      if (!moved) return;
      const z = viewRef.current.zoom;
      const rawX = startX + dxs / z, rawY = startY + dys / z;
      const useSnap = tweakRef.current.snap && !ev.shiftKey;
      const nx = useSnap ? snap(rawX) : rawX;
      const ny = useSnap ? snap(rawY) : rawY;
      setNotes((ns) => ns.map((n) => n.id === id ? { ...n, x: nx, y: ny } : n));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setDraggingId(null);
      if (!moved) {
        if (editingId && editingId !== id) commitEditing();
        if (ambientOpen) closeAmbient();
        startEditingExisting(id);
      } else {
        pushOp({ type: "move", id, prevX: startX, prevY: startY });
        if (tweakRef.current.warmTrail) markWarm(id);
        const cur = notesRef.current.find((n) => n.id === id);
        if (cur) onUpdate(id, { x: cur.x, y: cur.y });
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId, ambientOpen]);

  // ── Ambient recall matches (server-side FTS5) ──────────────────────
  // Phase 2: debounced storage.search() replaces the in-memory filter.
  // Local fallback for the just-opened state means the first keystroke
  // still feels instant — server result arrives ~80ms later and replaces
  // the fallback. Pending searches are cancelled on every new keystroke.
  const [matchIds, setMatchIds] = useState<string[] | null>(null);
  useEffect(() => {
    if (!ambientOpen) { setMatchIds(null); return; }
    const q = recallQuery.trim();
    if (!q) { setMatchIds(null); return; }

    // Optimistic local filter so matches appear immediately while the
    // server query is in flight. Server result wins when it arrives.
    const lower = q.toLowerCase();
    setMatchIds(notesRef.current.filter((n) => n.text.toLowerCase().includes(lower)).map((n) => n.id));

    const ac = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const matches = await remoteStorage.search(q, { limit: 100, signal: ac.signal });
        setMatchIds(matches.map((m) => m.id));
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          console.error("[ambient] search failed", err);
        }
      }
    }, 80);

    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [recallQuery, ambientOpen]);
  const matchSet = useMemo(() => (matchIds ? new Set(matchIds) : null), [matchIds]);

  const prevMatchCountRef = useRef(0);
  useEffect(() => {
    if (!ambientOpen) { prevMatchCountRef.current = 0; return; }
    const cnt = matchIds?.length || 0;
    if (cnt > 0 && prevMatchCountRef.current === 0) {
      const matched = notesRef.current.filter((n) => matchIds!.includes(n.id));
      frameNotes(matched);
      setRecallIdx(0);
    }
    if (cnt === 0) setRecallIdx(0);
    prevMatchCountRef.current = cnt;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchIds, ambientOpen]);

  function stepMatch(delta: number) {
    if (!matchIds || matchIds.length === 0) return;
    const next = (recallIdx + delta + matchIds.length) % matchIds.length;
    setRecallIdx(next);
    const n = notesRef.current.find((x) => x.id === matchIds[next]);
    if (n) panToNote(n);
  }

  function openAmbient(initial = "") {
    setAmbientOpen(true);
    setRecallQuery(initial);
    setRecallIdx(0);
  }
  function closeAmbient() {
    setAmbientOpen(false);
    setRecallQuery("");
    setRecallIdx(0);
  }
  function commitAmbient(forceSpawn = false) {
    const q = recallQuery.trim();
    const hasMatches = matchIds && matchIds.length > 0;
    const idxNow = recallIdx;
    const matchesNow = matchIds;
    closeAmbient();
    if (!forceSpawn && hasMatches) {
      const n = notesRef.current.find((x) => x.id === matchesNow![idxNow]);
      if (n) flyTo(n);
    } else if (q) {
      spawnAtCenter(q);
    }
  }

  // ── Global keyboard ────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isInput = !!target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT");

      if (e.key === "Escape") {
        if (tweaksOpen) { setTweaksOpen(false); return; }
        if (helpOpen) { setHelpOpen(false); return; }
        if (ambientOpen) { closeAmbient(); return; }
        if (editingId) { commitEditing(); return; }
        if (viewRef.current.zoom < 0.95 && prevViewRef.current) {
          animateView(prevViewRef.current); prevViewRef.current = null; return;
        }
      }

      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        if (editingId) { e.preventDefault(); commitEditing(); return; }
        if (ambientOpen) { e.preventDefault(); commitAmbient(true); return; }
      }

      if (!isInput && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }

      // ⌘, — toggle tweaks panel
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setTweaksOpen((o) => !o);
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (editingId) commitEditing();
        if (!ambientOpen) openAmbient("");
        markInteracted();
        return;
      }

      if (isInput) return;

      if (e.key === "?") { e.preventDefault(); setHelpOpen((h) => !h); return; }

      if (ambientOpen) {
        if (e.key === "Enter") { e.preventDefault(); commitAmbient(false); return; }
        if (e.key === "ArrowDown") { e.preventDefault(); stepMatch(1); return; }
        if (e.key === "ArrowUp")   { e.preventDefault(); stepMatch(-1); return; }
        if (e.key === "Backspace") {
          e.preventDefault();
          if (!recallQuery) { closeAmbient(); return; }
          setRecallQuery((q) => q.slice(0, -1));
          return;
        }
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          setRecallQuery((q) => q + e.key);
          return;
        }
        return;
      }

      if (e.key === "/") { e.preventDefault(); openAmbient(""); markInteracted(); return; }
      if (e.key === "z" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault(); toggleOverview(); return;
      }
      if (e.key === "h" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault(); flyHome(); return;
      }

      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey
          && !helpOpen && !editingId) {
        e.preventDefault();
        openAmbient(e.key);
        markInteracted();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId, ambientOpen, helpOpen, tweaksOpen, recallQuery, recallIdx, matchIds]);

  // ── Render ─────────────────────────────────────────────────────────
  const palette = PALETTES[t.palette] || PALETTES.warm;
  const inOverview = view.zoom < 0.95;

  const warmMap = useMemo(() => {
    const out = new Map<string, number>();
    const now = Date.now();
    for (const [k, exp] of warmRef.current) {
      const rem = exp - now;
      if (rem > 0) out.set(k, Math.min(1, rem / WARM_MS));
    }
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes]);

  function scrubFadeFor(n: Note) {
    if (scrubMoment == null) return 1;
    return n.t <= scrubMoment ? 1 : 0;
  }

  const rootStyle: CSSProperties = {
    ["--radius" as string]: `${t.radius}px`,
    ["--note-w" as string]: `${t.noteWidth}px`,
  };

  return (
    <div className="jn-root" style={rootStyle}>
      <Canvas
        ref={canvasRef}
        pan={view.pan}
        zoom={view.zoom}
        grid={t.grid}
        smooth={smooth}
        onMouseDown={onCanvasMouseDown}
      >
        <div
          className={"notes-layer" + (smooth ? " smooth" : "") + (inOverview ? " overview" : "")}
          style={{ transform: `translate3d(${view.pan.x}px, ${view.pan.y}px, 0) scale(${view.zoom})` }}
        >
          {notes.map((n) => (
            <NoteCard
              key={n.id}
              note={n}
              editing={editingId === n.id}
              glowing={glowingId === n.id}
              ink={inkId === n.id}
              inkSeed={inkSeed}
              warm={t.warmTrail ? (warmMap.get(n.id) || 0) : 0}
              paperAge={t.paperAge}
              showSaved={savedTickId === n.id}
              dragging={draggingId === n.id}
              palette={palette}
              bodyFont={t.bodyFont}
              dimmed={!!matchSet && !matchSet.has(n.id)}
              highlit={!!matchSet && matchSet.has(n.id)}
              focused={!!matchIds && matchIds[recallIdx] === n.id}
              hidden={editingId === n.id && t.editMode === "focused"}
              scrubFade={scrubFadeFor(n)}
              onMouseDown={(e) => onNoteMouseDown(e, n.id)}
              onTextChange={(v) => updateNoteText(n.id, v)}
            />
          ))}
        </div>
      </Canvas>

      {notes.length === 0 && <GhostCard />}

      {editingId && t.editMode === "focused" && (() => {
        const n = notes.find((x) => x.id === editingId);
        if (!n) return null;
        return (
          <FocusedEditor
            note={n}
            palette={palette}
            bodyFont={t.bodyFont}
            onTextChange={(v) => updateNoteText(n.id, v)}
            onCommit={commitEditing}
          />
        );
      })()}

      <Chrome
        count={notes.length}
        folderPath="~/Notes/2026 · iCloud Drive"
        hintVisible={!interacted}
        showRecencyKey={t.showRecencyKey}
        palette={palette}
        overviewLabel={inOverview ? "overview · z to return" : null}
      />

      {ambientOpen && (
        <AmbientBar
          query={recallQuery}
          matchCount={matchIds ? matchIds.length : null}
          recallIdx={recallIdx}
        />
      )}

      <TimeScrub
        notes={notes}
        scrubMoment={scrubMoment}
        setScrubMoment={setScrubMoment}
      />

      {t.compass && <Compass notes={notes} view={view} flyHome={flyHome} />}

      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}

      <TweaksUI t={t} setTweak={setTweak} open={tweaksOpen} onClose={() => setTweaksOpen(false)} />
    </div>
  );
}

// Suppress "AMBER unused" — kept for future-use palette tweaks.
void AMBER;

// ── Canvas ─────────────────────────────────────────────────────────────
type CanvasProps = {
  pan: { x: number; y: number };
  zoom: number;
  grid: Tweaks["grid"];
  smooth: boolean;
  onMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void;
  children: React.ReactNode;
};

const Canvas = forwardRef<HTMLDivElement, CanvasProps>(function Canvas(
  { pan, zoom, grid, smooth, onMouseDown, children },
  ref,
) {
  const gridStyle = useMemo<CSSProperties>(() => {
    const z = zoom;
    if (grid === "off") return { background: "#0a0d12" };
    if (grid === "lines") {
      const line = "rgba(255,255,255,0.035)";
      const s = 56 * z;
      return {
        backgroundColor: "#0a0d12",
        backgroundImage:
          `linear-gradient(${line} 1px, transparent 1px), ` +
          `linear-gradient(90deg, ${line} 1px, transparent 1px)`,
        backgroundSize: `${s}px ${s}px, ${s}px ${s}px`,
        backgroundPosition: `${pan.x}px ${pan.y}px, ${pan.x}px ${pan.y}px`,
        transition: smooth ? "background-size 400ms cubic-bezier(.22,.61,.36,1), background-position 400ms cubic-bezier(.22,.61,.36,1)" : "none",
      };
    }
    const s = GRID * z;
    return {
      backgroundColor: "#0a0d12",
      backgroundImage:
        "radial-gradient(circle, rgba(255,255,255,0.07) 1px, transparent 1.4px)",
      backgroundSize: `${s}px ${s}px`,
      backgroundPosition: `${pan.x}px ${pan.y}px`,
      transition: smooth ? "background-size 400ms cubic-bezier(.22,.61,.36,1), background-position 400ms cubic-bezier(.22,.61,.36,1)" : "none",
    };
  }, [pan.x, pan.y, zoom, grid, smooth]);

  return (
    <div
      ref={ref}
      className="canvas"
      data-canvas="1"
      style={gridStyle}
      onMouseDown={onMouseDown}
    >
      {children}
    </div>
  );
});

// ── NoteCard ───────────────────────────────────────────────────────────
function NoteCard({
  note, editing, glowing, ink, inkSeed, warm, paperAge, showSaved, dragging,
  palette, bodyFont, dimmed, highlit, focused, hidden, scrubFade,
  onMouseDown, onTextChange,
}: {
  note: Note;
  editing: boolean;
  glowing: boolean;
  ink: boolean;
  inkSeed: number;
  warm: number;
  paperAge: boolean;
  showSaved: boolean;
  dragging: boolean;
  palette: Palette;
  bodyFont: Tweaks["bodyFont"];
  dimmed: boolean;
  highlit: boolean;
  focused: boolean;
  hidden: boolean;
  scrubFade: number;
  onMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void;
  onTextChange: (v: string) => void;
}) {
  const rec = recencyOf(note.t);
  const p = palette[rec];
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!editing || !taRef.current) return;
    const ta = taRef.current;
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  }, [editing, note.text]);

  useEffect(() => {
    if (editing && taRef.current) {
      const ta = taRef.current;
      ta.focus();
      const len = ta.value.length;
      ta.setSelectionRange(len, len);
    }
  }, [editing]);

  const first = firstNonEmpty(note.text);
  const rest = restAfterFirst(note.text);
  const isHeading = first.trim().startsWith("#");

  const cls = [
    "note",
    `rec-${rec}`,
    editing ? "editing" : "",
    glowing ? "glow" : "",
    dragging ? "dragging" : "",
    dimmed ? "dim" : "",
    highlit ? "hit" : "",
    focused ? "focused" : "",
    hidden ? "is-hidden" : "",
    isHeading && !editing ? "has-heading" : "",
    bodyFont === "sans" ? "body-sans" : "body-serif",
    warm > 0 ? "warm" : "",
    paperAge ? "paper-age" : "",
  ].filter(Boolean).join(" ");

  const style: CSSProperties = {
    left: note.x,
    top: note.y,
    background: p.bg,
    color: p.fg,
    opacity: p.alpha * (scrubFade ?? 1),
    ["--warm" as string]: warm,
  };

  return (
    <div className={cls} style={style} onMouseDown={onMouseDown}>
      {editing ? (
        <textarea
          ref={taRef}
          className="note-ta"
          value={note.text}
          onChange={(e) => onTextChange(e.target.value)}
          onMouseDown={(e) => e.stopPropagation()}
          placeholder="just write."
          spellCheck={false}
          style={{ color: p.fg }}
        />
      ) : (
        <>
          {first
            ? <div className="note-first">{renderHeadline(first)}</div>
            : <div className="note-first" style={{ opacity: 0.35 }}>empty</div>}
          {rest && <div className="note-rest" style={{ color: p.muted }}>{renderBody(rest)}</div>}
        </>
      )}
      {!editing && ink && <InkUnderline seed={inkSeed} />}
      {showSaved && <div className="saved-tick">saved</div>}
    </div>
  );
}

// ── Chrome ─────────────────────────────────────────────────────────────
function Chrome({
  count, folderPath, hintVisible, showRecencyKey, palette, overviewLabel,
}: {
  count: number;
  folderPath: string;
  hintVisible: boolean;
  showRecencyKey: boolean;
  palette: Palette;
  overviewLabel: string | null;
}) {
  return (
    <>
      <div className="chrome chrome-tl">
        <span className="dot" />
        <span className="wordmark">justnotes</span>
      </div>
      <div className="chrome chrome-tr">
        <span className="count-num">{count}</span>
        <span className="count-lbl">notes</span>
      </div>
      <div className="chrome chrome-br">{folderPath}</div>
      <div className={"chrome chrome-bl" + (hintVisible ? "" : " faded")}>
        <span className="hint">
          <kbd>click</kbd> to write &nbsp;·&nbsp; <kbd>drag</kbd> to pan &nbsp;·&nbsp; <kbd>/</kbd> search &nbsp;·&nbsp; <kbd>z</kbd> overview &nbsp;·&nbsp; <kbd>?</kbd> help
        </span>
      </div>
      {overviewLabel && <div className="chrome chrome-mode">{overviewLabel}</div>}
      {showRecencyKey && (
        <div className="chrome chrome-key">
          {(["fresh", "recent", "older", "ancient"] as const).map((k) => (
            <span key={k} className="key-row">
              <i style={{ background: palette[k].bg, opacity: palette[k].alpha }} />
              {k}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

// ── HelpOverlay ────────────────────────────────────────────────────────
function HelpOverlay({ onClose }: { onClose: () => void }) {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  const mod = isMac ? "⌘" : "Ctrl";
  type Row = [string | string[], string];
  const rows: Row[] = [
    ["click empty canvas",         "write a new note"],
    ["type any letter",            "ambient · live-filters notes as you type"],
    [["↵"],                        "jump to match · or write a new note"],
    [[mod, "↵"],                   "always write (override match)"],
    [["↑↓"],                       "step through matches"],
    [["/"],                        "open ambient with empty query"],
    [[mod, "K"],                   "open ambient with empty query"],
    ["drag a note",                "reposition · snaps to grid"],
    [["shift", "drag a note"],     "ignore the grid"],
    ["drag empty canvas",          "pan"],
    ["drag the right edge",        "rewind canvas through time"],
    [["z"],                        "zoom out · overview"],
    [["click a note in overview"], "fly to it"],
    [["h"],                        "fly home · re-center on cluster"],
    [[mod, "Z"],                   "undo last commit / move / delete"],
    [[mod, ","],                   "toggle tweaks panel"],
    [["esc"],                      "close · exit · back"],
    [["?"],                        "this"],
  ];
  return (
    <div
      className="help-shroud"
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).classList.contains("help-shroud")) onClose();
      }}
    >
      <div className="help-card">
        <div className="help-hd">
          <span>gestures</span>
          <button className="help-x" onClick={onClose} aria-label="close help">✕</button>
        </div>
        <dl className="help-list">
          {rows.map(([k, v], i) => {
            const keys = Array.isArray(k) ? k : [k];
            return (
              <div key={i} className="help-row">
                <dt>{keys.map((key, j) => (
                  <React.Fragment key={j}>
                    {j > 0 && <span className="help-plus">+</span>}
                    <kbd>{key}</kbd>
                  </React.Fragment>
                ))}</dt>
                <dd>{v}</dd>
              </div>
            );
          })}
        </dl>
        <div className="help-foot">
          one markdown file per note. position lives in frontmatter. <br />
          sync = whatever your folder is synced with.
        </div>
      </div>
    </div>
  );
}

// ── FocusedEditor ──────────────────────────────────────────────────────
function FocusedEditor({
  note, palette, bodyFont, onTextChange, onCommit,
}: {
  note: Note;
  palette: Palette;
  bodyFont: Tweaks["bodyFont"];
  onTextChange: (v: string) => void;
  onCommit: () => void;
}) {
  const p = palette[recencyOf(note.t)];
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, []);
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 0.6 * window.innerHeight) + "px";
  }, [note.text]);
  return (
    <div
      className="focus-shroud"
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).classList.contains("focus-shroud")) onCommit();
      }}
    >
      <div
        className={"focus-note " + (bodyFont === "sans" ? "body-sans" : "body-serif")}
        style={{ background: p.bg, color: p.fg, opacity: p.alpha }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <textarea
          ref={taRef}
          className="focus-ta"
          value={note.text}
          onChange={(e) => onTextChange(e.target.value)}
          placeholder="just write."
          spellCheck={false}
          style={{ color: p.fg }}
        />
        <div className="focus-meta">
          <span className="focus-meta-time">{recencyOf(note.t)}</span>
          <span className="focus-meta-keys">
            <kbd>⌘</kbd><kbd>↵</kbd> commit &nbsp; · &nbsp; <kbd>esc</kbd> done
          </span>
        </div>
      </div>
    </div>
  );
}

// ── GhostCard ──────────────────────────────────────────────────────────
function GhostCard() {
  return (
    <div className="ghost">
      <div className="ghost-card">
        <div className="ghost-line" />
        <div className="ghost-line short" />
        <div className="ghost-line tiny" />
      </div>
      <div className="ghost-text">click anywhere to write</div>
    </div>
  );
}
