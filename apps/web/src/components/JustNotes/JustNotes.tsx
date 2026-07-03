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
  GRID,
  RECENCY_ALPHA,
  firstNonEmpty,
  parsePastedUrl,
  recencyOf,
  restAfterFirst,
  tagsOf,
  uid,
  stickyColorOf,
  STICKY_SIZE,
  PAPER_W,
  PAPER_H,
  type Note,
  type ModePos,
  type Tweaks,
  type ViewMode,
} from "./lib";
import { renderBody, renderHeadline } from "./markdown";
import { formatCapturedNote } from "./clipboard";
import { clipboardOrigin } from "../../lib/clipboard-origin";
import { seedIdStore } from "../../lib/seed-ids";
import { AmbientBar, Compass, TimeScrub } from "./cherries";
import { TweaksUI } from "./tweaks";
import { remoteStorage } from "../../lib/storage";
import { authClient, clearKeychainToken } from "../../lib/auth-client";
import { API_BASE_URL, isTauri } from "../../lib/runtime";
import { AuthPanel } from "../AuthPanel";
import { filterCommands, type Command } from "../../lib/commands";
import { Graveyard } from "./Graveyard";

type Persist = {
  onCreate: (note: Note, opts?: { localOnly?: boolean }) => void | Promise<void>;
  onUpdate: (id: string, patch: Partial<Pick<Note, "x" | "y" | "w" | "h" | "t" | "text" | "modePos">>) => void;
  onDelete: (id: string) => void;
};

export type JustNotesProps = Persist & {
  initialNotes: Note[];
  seedIds: string[];
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
  const { initialNotes, seedIds, tweaks: t, setTweak, onCreate: rawOnCreate, onUpdate: rawOnUpdate, onDelete: rawOnDelete } = props;
  const [tweaksOpen, setTweaksOpen] = useState(false);

  const [notes, setNotes] = useState<Note[]>(initialNotes);
  const notesRef = useRef(notes);
  useEffect(() => { notesRef.current = notes; }, [notes]);

  const [view, setView] = useState<View>({ pan: { x: 0, y: 0 }, zoom: 1 });
  const viewRef = useRef(view);
  useEffect(() => { viewRef.current = view; }, [view]);
  const [smooth, setSmooth] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const editingIdRef = useRef<string | null>(null);
  useEffect(() => { editingIdRef.current = editingId; }, [editingId]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // A note that just glided to a free spot after a drop (drives the snap CSS).
  const [snappingId, setSnappingId] = useState<string | null>(null);

  // `layoutAnimating` gates the left/top transition to mode-switch time only,
  // so ordinary dragging never lags.
  const viewMode = t.viewMode;
  const [layoutAnimating, setLayoutAnimating] = useState(false);

  // Sticky/paper render from this ephemeral map (a declumped layout computed on
  // mode entry), NOT from the notes' real x/y — so the canvas arrangement is
  // never mutated and `default` always restores it. Dragging in a mode edits
  // this map only; nothing writes back to the notes. Empty in default mode.
  const [modePos, setModePos] = useState<Map<string, { x: number; y: number }>>(() => new Map());
  const modePosRef = useRef(modePos);
  useEffect(() => { modePosRef.current = modePos; }, [modePos]);

  const [ambientOpen, setAmbientOpen] = useState(false);
  const [recallQuery, setRecallQuery] = useState("");
  const [recallIdx, setRecallIdx] = useState(0);

  const [scrubMoment, setScrubMoment] = useState<number | null>(null);

  // Cmd+V paste doesn't carry clientX/Y; fall back to last mousemove.
  const lastMouseRef = useRef<{ x: number; y: number } | null>(null);

  const [helpOpen, setHelpOpen] = useState(false);
  const [authPanelOpen, setAuthPanelOpen] = useState(false);
  const [graveyardOpen, setGraveyardOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const selectedIdsRef = useRef<Set<string>>(new Set());

  // Relationship threads: hidden by default, toggled on (palette / "r").
  // When on, hovering a note springs threads to cards sharing a #tag.
  const [relationsOn, setRelationsOn] = useState(false);
  const relationsOnRef = useRef(false);
  useEffect(() => { relationsOnRef.current = relationsOn; }, [relationsOn]);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // No-op unless relations are on, so hovering never churns render otherwise.
  const onNoteHover = useCallback((id: string | null) => {
    if (!relationsOnRef.current) return;
    setHoveredId(id);
  }, []);
  useEffect(() => { selectedIdsRef.current = selectedIds; }, [selectedIds]);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [lastWriteAt, setLastWriteAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(0);
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);
  useEffect(() => {
    if (lastWriteAt == null) return;
    const id = window.setInterval(() => setNowTick((x) => x + 1), 5000);
    return () => window.clearInterval(id);
  }, [lastWriteAt]);
  const markWrite = useCallback(() => setLastWriteAt(Date.now()), []);

  // Ids of notes that came from a clipboard auto-capture, for the badge.
  // Seeded from localStorage so the marker survives reloads.
  const [clipboardIds, setClipboardIds] = useState<Set<string>>(() => clipboardOrigin.list());
  const markClipboardOrigin = useCallback((id: string) => {
    clipboardOrigin.add(id);
    setClipboardIds((s) => {
      const next = new Set(s);
      next.add(id);
      return next;
    });
  }, []);

  const onCreate = useCallback<Persist["onCreate"]>((note, opts) => {
    markWrite();
    return rawOnCreate(note, opts);
  }, [rawOnCreate, markWrite]);
  const onUpdate = useCallback<Persist["onUpdate"]>((id, patch) => {
    markWrite();
    rawOnUpdate(id, patch);
  }, [rawOnUpdate, markWrite]);
  const onDelete = useCallback<Persist["onDelete"]>((id) => {
    markWrite();
    clipboardOrigin.remove(id);
    setClipboardIds((s) => {
      if (!s.has(id)) return s;
      const next = new Set(s);
      next.delete(id);
      return next;
    });
    rawOnDelete(id);
  }, [rawOnDelete, markWrite]);
  const [hasGoogle, setHasGoogle] = useState(false);
  const [interacted, setInteracted] = useState(false);

  // Auth state. Better Auth's useSession is live; AuthBootstrap guarantees
  // a session exists by the time this component mounts, so session is
  // typically non-null (anonymous user). When the user signs in for real,
  // useSession re-renders and isAnonymous flips false.
  const { data: session } = authClient.useSession();
  type UserShape = { id: string; name?: string; email?: string; isAnonymous?: boolean };
  const user = (session?.user ?? null) as UserShape | null;
  const isAnonymous = !user || user.isAnonymous === true;
  const identityLabel = user?.name?.trim() || user?.email || "";

  useEffect(() => {
    // One-shot fetch of /api/me to learn whether Google is configured.
    // The endpoint also returns user, but useSession is fresher.
    let cancelled = false;
    fetch(API_BASE_URL + "/api/me", { credentials: "include" })
      .then((r) => r.json())
      .then((d: { providers?: { google?: boolean } }) => {
        if (!cancelled) setHasGoogle(!!d.providers?.google);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSignOut() {
    try {
      await authClient.signOut();
      // In Tauri the bearer token sits in OS keychain. Clear it so the
      // post-signout anonymous bootstrap mints a fresh token rather than
      // resurrecting the just-signed-out one.
      if (isTauri) await clearKeychainToken();
      // useSession transitions to null → AuthBootstrap creates a fresh
      // anonymous session → JustNotesLoader sees the new user_id and
      // remounts the Session with empty initial state. No reload needed.
    } catch (err) {
      console.error("[auth] sign out failed", err);
    }
  }

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const historyRef = useRef<UndoOp[]>([]);
  const editSnapshotRef = useRef<{ id: string; isNew: boolean; prevText: string; prevT: number } | null>(null);
  const prevViewRef = useRef<View | null>(null);
  // The view to fly back to after editing a paper page (see focusPaper).
  const focusReturnViewRef = useRef<View | null>(null);
  const tweakRef = useRef<Tweaks>(t);
  useEffect(() => { tweakRef.current = t; }, [t]);

  const prevModeRef = useRef<ViewMode>("default");

  // Center the canvas around the seed cluster on first paint.
  useEffect(() => {
    if (!canvasRef.current) return;
    const r = canvasRef.current.getBoundingClientRect();
    setView({ pan: { x: r.width / 2, y: r.height / 2 - 40 }, zoom: 1 });
  }, []);

  // Multiply zoom by `factor`, keeping the screen point (sx, sy) — relative to
  // the canvas element — fixed under the cursor.
  function zoomAt(factor: number, sx: number, sy: number) {
    const v = viewRef.current;
    const nextZoom = Math.max(0.32, Math.min(2.5, v.zoom * factor));
    const canvasX = (sx - v.pan.x) / v.zoom;
    const canvasY = (sy - v.pan.y) / v.zoom;
    setView({ pan: { x: sx - canvasX * nextZoom, y: sy - canvasY * nextZoom }, zoom: nextZoom });
  }

  // Wheel: plain = pan, ⌘/Ctrl (or mac trackpad pinch which fires ctrlKey) = zoom on cursor.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        // Normalize across input devices: line/page deltas → px, then clamp so
        // a single chunky mouse notch doesn't jump zoom levels. Small factor
        // keeps it gradual; trackpads send many small events that accumulate.
        let dy = e.deltaY;
        if (e.deltaMode === 1) dy *= 16;
        else if (e.deltaMode === 2) dy *= el.clientHeight;
        dy = Math.max(-120, Math.min(120, dy));
        zoomAt(Math.exp(-dy * 0.002), e.clientX - rect.left, e.clientY - rect.top);
      } else {
        setView((v) => ({ ...v, pan: { x: v.pan.x - e.deltaX, y: v.pan.y - e.deltaY } }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const markInteracted = () => { if (!interacted) setInteracted(true); };

  function animateView(next: View) {
    setSmooth(true);
    setView(next);
    window.setTimeout(() => setSmooth(false), 400);
  }

  // Build the display-only layout for `mode`, seeded with positions to keep
  // fixed (`seed`). Order: (1) keep seeded positions, (2) pin each note's own
  // persisted `modePos`, (3) declump every remaining note into its nearest
  // free spot avoiding all the above. So kept/pinned cards never move and
  // newcomers can't overlap them. Reads notesRef; mutates nothing.
  function buildModeLayout(
    mode: "sticky" | "paper",
    seed?: Map<string, { x: number; y: number }>,
  ): Map<string, { x: number; y: number }> {
    const w = mode === "sticky" ? STICKY_SIZE : PAPER_W;
    const h = mode === "sticky" ? STICKY_SIZE : PAPER_H;
    const list = notesRef.current;
    const ids = new Set(list.map((n) => n.id));
    const map = new Map<string, { x: number; y: number }>(
      seed ? [...seed].filter(([id]) => ids.has(id)) : [], // drop deleted notes
    );
    const placed = [...map.values()].map((p) => ({ x: p.x, y: p.y, w, h }));
    for (const n of list) {
      if (map.has(n.id)) continue;
      const s = n.modePos?.[mode];
      if (s) { map.set(n.id, s); placed.push({ x: s.x, y: s.y, w, h }); }
    }
    for (const n of [...list].sort((a, b) => a.y - b.y || a.x - b.x)) {
      if (map.has(n.id)) continue;
      const spot = resolveFreePosition(n.x, n.y, w, h, placed);
      map.set(n.id, spot);
      placed.push({ x: spot.x, y: spot.y, w, h });
    }
    return map;
  }

  // On a mode change: pulse the glide transition and (re)build the layout.
  // Default clears it, so cards fall back to their real x/y (the canvas).
  useEffect(() => {
    if (prevModeRef.current === viewMode) return;
    prevModeRef.current = viewMode;
    setLayoutAnimating(true);
    const stop = window.setTimeout(() => setLayoutAnimating(false), 620);
    setModePos(viewMode === "default" ? new Map() : buildModeLayout(viewMode));
    return () => window.clearTimeout(stop);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode]);

  // Keep the layout covering every note while in a mode: notes created or
  // loaded after entry get a declumped slot (avoiding the placed ones), and
  // deleted notes are dropped — without disturbing existing positions, so no
  // reflow. No-op when nothing's missing (e.g. during a drag).
  useEffect(() => {
    if (viewMode === "default") return;
    setModePos((prev) => {
      const complete = notes.length === prev.size && notes.every((n) => prev.has(n.id));
      return complete ? prev : buildModeLayout(viewMode, prev);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes, viewMode]);

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
    const spot = findFreeSpot(canvasX - w / 2, canvasY - 22);
    setNotes((ns) => [...ns, { id, x: spot.x, y: spot.y, w: null, h: null, t: Date.now(), text: initialText, modePos: null }]);
    editSnapshotRef.current = { id, isNew: true, prevText: "", prevT: Date.now() };
    setEditingId(id);
  }

  // Rects of every note but `excludeId`, for collision resolution on drop /
  // spawn. Position is where the card actually sits — the mode map in a mode,
  // else the note's real x/y — with size measured from the DOM.
  function measureRects(excludeId?: string) {
    const layer = canvasRef.current?.querySelector(".notes-layer");
    const managed = tweakRef.current.viewMode !== "default";
    const mp = modePosRef.current;
    const rects: { x: number; y: number; w: number; h: number }[] = [];
    for (const n of notesRef.current) {
      if (n.id === excludeId) continue;
      const el = layer?.querySelector<HTMLElement>(`[data-note-id="${n.id}"]`);
      const p = managed ? mp.get(n.id) ?? { x: n.x, y: n.y } : { x: n.x, y: n.y };
      rects.push({
        x: p.x,
        y: p.y,
        w: el?.offsetWidth ?? n.w ?? tweakRef.current.noteWidth,
        h: el?.offsetHeight ?? n.h ?? 96,
      });
    }
    return rects;
  }

  // Nearest position around (x,y) where a w×h card clears `others`; spirals
  // outward on the grid, returns (x,y) unchanged if already free.
  function resolveFreePosition(
    x: number, y: number, w: number, h: number,
    others: { x: number; y: number; w: number; h: number }[],
  ): { x: number; y: number } {
    const GAP = 14;
    const clears = (cx: number, cy: number) =>
      !others.some(
        (r) =>
          cx < r.x + r.w + GAP && cx + w + GAP > r.x &&
          cy < r.y + r.h + GAP && cy + h + GAP > r.y,
      );
    if (clears(x, y)) return { x, y };
    const step = tweakRef.current.snap ? GRID : 20;
    for (let ring = 1; ring <= 80; ring++) {
      let best: { x: number; y: number } | null = null;
      let bestD = Infinity;
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const cx = x + dx * step, cy = y + dy * step;
          if (!clears(cx, cy)) continue;
          const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; best = { x: cx, y: cy }; }
        }
      }
      if (best) return best;
    }
    return { x, y };
  }

  // Where a freshly-spawned card should land: near (x,y) but not overlapping.
  function findFreeSpot(x: number, y: number): { x: number; y: number } {
    return resolveFreePosition(x, y, tweakRef.current.noteWidth, 84, measureRects());
  }

  function spawnCommitted(canvasX: number, canvasY: number, text: string, opts?: { localOnly?: boolean }): string {
    const id = uid();
    const w = tweakRef.current.noteWidth;
    const spot = findFreeSpot(canvasX - w / 2, canvasY - 22);
    const x = spot.x;
    const y = spot.y;
    const now = Date.now();
    const note: Note = { id, x, y, w: null, h: null, t: now, text, modePos: null };
    setNotes((ns) => [...ns, note]);
    pushOp({ type: "create", id });
    void onCreate(note, opts);
    enrichIfUrlNote(id);
    return id;
  }

  const enrichedRef = useRef<Set<string>>(new Set());

  function enrichIfUrlNote(id: string) {
    const cur = notesRef.current.find((n) => n.id === id);
    if (!cur) return;
    const lines = cur.text.split("\n");
    if (!lines[0]) return;
    const url = parsePastedUrl(lines[0]);
    if (!url) return;
    const key = `${id}:${url}`;
    if (enrichedRef.current.has(key)) return;
    enrichedRef.current.add(key);
    void remoteStorage.previewUrl(url).then((title) => {
      if (!title) return;
      if (editingIdRef.current === id) {
        enrichedRef.current.delete(key);
        return;
      }
      const cur2 = notesRef.current.find((n) => n.id === id);
      if (!cur2) return;
      const lines2 = cur2.text.split("\n");
      if (parsePastedUrl(lines2[0] ?? "") !== url) return;
      const tail = lines2.slice(1).join("\n");
      const nextText = title + "\n" + url + (tail ? "\n" + tail : "");
      setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, text: nextText } : n)));
      onUpdate(id, { text: nextText });
    });
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

  // Paper only: fly the canvas to center the page and fit its A4 height in the
  // viewport, so editing a document-sized surface happens head-on. The current
  // view is stashed so commitEditing can fly back.
  function focusPaper(id: string) {
    const el = canvasRef.current;
    const W = el?.clientWidth ?? window.innerWidth;
    const H = el?.clientHeight ?? window.innerHeight;
    const n = notesRef.current.find((x) => x.id === id);
    const p = modePosRef.current.get(id) ?? (n ? { x: n.x, y: n.y } : { x: 0, y: 0 });
    // Zoom so the whole A4 page fits the viewport (contain) — this zooms IN
    // when the page is smaller than the viewport, rather than capping at 1×.
    const margin = 60;
    const zoom = Math.max(0.32, Math.min(2.5, Math.min((W - margin * 2) / PAPER_W, (H - margin * 2) / PAPER_H)));
    const cx = p.x + PAPER_W / 2, cy = p.y + PAPER_H / 2;
    focusReturnViewRef.current = viewRef.current;
    animateView({ pan: { x: W / 2 - cx * zoom, y: H / 2 - cy * zoom }, zoom });
  }

  function startEditingExisting(id: string) {
    if (editingId === id) return;
    if (editingId) commitEditing();
    const n = notesRef.current.find((x) => x.id === id);
    if (!n) return;
    editSnapshotRef.current = { id, isNew: false, prevText: n.text, prevT: n.t };
    setEditingId(id);
    if (tweakRef.current.viewMode === "paper") focusPaper(id);
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
      enrichIfUrlNote(id);
    }
    setEditingId(null);
    editSnapshotRef.current = null;
    // Fly back to where we were before focusing a paper page.
    if (focusReturnViewRef.current) {
      animateView(focusReturnViewRef.current);
      focusReturnViewRef.current = null;
    }
  }

  function updateNoteText(id: string, text: string) {
    setNotes((ns) => ns.map((n) => n.id === id ? { ...n, text } : n));
  }

  function deleteNoteById(id: string) {
    const cur = notesRef.current.find((n) => n.id === id);
    if (!cur) return;
    pushOp({ type: "delete", note: { ...cur } });
    setNotes((ns) => ns.filter((n) => n.id !== id));
    if (editingId === id) {
      setEditingId(null);
      editSnapshotRef.current = null;
    }
    onDelete(id);
  }

  const seedIdSet = useMemo(() => new Set(seedIds), [seedIds]);
  const remainingSeeds = notes.filter((n) => seedIdSet.has(n.id));

  // Drop the on-device record once no seeds remain, so it doesn't linger.
  useEffect(() => {
    if (seedIds.length > 0 && remainingSeeds.length === 0) seedIdStore.clear();
  }, [seedIds.length, remainingSeeds.length]);

  function clearStarterNotes() {
    for (const n of notes.filter((x) => seedIdSet.has(x.id))) deleteNoteById(n.id);
    seedIdStore.clear();
  }

  function reinsertRestoredNote(note: { id: string; x: number; y: number; t: number; text: string }) {
    setNotes((ns) => (ns.some((n) => n.id === note.id) ? ns : [...ns, { ...note, w: null, h: null, modePos: null }]));
  }

  function startResize(e: React.MouseEvent<HTMLDivElement>, id: string, dir: "e" | "s" | "se") {
    e.stopPropagation();
    e.preventDefault();
    const note = notesRef.current.find((n) => n.id === id);
    if (!note) return;
    const el = (e.currentTarget.parentElement as HTMLElement | null);
    const startW = note.w ?? el?.offsetWidth ?? tweakRef.current.noteWidth;
    const startH = note.h ?? el?.offsetHeight ?? 150;
    const startSX = e.clientX, startSY = e.clientY;
    const onMove = (ev: MouseEvent) => {
      const z = viewRef.current.zoom;
      const dx = (ev.clientX - startSX) / z;
      const dy = (ev.clientY - startSY) / z;
      const nw = dir === "s" ? startW : Math.max(120, startW + dx);
      const nh = dir === "e" ? startH : Math.max(60, startH + dy);
      setNotes((ns) => ns.map((n) => n.id === id ? { ...n, w: nw, h: nh } : n));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const cur = notesRef.current.find((n) => n.id === id);
      if (cur && (cur.w !== startW || cur.h !== startH)) {
        onUpdate(id, { w: cur.w, h: cur.h });
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
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
    if (prevViewRef.current) {
      animateView(prevViewRef.current);
      prevViewRef.current = null;
    } else if (notesRef.current.length) {
      // Nothing to frame on an empty canvas — don't enter a stuck overview.
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
    // Ignore the 2nd+ click of a multi-click: otherwise a double-tap spawns a
    // note then commits (deletes) it. preventDefault above also blocks the
    // native text-selection.
    if (e.detail > 1) return;
    markInteracted();
    // Plain drag pans the canvas; ⌘/Ctrl + drag marquee-selects.
    const wantsSelect = e.metaKey || e.ctrlKey;
    const startSX = e.clientX, startSY = e.clientY;
    const startPan = { ...viewRef.current.pan };
    const startCanvas = screenToCanvas(startSX, startSY);
    let moved = false;

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startSX, dy = ev.clientY - startSY;
      if (!moved && dx * dx + dy * dy > 9) moved = true;
      if (!moved) return;
      if (!wantsSelect) {
        setView((v) => ({ ...v, pan: { x: startPan.x + dx, y: startPan.y + dy } }));
      } else {
        const cur = screenToCanvas(ev.clientX, ev.clientY);
        setMarquee({
          x0: Math.min(startCanvas.x, cur.x),
          y0: Math.min(startCanvas.y, cur.y),
          x1: Math.max(startCanvas.x, cur.x),
          y1: Math.max(startCanvas.y, cur.y),
        });
      }
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (!moved) {
        // In overview (entered via z) a click flies back, not spawns.
        if (prevViewRef.current) { animateView(prevViewRef.current); prevViewRef.current = null; return; }
        if (viewRef.current.zoom < 0.95) return; // manually zoomed way out — don't spawn tiny notes
        if (editingId) { commitEditing(); return; }
        if (ambientOpen) { closeAmbient(); return; }
        if (selectedIdsRef.current.size > 0) { setSelectedIds(new Set()); return; }
        const c = screenToCanvas(ev.clientX, ev.clientY);
        spawnAt(c.x, c.y);
        return;
      }
      if (!wantsSelect) return;
      const cur = screenToCanvas(ev.clientX, ev.clientY);
      const m = {
        x0: Math.min(startCanvas.x, cur.x),
        y0: Math.min(startCanvas.y, cur.y),
        x1: Math.max(startCanvas.x, cur.x),
        y1: Math.max(startCanvas.y, cur.y),
      };
      const w = tweakRef.current.noteWidth, h = 150;
      const hit = new Set<string>();
      for (const n of notesRef.current) {
        if (n.x + w >= m.x0 && n.x <= m.x1 && n.y + h >= m.y0 && n.y <= m.y1) {
          hit.add(n.id);
        }
      }
      setSelectedIds(hit);
      setMarquee(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId, ambientOpen]);

  const onNoteMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>, id: string) => {
    if (e.button !== 0) return;
    // All modes are freeform + draggable; sticky/paper just declump on entry.
    if (editingId === id) return;
    e.stopPropagation();
    markInteracted();
    if (prevViewRef.current) {
      const n = notesRef.current.find((x) => x.id === id);
      if (n) flyTo(n);
      return;
    }
    const note = notesRef.current.find((n) => n.id === id);
    if (!note) return;
    const isSelected = selectedIdsRef.current.has(id);
    const groupIds: string[] = isSelected ? Array.from(selectedIdsRef.current) : [id];
    // In a mode, a drag edits the ephemeral mode map (canvas x/y untouched, so
    // nothing persists and default is unaffected). In default it edits the real
    // x/y. Either way only the grabbed card(s) move — no reflow of the rest.
    const managed = tweakRef.current.viewMode !== "default";
    const startPositions = new Map<string, { x: number; y: number }>();
    for (const nid of groupIds) {
      const n = notesRef.current.find((x) => x.id === nid);
      if (!n) continue;
      startPositions.set(nid, managed ? modePosRef.current.get(nid) ?? { x: n.x, y: n.y } : { x: n.x, y: n.y });
    }
    const startSX = e.clientX, startSY = e.clientY;
    let moved = false;
    setDraggingId(id);

    const onMove = (ev: MouseEvent) => {
      const dxs = ev.clientX - startSX, dys = ev.clientY - startSY;
      if (!moved && dxs * dxs + dys * dys > 9) moved = true;
      if (!moved) return;
      const z = viewRef.current.zoom;
      const dx = dxs / z, dy = dys / z;
      const useSnap = tweakRef.current.snap && !ev.shiftKey;
      const at = (sp: { x: number; y: number }) => ({
        x: useSnap ? snap(sp.x + dx) : sp.x + dx,
        y: useSnap ? snap(sp.y + dy) : sp.y + dy,
      });
      if (managed) {
        setModePos((prev) => {
          const next = new Map(prev);
          startPositions.forEach((sp, nid) => next.set(nid, at(sp)));
          return next;
        });
      } else {
        setNotes((ns) => ns.map((n) => {
          const sp = startPositions.get(n.id);
          return sp ? { ...n, ...at(sp) } : n;
        }));
      }
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setDraggingId(null);
      if (!moved) {
        // Single click selects; editing is on double-click (onDoubleClick).
        if (editingId && editingId !== id) commitEditing();
        if (ambientOpen) closeAmbient();
        setSelectedIds(new Set([id]));
        return;
      }
      // Single-card drops snap to the nearest free spot so cards never stack.
      const el = canvasRef.current?.querySelector<HTMLElement>(`[data-note-id="${id}"]`);
      const selfW = el?.offsetWidth ?? note.w ?? tweakRef.current.noteWidth;
      const selfH = el?.offsetHeight ?? note.h ?? 96;
      if (managed) {
        // Settle the dragged card, then persist the moved card(s)' positions
        // onto their notes' `modePos` (canvas x/y untouched). This syncs.
        const mode = tweakRef.current.viewMode as "sticky" | "paper";
        const final = new Map(modePosRef.current);
        if (groupIds.length === 1) {
          const cur = final.get(id);
          if (cur) {
            const spot = resolveFreePosition(cur.x, cur.y, selfW, selfH, measureRects(id));
            if (spot.x !== cur.x || spot.y !== cur.y) {
              final.set(id, spot);
              setModePos(new Map(final));
              setSnappingId(id);
              window.setTimeout(() => setSnappingId((s) => (s === id ? null : s)), 340);
            }
          }
        }
        const patches = new Map<string, ModePos>();
        for (const nid of groupIds) {
          const pos = final.get(nid);
          if (!pos) continue;
          const cur = notesRef.current.find((n) => n.id === nid);
          patches.set(nid, { ...(cur?.modePos ?? {}), [mode]: pos });
        }
        if (patches.size) {
          setNotes((ns) => ns.map((n) => { const p = patches.get(n.id); return p ? { ...n, modePos: p } : n; }));
          for (const [nid, mp] of patches) onUpdate(nid, { modePos: mp });
        }
        return;
      }
      if (groupIds.length === 1) {
        const sp = startPositions.get(id);
        const cur = notesRef.current.find((n) => n.id === id);
        if (sp && cur) {
          const spot = resolveFreePosition(cur.x, cur.y, selfW, selfH, measureRects(id));
          pushOp({ type: "move", id, prevX: sp.x, prevY: sp.y });
          if (spot.x !== cur.x || spot.y !== cur.y) {
            setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, x: spot.x, y: spot.y } : n)));
            setSnappingId(id);
            window.setTimeout(() => setSnappingId((s) => (s === id ? null : s)), 340);
          }
          onUpdate(id, { x: spot.x, y: spot.y });
        }
      } else {
        for (const nid of groupIds) {
          const sp = startPositions.get(nid);
          if (!sp) continue;
          pushOp({ type: "move", id: nid, prevX: sp.x, prevY: sp.y });
          const cur = notesRef.current.find((n) => n.id === nid);
          if (cur) onUpdate(nid, { x: cur.x, y: cur.y });
        }
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId, ambientOpen]);

  // ── Ambient mode + command palette ─────────────────────────────────
  const ambientMode: "search" | "command" =
    recallQuery.startsWith(">") ? "command" : "search";
  const effectiveQuery = ambientMode === "command" ? recallQuery.slice(1) : recallQuery;

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];
    list.push({
      id: "new-note",
      label: "New note",
      hint: "spawn at canvas center",
      run: () => spawnAtCenter(""),
    });
    list.push({
      id: "tweaks",
      label: "Open tweaks",
      hint: "⌘, · theme + canvas + paper",
      run: () => setTweaksOpen(true),
    });
    list.push({
      id: "help",
      label: "Show help",
      hint: "?",
      run: () => setHelpOpen(true),
    });
    list.push({
      id: "graveyard",
      label: "Show recently deleted",
      hint: "30-day window",
      run: () => setGraveyardOpen(true),
    });
    list.push({
      id: "relations",
      label: relationsOn ? "Hide relations" : "Show relations",
      hint: "r · threads to notes sharing a tag",
      run: () => setRelationsOn((v) => !v),
    });
    if (!isAnonymous) {
      list.push({
        id: "sign-out",
        label: "Sign out",
        hint: identityLabel,
        run: () => { void onSignOut(); },
      });
    } else {
      list.push({
        id: "sign-in",
        label: "Sign in",
        hint: "sync across devices",
        run: () => setAuthPanelOpen(true),
      });
    }
    return list;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAnonymous, identityLabel, relationsOn]);

  const commandMatches = useMemo<Command[]>(
    () => (ambientMode === "command" ? filterCommands(commands, effectiveQuery) : []),
    [ambientMode, commands, effectiveQuery],
  );

  const [matchIds, setMatchIds] = useState<string[] | null>(null);
  useEffect(() => {
    if (!ambientOpen || ambientMode !== "search") { setMatchIds(null); return; }
    const q = effectiveQuery.trim();
    if (!q) { setMatchIds(null); return; }

    const lower = q.toLowerCase();
    setMatchIds(notesRef.current.filter((n) => n.text.toLowerCase().includes(lower)).map((n) => n.id));

    if (q.startsWith("#")) return;

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
  }, [effectiveQuery, ambientOpen, ambientMode]);
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

  useEffect(() => { setRecallIdx(0); }, [ambientMode]);
  useEffect(() => {
    if (ambientMode !== "command") return;
    if (recallIdx >= commandMatches.length) setRecallIdx(0);
  }, [ambientMode, commandMatches.length, recallIdx]);

  function stepMatch(delta: number) {
    if (ambientMode === "command") {
      if (commandMatches.length === 0) return;
      setRecallIdx((i) => (i + delta + commandMatches.length) % commandMatches.length);
      return;
    }
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
    if (ambientMode === "command") {
      const cmd = commandMatches[recallIdx];
      closeAmbient();
      if (cmd) void cmd.run();
      return;
    }
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
        // Close whatever's open, most-transient first. Consume the event when
        // we handle it so the browser doesn't also act on Esc (e.g. exit
        // fullscreen); only fall through when there's nothing to dismiss.
        let handled = true;
        if (contextMenu) setContextMenu(null);
        else if (selectedIdsRef.current.size > 0) setSelectedIds(new Set());
        else if (graveyardOpen) setGraveyardOpen(false);
        else if (authPanelOpen) setAuthPanelOpen(false);
        else if (tweaksOpen) setTweaksOpen(false);
        else if (helpOpen) setHelpOpen(false);
        else if (ambientOpen) closeAmbient();
        else if (editingId) commitEditing();
        else if (prevViewRef.current) {
          animateView(prevViewRef.current); prevViewRef.current = null;
        } else handled = false;
        if (handled) { e.preventDefault(); e.stopPropagation(); return; }
      }

      // When the auth panel is open, every key belongs to the form
      // (typed in inputs) or to closing the panel. Don't let canvas
      // shortcuts (z, /, ?, character→ambient) leak through.
      if (authPanelOpen) return;

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

      if ((e.key === "Backspace" || e.key === "Delete") && selectedIdsRef.current.size > 0) {
        e.preventDefault();
        for (const nid of Array.from(selectedIdsRef.current)) deleteNoteById(nid);
        setSelectedIds(new Set());
        return;
      }

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

      // ⌘/Ctrl +/- zoom on the canvas center. "=" covers the unshifted "+" key.
      if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "+" || e.key === "-")) {
        e.preventDefault();
        const el = canvasRef.current;
        if (el) {
          const r = el.getBoundingClientRect();
          zoomAt(e.key === "-" ? 1 / 1.2 : 1.2, r.width / 2, r.height / 2);
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
      if (e.key === "r" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        setRelationsOn((v) => { if (v) setHoveredId(null); return !v; });
        return;
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
  }, [editingId, ambientOpen, helpOpen, tweaksOpen, authPanelOpen, graveyardOpen, contextMenu, recallQuery, recallIdx, matchIds]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
      }
      if (authPanelOpen || helpOpen || tweaksOpen || editingId) return;
      // Auto-capture already turns every copy into a note, so paste-to-create
      // here would just duplicate it. Cede the gesture while capture is on.
      if (isTauri && tweakRef.current.clipboardCapture) return;

      const text = e.clipboardData?.getData("text/plain")?.trim();
      if (!text) return;
      e.preventDefault();
      markInteracted();

      const sx = lastMouseRef.current?.x ?? window.innerWidth / 2;
      const sy = lastMouseRef.current?.y ?? window.innerHeight / 2;
      const c = screenToCanvas(sx, sy);

      const url = parsePastedUrl(text);
      spawnCommitted(c.x, c.y, url ?? text);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authPanelOpen, helpOpen, tweaksOpen, editingId]);

  // Desktop clipboard auto-capture. When the tweak is on, enable the Rust
  // monitor and turn each new copied string into a committed note — classified
  // + formatted (code/json fenced, URLs normalized) so it renders right.
  // Notes cascade via findFreeSpot so repeated captures don't stack.
  useEffect(() => {
    if (!isTauri || !t.clipboardCapture) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const [{ invoke }, { listen }] = await Promise.all([
        import("@tauri-apps/api/core"),
        import("@tauri-apps/api/event"),
      ]);
      if (cancelled) return;
      await invoke("set_clipboard_capture", { enabled: true });
      unlisten = await listen<string>("clipboard://text", (event) => {
        const raw = event.payload;
        if (!raw || !raw.trim()) return;
        const { text: formatted, kind } = formatCapturedNote(raw);
        const noteText = kind === "url" ? parsePastedUrl(raw) ?? formatted : formatted;
        const c = screenToCanvas(window.innerWidth / 2, window.innerHeight / 2);
        const id = spawnCommitted(c.x, c.y, noteText, { localOnly: !tweakRef.current.clipboardSyncToCloud });
        markClipboardOrigin(id);
      });
    })();
    return () => {
      cancelled = true;
      unlisten?.();
      void import("@tauri-apps/api/core").then(({ invoke }) =>
        invoke("set_clipboard_capture", { enabled: false }),
      );
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.clipboardCapture]);

  // ── Render ─────────────────────────────────────────────────────────
  // Overview = zoomed way out, or entered via z (can settle at zoom≈1 for a
  // tight cluster). prevViewRef flips alongside a setView, so it's safe here.
  const inOverview = view.zoom < 0.95 || prevViewRef.current != null;

  function scrubFadeFor(n: Note) {
    if (scrubMoment == null) return 1;
    return n.t <= scrubMoment ? 1 : 0;
  }

  // Threads from the active note (hovered, or the lone selection) to every
  // note sharing a tag with it. Curved paths in canvas coordinates — the SVG
  // lives inside the transformed notes-layer, so note x/y map 1:1.
  const relationThreads = useMemo(() => {
    if (!relationsOn || viewMode !== "default") return [];
    const activeId = hoveredId ?? (selectedIds.size === 1 ? [...selectedIds][0] : null);
    if (!activeId) return [];
    const active = notes.find((n) => n.id === activeId);
    if (!active) return [];
    const activeTags = new Set(tagsOf(active.text));
    if (activeTags.size === 0) return [];

    const center = (n: Note) => ({
      x: n.x + (n.w ?? t.noteWidth) / 2,
      y: n.y + (n.h ?? 56) / 2,
    });
    const a = center(active);
    const out: { id: string; d: string }[] = [];
    for (const n of notes) {
      if (n.id === activeId) continue;
      if (!tagsOf(n.text).some((tag) => activeTags.has(tag))) continue;
      const b = center(n);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const bow = Math.min(48, len * 0.14);
      const cx = mx + (-dy / len) * bow, cy = my + (dx / len) * bow;
      out.push({ id: n.id, d: `M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x} ${b.y}` });
    }
    return out;
  }, [relationsOn, viewMode, hoveredId, selectedIds, notes, t.noteWidth]);

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
          className={"notes-layer view-" + viewMode + (smooth ? " smooth" : "") + (inOverview ? " overview" : "") + (layoutAnimating ? " layout-animating" : "")}
          style={{ transform: `translate(${view.pan.x}px, ${view.pan.y}px) scale(${view.zoom})` }}
        >
          {marquee && (
            <div
              className="marquee"
              style={{
                left: marquee.x0,
                top: marquee.y0,
                width: marquee.x1 - marquee.x0,
                height: marquee.y1 - marquee.y0,
              }}
            />
          )}
          {relationThreads.length > 0 && (
            <svg className="relation-threads" aria-hidden="true">
              {relationThreads.map((th) => (
                <path key={th.id} d={th.d} pathLength={1} />
              ))}
            </svg>
          )}
          {notes.map((n) => (
            <NoteCard
              key={n.id}
              note={n}
              pos={viewMode === "default" ? { x: n.x, y: n.y } : modePos.get(n.id) ?? { x: n.x, y: n.y }}
              viewMode={viewMode}
              stickyColor={viewMode === "sticky" ? stickyColorOf(n.id) : null}
              fromClipboard={clipboardIds.has(n.id)}
              onHover={onNoteHover}
              editing={editingId === n.id}
              dragging={draggingId === n.id}
              snapping={snappingId === n.id}
              dimmed={!!matchSet && !matchSet.has(n.id)}
              highlit={!!matchSet && matchSet.has(n.id)}
              focused={!!matchIds && matchIds[recallIdx] === n.id}
              selected={selectedIds.has(n.id)}
              hidden={editingId === n.id && t.editMode === "focused"}
              scrubFade={scrubFadeFor(n)}
              onMouseDown={(e) => onNoteMouseDown(e, n.id)}
              onEdit={() => startEditingExisting(n.id)}
              onTextChange={(v) => updateNoteText(n.id, v)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setContextMenu({ id: n.id, x: e.clientX, y: e.clientY });
              }}
              onTagClick={(tag) => {
                if (editingId) commitEditing();
                openAmbient("#" + tag);
                markInteracted();
              }}
              onResizeStart={(e, dir) => startResize(e, n.id, dir)}
            />
          ))}
        </div>
      </Canvas>

      {notes.length === 0 && <GhostCard />}

      {remainingSeeds.length > 0 && (
        <button
          type="button"
          className="chrome chrome-clear-seeds"
          onClick={clearStarterNotes}
          title="Remove the welcome notes"
        >
          clear starter notes
        </button>
      )}

      {editingId && t.editMode === "focused" && (() => {
        const n = notes.find((x) => x.id === editingId);
        if (!n) return null;
        return (
          <FocusedEditor
            note={n}
            onTextChange={(v) => updateNoteText(n.id, v)}
            onCommit={commitEditing}
          />
        );
      })()}

      <Toolbar
        mode={viewMode}
        onSetMode={(m) => { markInteracted(); setTweak("viewMode", m); }}
        onNewNote={() => { markInteracted(); spawnAtCenter(""); }}
        onSearch={() => { markInteracted(); openAmbient(""); }}
        overviewActive={inOverview}
        onOverview={() => { markInteracted(); toggleOverview(); }}
        relationsActive={relationsOn}
        onRelations={() => { markInteracted(); setRelationsOn((v) => !v); }}
        onGraveyard={() => setGraveyardOpen(true)}
        onTweaks={() => setTweaksOpen(true)}
        onHelp={() => setHelpOpen(true)}
        isAnonymous={isAnonymous}
        identityLabel={identityLabel}
        onSignIn={() => setAuthPanelOpen(true)}
        onSignOut={onSignOut}
        count={notes.length}
        sync={syncLabel(online, lastWriteAt, nowTick)}
        syncState={!online ? "offline" : lastWriteAt && Date.now() - lastWriteAt < 4000 ? "writing" : "synced"}
      />

      <AuthPanel
        open={authPanelOpen}
        onClose={() => setAuthPanelOpen(false)}
        hasGoogle={hasGoogle}
      />

      {ambientOpen && (
        <AmbientBar
          query={recallQuery}
          mode={ambientMode}
          matchCount={
            ambientMode === "command"
              ? commandMatches.length
              : matchIds ? matchIds.length : null
          }
          recallIdx={recallIdx}
          commandMatches={ambientMode === "command" ? commandMatches : null}
        />
      )}

      <TimeScrub
        notes={notes}
        scrubMoment={scrubMoment}
        setScrubMoment={setScrubMoment}
      />

      {t.compass && <Compass notes={notes} view={view} flyHome={flyHome} />}

      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}

      {contextMenu && (
        <NoteContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onDelete={() => {
            const id = contextMenu.id;
            setContextMenu(null);
            deleteNoteById(id);
          }}
        />
      )}

      <Graveyard
        open={graveyardOpen}
        onClose={() => setGraveyardOpen(false)}
        onRestored={(n) => reinsertRestoredNote(n)}
      />

      <TweaksUI t={t} setTweak={setTweak} open={tweaksOpen} onClose={() => setTweaksOpen(false)} />
    </div>
  );
}

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
    if (grid === "off") return { background: "rgb(var(--bg))" };
    if (grid === "lines") {
      const line = "rgb(var(--text-secondary) / 0.06)";
      const s = 56 * z;
      return {
        backgroundColor: "rgb(var(--bg))",
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
      backgroundColor: "rgb(var(--bg))",
      backgroundImage:
        "radial-gradient(circle, rgb(var(--text-secondary) / 0.12) 1px, transparent 1.4px)",
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
  note, pos, viewMode, stickyColor, fromClipboard, editing, dragging, snapping,
  dimmed, highlit, focused, selected, hidden, scrubFade,
  onMouseDown, onEdit, onTextChange, onContextMenu, onTagClick, onResizeStart, onHover,
}: {
  note: Note;
  pos: { x: number; y: number };
  viewMode: ViewMode;
  stickyColor: { bg: string; ink: string } | null;
  fromClipboard: boolean;
  onHover: (id: string | null) => void;
  editing: boolean;
  dragging: boolean;
  snapping: boolean;
  dimmed: boolean;
  highlit: boolean;
  focused: boolean;
  selected: boolean;
  hidden: boolean;
  scrubFade: number;
  onMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void;
  onEdit: () => void;
  onTextChange: (v: string) => void;
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => void;
  onTagClick: (tag: string) => void;
  onResizeStart: (e: React.MouseEvent<HTMLDivElement>, dir: "e" | "s" | "se") => void;
}) {
  const rec = recencyOf(note.t);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    // Sticky is a fixed square — don't auto-grow the textarea (it would spill
    // out of the card); CSS fills it and scrolls instead. Default/paper grow.
    if (!editing || !taRef.current || viewMode === "sticky") return;
    const ta = taRef.current;
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  }, [editing, note.text, viewMode]);

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
  const startsWithFence = /^\s*`{3,}/.test(first);

  const cls = [
    "note",
    `rec-${rec}`,
    editing ? "editing" : "",
    dragging ? "dragging" : "",
    snapping ? "snapping" : "",
    dimmed ? "dim" : "",
    highlit ? "hit" : "",
    focused ? "focused" : "",
    selected ? "selected" : "",
    hidden ? "is-hidden" : "",
    isHeading && !editing ? "has-heading" : "",
  ].filter(Boolean).join(" ");

  // Default colors come from the theme + recency alpha; stickies wear a fixed
  // palette color and skip the recency fade.
  const isManaged = viewMode !== "default";
  const style: CSSProperties = {
    left: pos.x,
    top: pos.y,
    backgroundColor: stickyColor ? stickyColor.bg : "rgb(var(--bg-secondary))",
    color: stickyColor ? stickyColor.ink : "rgb(var(--text-primary))",
    opacity: (isManaged ? 1 : RECENCY_ALPHA[rec]) * (scrubFade ?? 1),
  };
  // Per-note resize overrides apply only in default; modes own card size.
  if (!isManaged && note.w != null) style.width = note.w;
  if (!isManaged && note.h != null) {
    style.maxHeight = "none";
    if (!editing) style.height = note.h;
  }
  // Paper = A4 (from shared constants, so JS layout and card can't drift).
  if (viewMode === "paper") {
    style.width = PAPER_W;
    style.minHeight = PAPER_H;
  }

  return (
    <div
      className={cls}
      data-note-id={note.id}
      style={style}
      onMouseDown={(e) => {
        const target = e.target as HTMLElement;
        const tagEl = target.closest("[data-tag]") as HTMLElement | null;
        if (tagEl && !editing) {
          e.stopPropagation();
          e.preventDefault();
          const tag = tagEl.dataset.tag;
          if (tag) onTagClick(tag);
          return;
        }
        onMouseDown(e);
      }}
      onDoubleClick={() => { if (!editing) onEdit(); }}
      onMouseEnter={() => onHover(note.id)}
      onMouseLeave={() => onHover(null)}
      onContextMenu={onContextMenu}
    >
      {editing ? (
        <textarea
          ref={taRef}
          className="note-ta"
          value={note.text}
          onChange={(e) => onTextChange(e.target.value)}
          onMouseDown={(e) => e.stopPropagation()}
          placeholder="just write."
          spellCheck={false}
        />
      ) : startsWithFence ? (
        <div className="note-rest" style={{ color: "rgb(var(--text-secondary))" }}>
          {renderBody(note.text)}
        </div>
      ) : (
        <>
          {first
            ? <div className="note-first">{renderHeadline(first)}</div>
            : <div className="note-first" style={{ opacity: 0.35 }}>empty</div>}
          {rest && <div className="note-rest" style={{ color: "rgb(var(--text-secondary))" }}>{renderBody(rest)}</div>}
        </>
      )}
      {!editing && fromClipboard && (
        <div className="note-clip" title="captured from clipboard" aria-label="captured from clipboard">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="8" y="2" width="8" height="4" rx="1" />
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
          </svg>
        </div>
      )}
      {!editing && <div className="note-pad-cover" aria-hidden="true" />}
      {!editing && !isManaged && (
        <>
          <div
            className="note-edge note-edge-e"
            aria-hidden="true"
            onMouseDown={(e) => onResizeStart(e, "e")}
          />
          <div
            className="note-edge note-edge-s"
            aria-hidden="true"
            onMouseDown={(e) => onResizeStart(e, "s")}
          />
          <div
            className="note-resize"
            aria-label="resize"
            onMouseDown={(e) => onResizeStart(e, "se")}
          />
        </>
      )}
    </div>
  );
}

// View-mode buttons for the toolbar; each writes the persisted `viewMode`.
const MODE_META: { mode: ViewMode; label: string; icon: React.ReactNode }[] = [
  {
    mode: "default",
    label: "canvas",
    // Dotted grid — the freeform infinite canvas.
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="7" cy="7" r="1.7" /><circle cx="17" cy="7" r="1.7" />
        <circle cx="7" cy="17" r="1.7" /><circle cx="17" cy="17" r="1.7" />
      </svg>
    ),
  },
  {
    mode: "sticky",
    label: "sticky",
    // Square with a folded corner.
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" aria-hidden="true">
        <path d="M5 4h14v9l-6 6H5z" /><path d="M19 13h-6v6" />
      </svg>
    ),
  },
  {
    mode: "paper",
    label: "paper",
    // Page with text lines.
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="5" y="3" width="14" height="18" rx="1.6" /><path d="M8.5 8h7M8.5 12h7M8.5 16h4" />
      </svg>
    ),
  },
];

type SyncState = "synced" | "writing" | "offline";

function syncLabel(online: boolean, lastWriteAt: number | null, _tick: number): string {
  if (!online) return "offline";
  if (lastWriteAt == null) return "synced";
  const ageMs = Date.now() - lastWriteAt;
  if (ageMs < 4000) return "saving…";
  if (ageMs < 60_000) return `saved · ${Math.max(1, Math.round(ageMs / 1000))}s ago`;
  if (ageMs < 3.6e6) return `saved · ${Math.round(ageMs / 60_000)}m ago`;
  return "synced";
}

// ── Toolbar ────────────────────────────────────────────────────────────
// Top-left vertical toolbar: view modes, primary actions, then a count/sync
// footer. Everything here also has a keyboard shortcut and a ⌘K palette
// entry — this is just the visible, one-click surface for the same handlers.
const svg = (children: React.ReactNode, filled = false) => (
  <svg
    width="16" height="16" viewBox="0 0 24 24"
    fill={filled ? "currentColor" : "none"}
    stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);
const TB_ICON = {
  plus: svg(<path d="M12 5v14M5 12h14" />),
  search: svg(<><circle cx="11" cy="11" r="7" /><path d="m21 21-4-4" /></>),
  overview: svg(<path d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4" />),
  relations: svg(<><circle cx="6.5" cy="6.5" r="2.5" /><circle cx="17.5" cy="17.5" r="2.5" /><path d="M8.4 8.4l7.2 7.2" /></>),
  graveyard: svg(<><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" /><path d="M3 4v4h4" /><path d="M12 8v4.5l3 1.8" /></>),
  tweaks: svg(<><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="2.2" /><circle cx="15" cy="17" r="2.2" /></>),
  help: svg(<><circle cx="12" cy="12" r="9" /><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.9.4-1.4 1-1.4 2" /><path d="M12 17h.01" /></>),
  account: svg(<><circle cx="12" cy="8.5" r="3.5" /><path d="M5.5 20a6.5 6.5 0 0 1 13 0" /></>),
};

function TbBtn({ label, active, onClick, children }: {
  label: string; active?: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={"tb-btn" + (active ? " active" : "")}
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

type ToolbarProps = {
  mode: ViewMode;
  onSetMode: (m: ViewMode) => void;
  onNewNote: () => void;
  onSearch: () => void;
  overviewActive: boolean;
  onOverview: () => void;
  relationsActive: boolean;
  onRelations: () => void;
  onGraveyard: () => void;
  onTweaks: () => void;
  onHelp: () => void;
  isAnonymous: boolean;
  identityLabel: string;
  onSignIn: () => void;
  onSignOut: () => void;
  count: number;
  sync: string;
  syncState: SyncState;
};

function Toolbar(p: ToolbarProps) {
  return (
    <div className="chrome toolbar" role="toolbar" aria-label="tools">
      <div className="tb-group" role="radiogroup" aria-label="canvas view mode">
        {MODE_META.map((m) => (
          <button
            key={m.mode}
            type="button"
            role="radio"
            aria-checked={m.mode === p.mode}
            aria-label={m.label}
            title={m.label}
            className={"tb-btn" + (m.mode === p.mode ? " active" : "")}
            onClick={() => p.onSetMode(m.mode)}
          >
            {m.icon}
          </button>
        ))}
      </div>

      <div className="tb-sep" aria-hidden="true" />

      <TbBtn label="New note" onClick={p.onNewNote}>{TB_ICON.plus}</TbBtn>
      <TbBtn label="Search" onClick={p.onSearch}>{TB_ICON.search}</TbBtn>
      <TbBtn label="Overview" active={p.overviewActive} onClick={p.onOverview}>{TB_ICON.overview}</TbBtn>
      <TbBtn label="Relations" active={p.relationsActive} onClick={p.onRelations}>{TB_ICON.relations}</TbBtn>
      <TbBtn label="Recently deleted" onClick={p.onGraveyard}>{TB_ICON.graveyard}</TbBtn>

      <div className="tb-sep" aria-hidden="true" />

      <TbBtn label="Settings" onClick={p.onTweaks}>{TB_ICON.tweaks}</TbBtn>
      <TbBtn label="Help" onClick={p.onHelp}>{TB_ICON.help}</TbBtn>
      <TbBtn
        label={p.isAnonymous ? "Sign in to sync" : `${p.identityLabel || "Account"} · sign out`}
        onClick={p.isAnonymous ? p.onSignIn : p.onSignOut}
      >
        {TB_ICON.account}
      </TbBtn>

      <div className="tb-sep" aria-hidden="true" />

      <div className={"tb-foot sync-" + p.syncState} title={p.sync}>
        <span className="tb-count">{p.count}</span>
        <span className="tb-sync" aria-label={p.sync} />
      </div>
    </div>
  );
}

// ── HelpOverlay ────────────────────────────────────────────────────────
function HelpOverlay({ onClose }: { onClose: () => void }) {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  const mod = isMac ? "⌘" : "Ctrl";
  type Row = [string | string[], string];
  const rows: Row[] = [
    ["click empty canvas",         "write a new note"],
    ["click a note",               "select it"],
    ["double-click a note",        "edit it"],
    [[mod, "V"],                   "paste · text becomes a note · URLs fetch their title"],
    ["type any letter",            "ambient · live-filters notes as you type"],
    ["#tag in a note",              "click chip to filter canvas to that tag"],
    [["↵"],                        "jump to match · or write a new note"],
    [[mod, "↵"],                   "always write (override match)"],
    [["↑↓"],                       "step through matches"],
    [["/"],                        "open ambient with empty query"],
    [[mod, "K"],                   "open ambient with empty query"],
    ["drag a note",                "reposition · snaps to grid"],
    [["shift", "drag a note"],     "ignore the grid"],
    ["drag empty canvas",          "pan · fly around"],
    [[mod, "drag empty canvas"],   "marquee select"],
    ["scroll / trackpad",          "pan"],
    [[mod, "scroll"],              "zoom centered on cursor"],
    [[mod, "+ / -"],               "zoom in / out"],
    ["drag a selected note",       "move the whole selection"],
    [["delete"],                   "remove all selected notes"],
    ["drag the right edge",        "rewind canvas through time"],
    [["z"],                        "zoom out · overview"],
    [["click a note in overview"], "fly to it"],
    [["h"],                        "fly home · re-center on cluster"],
    [["r"],                        "toggle relations · hover a note for threads to shared tags"],
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
  note, onTextChange, onCommit,
}: {
  note: Note;
  onTextChange: (v: string) => void;
  onCommit: () => void;
}) {
  const rec = recencyOf(note.t);
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
        className="focus-note"
        style={{
          background: "rgb(var(--bg-secondary))",
          color: "rgb(var(--text-primary))",
          opacity: RECENCY_ALPHA[rec],
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <textarea
          ref={taRef}
          className="focus-ta"
          value={note.text}
          onChange={(e) => onTextChange(e.target.value)}
          placeholder="just write."
          spellCheck={false}
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

function NoteContextMenu({
  x, y, onClose, onDelete,
}: {
  x: number; y: number; onClose: () => void; onDelete: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDocDown = (e: MouseEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", onDocDown);
    window.addEventListener("contextmenu", onDocDown);
    return () => {
      window.removeEventListener("mousedown", onDocDown);
      window.removeEventListener("contextmenu", onDocDown);
    };
  }, [onClose]);

  const W = 180, H = 44;
  const left = Math.min(x, window.innerWidth - W - 8);
  const top = Math.min(y, window.innerHeight - H - 8);

  return (
    <div
      ref={menuRef}
      className="note-ctx"
      style={{ left, top }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button className="note-ctx-item danger" onClick={onDelete}>
        delete
        <span className="note-ctx-hint">⌘Z to undo</span>
      </button>
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
