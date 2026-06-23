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
  type Note,
  type Tweaks,
} from "./lib";
import { renderBody, renderHeadline } from "./markdown";
import { formatCapturedNote } from "./clipboard";
import { clipboardOrigin } from "../../lib/clipboard-origin";
import { AmbientBar, Compass, TimeScrub } from "./cherries";
import { TweaksUI } from "./tweaks";
import { Button } from "@codellyson/justui/react";
import { remoteStorage } from "../../lib/storage";
import { authClient, clearKeychainToken } from "../../lib/auth-client";
import { API_BASE_URL, isTauri } from "../../lib/runtime";
import { AuthPanel } from "../AuthPanel";
import { filterCommands, type Command } from "../../lib/commands";
import { Graveyard } from "./Graveyard";

type Persist = {
  onCreate: (note: Note, opts?: { localOnly?: boolean }) => void | Promise<void>;
  onUpdate: (id: string, patch: Partial<Pick<Note, "x" | "y" | "w" | "h" | "t" | "text">>) => void;
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
  const { initialNotes, tweaks: t, setTweak, onCreate: rawOnCreate, onUpdate: rawOnUpdate, onDelete: rawOnDelete } = props;
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
  const tweakRef = useRef<Tweaks>(t);
  useEffect(() => { tweakRef.current = t; }, [t]);

  // Center the canvas around the seed cluster on first paint.
  useEffect(() => {
    if (!canvasRef.current) return;
    const r = canvasRef.current.getBoundingClientRect();
    setView({ pan: { x: r.width / 2, y: r.height / 2 - 40 }, zoom: 1 });
  }, []);

  // Wheel: plain = pan, ⌘/Ctrl (or mac trackpad pinch which fires ctrlKey) = zoom on cursor.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const v = viewRef.current;
        const factor = Math.exp(-e.deltaY * 0.012);
        const nextZoom = Math.max(0.32, Math.min(2.5, v.zoom * factor));
        const canvasX = (sx - v.pan.x) / v.zoom;
        const canvasY = (sy - v.pan.y) / v.zoom;
        setView({
          pan: { x: sx - canvasX * nextZoom, y: sy - canvasY * nextZoom },
          zoom: nextZoom,
        });
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
    setNotes((ns) => [...ns, { id, x: spot.x, y: spot.y, w: null, h: null, t: Date.now(), text: initialText }]);
    editSnapshotRef.current = { id, isNew: true, prevText: "", prevT: Date.now() };
    setEditingId(id);
  }

  function findFreeSpot(x: number, y: number): { x: number; y: number } {
    const existing = notesRef.current;
    let cx = x, cy = y;
    for (let i = 0; i < 30; i++) {
      const collides = existing.some(
        (n) => Math.abs(n.x - cx) < GRID && Math.abs(n.y - cy) < GRID,
      );
      if (!collides) return { x: cx, y: cy };
      cx += GRID;
      cy += GRID;
    }
    return { x: cx, y: cy };
  }

  function spawnCommitted(canvasX: number, canvasY: number, text: string, opts?: { localOnly?: boolean }): string {
    const id = uid();
    const w = tweakRef.current.noteWidth;
    const spot = findFreeSpot(canvasX - w / 2, canvasY - 22);
    const x = spot.x;
    const y = spot.y;
    const now = Date.now();
    const note: Note = { id, x, y, w: null, h: null, t: now, text };
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
      enrichIfUrlNote(id);
    }
    setEditingId(null);
    editSnapshotRef.current = null;
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

  function reinsertRestoredNote(note: { id: string; x: number; y: number; t: number; text: string }) {
    setNotes((ns) => (ns.some((n) => n.id === note.id) ? ns : [...ns, { ...note, w: null, h: null }]));
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
    const wantsPan = e.metaKey || e.ctrlKey;
    const startSX = e.clientX, startSY = e.clientY;
    const startPan = { ...viewRef.current.pan };
    const startCanvas = screenToCanvas(startSX, startSY);
    let moved = false;

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startSX, dy = ev.clientY - startSY;
      if (!moved && dx * dx + dy * dy > 9) moved = true;
      if (!moved) return;
      if (wantsPan) {
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
        if (viewRef.current.zoom < 0.95) {
          if (prevViewRef.current) { animateView(prevViewRef.current); prevViewRef.current = null; }
          return;
        }
        if (editingId) { commitEditing(); return; }
        if (ambientOpen) { closeAmbient(); return; }
        if (selectedIdsRef.current.size > 0) { setSelectedIds(new Set()); return; }
        const c = screenToCanvas(ev.clientX, ev.clientY);
        spawnAt(c.x, c.y);
        return;
      }
      if (wantsPan) return;
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
    const isSelected = selectedIdsRef.current.has(id);
    const groupIds: string[] = isSelected ? Array.from(selectedIdsRef.current) : [id];
    const startPositions = new Map<string, { x: number; y: number }>();
    for (const nid of groupIds) {
      const n = notesRef.current.find((x) => x.id === nid);
      if (n) startPositions.set(nid, { x: n.x, y: n.y });
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
      setNotes((ns) => ns.map((n) => {
        const sp = startPositions.get(n.id);
        if (!sp) return n;
        const rx = sp.x + dx, ry = sp.y + dy;
        return { ...n, x: useSnap ? snap(rx) : rx, y: useSnap ? snap(ry) : ry };
      }));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setDraggingId(null);
      if (!moved) {
        if (!isSelected && selectedIdsRef.current.size > 0) setSelectedIds(new Set());
        if (editingId && editingId !== id) commitEditing();
        if (ambientOpen) closeAmbient();
        startEditingExisting(id);
        return;
      }
      for (const nid of groupIds) {
        const sp = startPositions.get(nid);
        if (!sp) continue;
        pushOp({ type: "move", id: nid, prevX: sp.x, prevY: sp.y });
        const cur = notesRef.current.find((n) => n.id === nid);
        if (cur) onUpdate(nid, { x: cur.x, y: cur.y });
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
        if (contextMenu) { setContextMenu(null); return; }
        if (selectedIdsRef.current.size > 0) { setSelectedIds(new Set()); return; }
        if (graveyardOpen) { setGraveyardOpen(false); return; }
        if (authPanelOpen) { setAuthPanelOpen(false); return; }
        if (tweaksOpen) { setTweaksOpen(false); return; }
        if (helpOpen) { setHelpOpen(false); return; }
        if (ambientOpen) { closeAmbient(); return; }
        if (editingId) { commitEditing(); return; }
        if (viewRef.current.zoom < 0.95 && prevViewRef.current) {
          animateView(prevViewRef.current); prevViewRef.current = null; return;
        }
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
  const inOverview = view.zoom < 0.95;

  function scrubFadeFor(n: Note) {
    if (scrubMoment == null) return 1;
    return n.t <= scrubMoment ? 1 : 0;
  }

  // Threads from the active note (hovered, or the lone selection) to every
  // note sharing a tag with it. Curved paths in canvas coordinates — the SVG
  // lives inside the transformed notes-layer, so note x/y map 1:1.
  const relationThreads = useMemo(() => {
    if (!relationsOn) return [];
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
  }, [relationsOn, hoveredId, selectedIds, notes, t.noteWidth]);

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
              fromClipboard={clipboardIds.has(n.id)}
              onHover={onNoteHover}
              editing={editingId === n.id}
              dragging={draggingId === n.id}
              dimmed={!!matchSet && !matchSet.has(n.id)}
              highlit={!!matchSet && matchSet.has(n.id)}
              focused={!!matchIds && matchIds[recallIdx] === n.id}
              selected={selectedIds.has(n.id)}
              hidden={editingId === n.id && t.editMode === "focused"}
              scrubFade={scrubFadeFor(n)}
              onMouseDown={(e) => onNoteMouseDown(e, n.id)}
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

      <Chrome
        count={notes.length}
        sync={syncLabel(online, lastWriteAt, nowTick)}
        syncState={!online ? "offline" : lastWriteAt && Date.now() - lastWriteAt < 4000 ? "writing" : "synced"}
        hintVisible={!interacted}
        overviewLabel={inOverview ? "overview · z to return" : relationsOn ? "relations · r to hide" : null}
        isAnonymous={isAnonymous}
        identityLabel={identityLabel}
        onSignIn={() => setAuthPanelOpen(true)}
        onSignOut={onSignOut}
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
  note, fromClipboard, editing, dragging,
  dimmed, highlit, focused, selected, hidden, scrubFade,
  onMouseDown, onTextChange, onContextMenu, onTagClick, onResizeStart, onHover,
}: {
  note: Note;
  fromClipboard: boolean;
  onHover: (id: string | null) => void;
  editing: boolean;
  dragging: boolean;
  dimmed: boolean;
  highlit: boolean;
  focused: boolean;
  selected: boolean;
  hidden: boolean;
  scrubFade: number;
  onMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void;
  onTextChange: (v: string) => void;
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => void;
  onTagClick: (tag: string) => void;
  onResizeStart: (e: React.MouseEvent<HTMLDivElement>, dir: "e" | "s" | "se") => void;
}) {
  const rec = recencyOf(note.t);
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
  const startsWithFence = /^\s*`{3,}/.test(first);

  const cls = [
    "note",
    `rec-${rec}`,
    editing ? "editing" : "",
    dragging ? "dragging" : "",
    dimmed ? "dim" : "",
    highlit ? "hit" : "",
    focused ? "focused" : "",
    selected ? "selected" : "",
    hidden ? "is-hidden" : "",
    isHeading && !editing ? "has-heading" : "",
  ].filter(Boolean).join(" ");

  // Paper colors derive from the active JustUI theme. The recency
  // alpha gives the four-step aging feeling without needing per-theme
  // color tables — fresh notes are full-opacity bg-secondary, ancient
  // ones fade toward the canvas bg.
  const style: CSSProperties = {
    left: note.x,
    top: note.y,
    background: "rgb(var(--bg-secondary))",
    color: "rgb(var(--text-primary))",
    opacity: RECENCY_ALPHA[rec] * (scrubFade ?? 1),
  };
  if (note.w != null) style.width = note.w;
  if (note.h != null) {
    style.maxHeight = "none";
    if (!editing) style.height = note.h;
  }

  return (
    <div
      className={cls}
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
      {!editing && (
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

// ── Chrome ─────────────────────────────────────────────────────────────
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

function Chrome({
  count, sync, syncState, hintVisible, overviewLabel,
  isAnonymous, identityLabel, onSignIn, onSignOut,
}: {
  count: number;
  sync: string;
  syncState: SyncState;
  hintVisible: boolean;
  overviewLabel: string | null;
  isAnonymous: boolean;
  identityLabel: string;
  onSignIn: () => void;
  onSignOut: () => void;
}) {
  return (
    <>
      {isAnonymous ? (
        <div className="chrome chrome-tr">
          <span className="count-num">{count}</span>
          <span className="count-lbl">notes</span>
        </div>
      ) : (
        <div className="chrome chrome-id">
          <span className="id-name">{identityLabel}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={onSignOut}
            aria-label="sign out"
            className="pointer-events-auto !px-2 font-mono text-[11px]"
          >
            sign out
          </Button>
        </div>
      )}
      <div className={"chrome chrome-br sync-status sync-" + syncState}>
        <span className="sync-dot" aria-hidden="true" />
        <span>{sync}</span>
      </div>
      <div className={
        "chrome chrome-bl"
        + (hintVisible || isAnonymous ? "" : " faded")
        + (isAnonymous ? " persistent" : "")
      }>
        {isAnonymous ? (
          <span className="hint">
            <Button
              variant="ghost"
              size="sm"
              onClick={onSignIn}
              className="pointer-events-auto !px-1 text-accent underline decoration-accent/40 underline-offset-4 hover:decoration-accent"
            >
              sign in
            </Button>
            {" "}to sync across devices
          </span>
        ) : (
          <span className="hint">
            <kbd>click</kbd> to write &nbsp;·&nbsp; <kbd>drag</kbd> to pan &nbsp;·&nbsp; <kbd>/</kbd> search &nbsp;·&nbsp; <kbd>z</kbd> overview &nbsp;·&nbsp; <kbd>?</kbd> help
          </span>
        )}
      </div>
      {overviewLabel && <div className="chrome chrome-mode">{overviewLabel}</div>}
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
    ["drag empty canvas",          "marquee select"],
    [[mod, "drag empty canvas"],   "pan"],
    ["scroll / trackpad",          "pan"],
    [[mod, "scroll"],              "zoom centered on cursor"],
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
