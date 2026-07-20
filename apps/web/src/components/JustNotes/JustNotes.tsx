import React, {
  forwardRef,
  lazy,
  Suspense,
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
  resolveNoteColor,
  NOTE_COLOR_KEYS,
  NOTE_COLOR_MAP,
  PAPER_W,
  PAPER_H,
  type Note,
  type NoteKind,
  type Board,
  type Tweaks,
} from "./lib";
import { FileTree } from "./FileTree";
// CodeMirror pulls in ~65KB gzipped; load it only when the focused editor
// opens so it never touches the initial bundle or the canvas cards.
const CmEditor = lazy(() => import("./CmEditor"));
import type { NotesByBoard } from "../../hooks/useAllNotes";
import { renderBody, renderHeadline, toggleTaskLine } from "./markdown";
import { formatCapturedNote } from "./clipboard";
import { clipboardOrigin } from "../../lib/clipboard-origin";
import { AmbientBar, Compass, TimeScrub } from "./cherries";
import { TweaksUI } from "./tweaks";
import { remoteStorage } from "../../lib/storage";
import { authClient, clearKeychainToken } from "../../lib/auth-client";
import { API_BASE_URL, isTauri } from "../../lib/runtime";
import { AuthPanel } from "../AuthPanel";
import { ApiTokensPanel } from "./api-tokens";
import { filterCommands, type Command } from "../../lib/commands";
import { Graveyard } from "./Graveyard";

type ResizeDir = "n" | "e" | "s" | "w" | "ne" | "nw" | "se" | "sw";

type Persist = {
  onCreate: (note: Note, opts?: { localOnly?: boolean }) => void | Promise<void>;
  onUpdate: (id: string, patch: Partial<Pick<Note, "x" | "y" | "w" | "h" | "t" | "text" | "kind" | "color">>) => void;
  onDelete: (id: string) => void;
};

export type JustNotesProps = Persist & {
  initialNotes: Note[];
  tweaks: Tweaks;
  setTweak: <K extends keyof Tweaks>(key: K, val: Tweaks[K]) => void;
  // Re-fetch server notes for the active board. Returns the current server
  // set; the canvas merges in any it doesn't already have (notes created on
  // another device or piped in by an agent). Optional so JustNotes can be
  // rendered without a live backend.
  refresh?: () => Promise<Note[]>;
  // File-tree navigation. `boards` + `notesByBoard` feed the left tree;
  // `onBoardJump` handles a click on a note that lives on another board
  // (switch there, then focus it via `focusNoteId` once that canvas mounts).
  boards: Board[];
  activeBoardId: string;
  notesByBoard: NotesByBoard;
  onBoardJump: (boardId: string, noteId: string) => void;
  focusNoteId?: string;
  onFocusConsumed: () => void;
  // File-tree "+": create a note under a board. Same board spawns here;
  // another board defers to the loader, which switches boards then spawns via
  // `spawnRequested` once that canvas mounts (mirrors the focus handoff).
  onBoardCreate: (boardId: string) => void;
  spawnRequested?: boolean;
  onSpawnConsumed: () => void;
  // File-tree board management (row click switches, header "+", rename/delete).
  onSwitchBoard: (id: string) => void;
  onCreateBoard: () => void;
  onRenameBoard: (id: string, name: string) => void;
  onDeleteBoard: (id: string) => void;
};

type View = { pan: { x: number; y: number }; zoom: number };

// Right edge of the left file-tree panel (CSS: 16px inset + 232px width) plus a
// gap. Used to keep note-focus jumps centered in the visible canvas, not behind
// the tree.
const FILE_TREE_EDGE = 264;

type UndoOp =
  | { type: "create"; id: string }
  | { type: "edit"; id: string; prevText: string; prevT: number }
  | { type: "delete"; note: Note }
  | { type: "move"; id: string; prevX: number; prevY: number };

// ── App ────────────────────────────────────────────────────────────────
export default function JustNotes(props: JustNotesProps) {
  const { initialNotes, tweaks: t, setTweak, onCreate: rawOnCreate, onUpdate: rawOnUpdate, onDelete: rawOnDelete, refresh, boards, activeBoardId, notesByBoard, onBoardJump, focusNoteId, onFocusConsumed, onBoardCreate, spawnRequested, onSpawnConsumed, onSwitchBoard, onCreateBoard, onRenameBoard, onDeleteBoard } = props;
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [tokensOpen, setTokensOpen] = useState(false);

  const [notes, setNotes] = useState<Note[]>(initialNotes);
  const notesRef = useRef(notes);
  useEffect(() => { notesRef.current = notes; }, [notes]);

  // Ids deleted this session. A background refresh() can race a just-issued
  // server soft-delete (list() may still return the row for a beat); the merge
  // consults this so a deleted note is never resurrected.
  const deletedRef = useRef<Set<string>>(new Set());

  // Pull in notes created out-of-band — another device, or an agent piping via
  // the MCP server. The app has no realtime channel, so we poll gently while
  // the tab is visible and refetch on focus. Only notes we don't already have
  // are merged: an in-progress edit/drag is never clobbered, and a just-deleted
  // note is never resurrected (deletedRef guards the soft-delete race).
  useEffect(() => {
    if (!refresh) return;
    let cancelled = false;
    const pull = async () => {
      if (document.hidden) return;
      const server = await refresh();
      if (cancelled || server.length === 0) return;
      setNotes((prev) => {
        const have = new Set(prev.map((n) => n.id));
        const additions = server.filter((n) => !have.has(n.id) && !deletedRef.current.has(n.id));
        return additions.length ? [...prev, ...additions] : prev;
      });
    };
    const onFocus = () => void pull();
    const onVisible = () => { if (!document.hidden) void pull(); };
    const id = window.setInterval(() => void pull(), 20000);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  // Merge server notes we don't already hold, without clobbering an in-progress
  // edit/drag or resurrecting a just-deleted note. Same guard as the background
  // pull; used by the agent-session reply listener for an immediate refresh.
  const mergeServer = useCallback((server: Note[]) => {
    if (!server.length) return;
    setNotes((prev) => {
      const have = new Set(prev.map((n) => n.id));
      const additions = server.filter((n) => !have.has(n.id) && !deletedRef.current.has(n.id));
      return additions.length ? [...prev, ...additions] : prev;
    });
  }, []);

  const [view, setView] = useState<View>({ pan: { x: 0, y: 0 }, zoom: 1 });
  const viewRef = useRef(view);
  useEffect(() => { viewRef.current = view; }, [view]);
  const [smooth, setSmooth] = useState(false);

  // Crisp text under zoom: promote the notes-layer (will-change) only while it's
  // actively moving, then drop the hint when it settles. Compositing keeps
  // pan/zoom smooth; dropping it makes Chrome re-rasterize the static text at
  // the exact current scale instead of stretching a cached texture (blur).
  const [moving, setMoving] = useState(false);
  const movingTimer = useRef<number | null>(null);
  const bumpMoving = (holdMs = 220) => {
    setMoving(true);
    if (movingTimer.current) clearTimeout(movingTimer.current);
    movingTimer.current = window.setTimeout(() => setMoving(false), holdMs);
  };
  useEffect(() => () => { if (movingTimer.current) clearTimeout(movingTimer.current); }, []);

  const [editingId, setEditingId] = useState<string | null>(null);
  const editingIdRef = useRef<string | null>(null);
  useEffect(() => { editingIdRef.current = editingId; }, [editingId]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // A note that just glided to a free spot after a drop (drives the snap CSS).
  const [snappingId, setSnappingId] = useState<string | null>(null);

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
  const [canvasMenu, setCanvasMenu] = useState<{ x: number; y: number; cx: number; cy: number } | null>(null);

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
  // Viewport point of the click that opened the current editor (a card click),
  // so the caret lands there. Null for tree jumps / new notes (caret → end).
  const editClickRef = useRef<{ x: number; y: number } | null>(null);
  const tweakRef = useRef<Tweaks>(t);
  useEffect(() => { tweakRef.current = t; }, [t]);

  // Center the canvas on first paint.
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
      bumpMoving();
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
    bumpMoving(460);
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

  function spawnAt(canvasX: number, canvasY: number, initialText = "", kind: NoteKind = "card") {
    const id = uid();
    const w = tweakRef.current.noteWidth;
    const spot = findFreeSpot(canvasX - w / 2, canvasY - 22);
    setNotes((ns) => [...ns, { id, x: spot.x, y: spot.y, w: null, h: null, t: Date.now(), text: initialText, kind, color: null }]);
    editSnapshotRef.current = { id, isNew: true, prevText: "", prevT: Date.now() };
    editClickRef.current = null; // new note → caret at end, not a stale click point
    setEditingId(id);
  }

  // Rects of every note but `excludeId`, for collision resolution on drop /
  // spawn. Position is the note's x/y; size is measured from the DOM.
  function measureRects(excludeId?: string) {
    const layer = canvasRef.current?.querySelector(".notes-layer");
    const rects: { x: number; y: number; w: number; h: number }[] = [];
    for (const n of notesRef.current) {
      if (n.id === excludeId) continue;
      const el = layer?.querySelector<HTMLElement>(`[data-note-id="${n.id}"]`);
      rects.push({
        x: n.x,
        y: n.y,
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
    const note: Note = { id, x, y, w: null, h: null, t: now, text, kind: "card", color: null };
    setNotes((ns) => [...ns, note]);
    pushOp({ type: "create", id });
    void onCreate(note, opts);
    enrichIfUrlNote(id);
    maybePromoteToPage(id);
    return id;
  }

  async function pasteAtCanvas(cx: number, cy: number) {
    let text = "";
    try {
      text = (await navigator.clipboard.readText()).trim();
    } catch {
      return; // clipboard blocked or empty — nothing to paste
    }
    if (!text) return;
    markInteracted();
    spawnCommitted(cx, cy, parsePastedUrl(text) ?? text);
  }

  // Import text/markdown files as notes at (cx,cy). The hidden input is clicked
  // synchronously inside the triggering user gesture so the picker isn't blocked.
  function openFilesAt(cx: number, cy: number) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,.markdown,.txt,.text,text/plain,text/markdown";
    input.multiple = true;
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      if (files.length) markInteracted();
      for (const file of files) {
        try {
          const text = (await file.text()).replace(/\r\n/g, "\n").trimEnd();
          if (text) spawnCommitted(cx, cy, text);
        } catch (err) {
          console.error("[open file] failed to read", file.name, err);
        }
      }
    };
    input.click();
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
    if (!cur) { setEditingId(null); editSnapshotRef.current = null; return; }

    // Empty notes are kept — a blank card just sits there until deleted via its
    // context menu. New notes persist on first commit; edits patch.
    const now = Date.now();
    if (snap?.isNew) pushOp({ type: "create", id });
    else if (snap && (snap.prevText !== cur.text)) pushOp({ type: "edit", id, prevText: snap.prevText, prevT: snap.prevT });
    setNotes((ns) => ns.map((n) => n.id === id ? { ...n, t: now } : n));
    if (snap?.isNew) {
      void onCreate({ ...cur, t: now });
    } else {
      onUpdate(id, { text: cur.text, t: now });
    }
    enrichIfUrlNote(id);
    setEditingId(null);
    editSnapshotRef.current = null;
    maybePromoteToPage(id);
  }

  function updateNoteText(id: string, text: string) {
    setNotes((ns) => ns.map((n) => n.id === id ? { ...n, text } : n));
  }

  function setNoteKind(id: string, kind: NoteKind) {
    // Clear w/h so the note takes the new kind's canonical size, not a stale resize.
    setNotes((ns) => ns.map((n) => n.id === id ? { ...n, kind, w: null, h: null } : n));
    onUpdate(id, { kind, w: null, h: null });
  }

  function setNoteColor(id: string, color: string | null) {
    setNotes((ns) => ns.map((n) => n.id === id ? { ...n, color } : n));
    onUpdate(id, { color });
  }

  // A card whose content overflows its height cap becomes a page — measured
  // from the DOM. Clears w/h so it takes the page's own (document) width, not
  // the narrow card width; page styling uncaps the height so it all shows.
  function maybePromoteToPage(id: string) {
    let done = false;
    const measure = () => {
      if (done) return;
      const cur = notesRef.current.find((n) => n.id === id);
      if (!cur || cur.kind !== "card" || editingIdRef.current === id) return;
      const el = canvasRef.current?.querySelector<HTMLElement>(`[data-note-id="${id}"]`);
      if (!el) return;
      // The card caps at max-height with overflow:hidden, so clipped content
      // makes scrollHeight exceed clientHeight.
      if (el.scrollHeight <= el.clientHeight + 4) return;
      done = true;
      setNotes((ns) => ns.map((n) => n.id === id ? { ...n, kind: "page", w: null, h: null } : n));
      onUpdate(id, { kind: "page", w: null, h: null });
      // A just-created note isn't synced yet, and onUpdate no-ops until its
      // create round-trips — re-persist once it's settled (unless the kind was
      // changed back in the meantime).
      window.setTimeout(() => {
        const c = notesRef.current.find((n) => n.id === id);
        if (c?.kind === "page") onUpdate(id, { kind: "page", w: c.w, h: c.h });
      }, 1500);
    };
    // Two frames to land after the card view has committed + laid out, then a
    // later pass to catch async content (shiki code, images) that grows it.
    requestAnimationFrame(() => requestAnimationFrame(measure));
    window.setTimeout(measure, 300);
  }

  // Toggle a task checkbox (`- [ ]` ⇄ `- [x]`) in a note and persist right
  // away — this happens outside an edit session, so it can't wait for commit.
  function toggleTask(id: string, taskIndex: number) {
    const cur = notesRef.current.find((n) => n.id === id);
    if (!cur) return;
    const nextText = toggleTaskLine(cur.text, taskIndex);
    if (nextText === cur.text) return;
    const now = Date.now();
    setNotes((ns) => ns.map((n) => n.id === id ? { ...n, text: nextText, t: now } : n));
    onUpdate(id, { text: nextText, t: now });
    markInteracted();
  }

  function deleteNoteById(id: string) {
    const cur = notesRef.current.find((n) => n.id === id);
    if (!cur) return;
    pushOp({ type: "delete", note: { ...cur } });
    deletedRef.current.add(id);
    setNotes((ns) => ns.filter((n) => n.id !== id));
    if (editingId === id) {
      setEditingId(null);
      editSnapshotRef.current = null;
    }
    onDelete(id);
  }

  function reinsertRestoredNote(note: { id: string; x: number; y: number; t: number; text: string; kind?: NoteKind; color?: string | null }) {
    setNotes((ns) => (ns.some((n) => n.id === note.id) ? ns : [...ns, { ...note, w: null, h: null, kind: note.kind ?? "card", color: note.color ?? null }]));
  }

  function startResize(e: React.PointerEvent<HTMLDivElement>, id: string, dir: ResizeDir) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const note = notesRef.current.find((n) => n.id === id);
    if (!note) return;
    const el = (e.currentTarget.parentElement as HTMLElement | null);
    const startW = note.w ?? el?.offsetWidth ?? tweakRef.current.noteWidth;
    const startH = note.h ?? el?.offsetHeight ?? 150;
    const startX = note.x, startY = note.y;
    const startSX = e.clientX, startSY = e.clientY;
    const pointerId = e.pointerId;
    const MIN_W = 120, MIN_H = 60;
    // The n/w edges resize toward the anchored (opposite) side, so the note's
    // origin shifts as it grows — clamped so it can't slide past the min size.
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const z = viewRef.current.zoom;
      const dx = (ev.clientX - startSX) / z;
      const dy = (ev.clientY - startSY) / z;
      let x = startX, y = startY, w = startW, h = startH;
      if (dir.includes("e")) w = Math.max(MIN_W, startW + dx);
      if (dir.includes("w")) { w = Math.max(MIN_W, startW - dx); x = startX + (startW - w); }
      if (dir.includes("s")) h = Math.max(MIN_H, startH + dy);
      if (dir.includes("n")) { h = Math.max(MIN_H, startH - dy); y = startY + (startH - h); }
      setNotes((ns) => ns.map((n) => n.id === id ? { ...n, x, y, w, h } : n));
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const cur = notesRef.current.find((n) => n.id === id);
      if (cur && (cur.w !== startW || cur.h !== startH || cur.x !== startX || cur.y !== startY)) {
        onUpdate(id, { x: cur.x, y: cur.y, w: cur.w, h: cur.h });
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
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

  // Pan+zoom the canvas onto a single note and center it in the visible area
  // (right of the file tree so the panel never covers it). Zooms to a gentle,
  // comfortable typing level — noticeably in from a zoomed-out view, but not so
  // close it feels cramped.
  function focusNoteForEdit(n: Note) {
    const p = { x: n.x, y: n.y };
    const NW = n.kind === "page" ? (n.w ?? PAPER_W) : (n.w ?? tweakRef.current.noteWidth);
    const NH = n.kind === "page" ? (n.h ?? PAPER_H) : (n.h ?? 220);
    const W = window.innerWidth, H = window.innerHeight;
    const fit = Math.min(((W - FILE_TREE_EDGE) * 0.7) / NW, (H * 0.7) / NH);
    const zoom = Math.max(0.9, Math.min(1.2, fit));
    const cx = p.x + NW / 2;
    const visibleCx = (FILE_TREE_EDGE + W) / 2;
    // Vertically: center a note that fits, but for one taller than the viewport
    // pin its top near the top edge so the *start* of the card is always in
    // view — centering a tall card/page pushes its beginning off the top.
    const TOP_INSET = 96;
    const panY = NH * zoom <= H - TOP_INSET - 40
      ? H / 2 - (p.y + NH / 2) * zoom
      : TOP_INSET - p.y * zoom;
    animateView({ pan: { x: visibleCx - cx * zoom, y: panY }, zoom });
  }

  // File-tree click on a note in the current board: fly to it (zoomed in to
  // type), select it, and drop into edit mode — the "take me there" jump.
  function jumpToNote(n: Note) {
    // Committing to this note — leave any overview so its framing/dimming
    // doesn't fight the focus (otherwise the jump lands under overview state).
    prevViewRef.current = null;
    editClickRef.current = null; // tree jump has no click point → caret at end
    setSelectedIds(new Set([n.id]));
    focusNoteForEdit(n);
    startEditingExisting(n.id);
  }

  // Tree click dispatcher: same board jumps directly; another board defers to
  // the loader, which switches boards then re-focuses via `focusNoteId`.
  function selectTreeNote(boardId: string, noteId: string) {
    if (boardId !== activeBoardId) { onBoardJump(boardId, noteId); return; }
    const n = notesRef.current.find((x) => x.id === noteId);
    if (n) jumpToNote(n);
  }

  // Tree "+" dispatcher: same board spawns a note now; another board defers to
  // the loader, which switches boards then spawns via `spawnRequested`.
  function createTreeNote(boardId: string) {
    if (boardId !== activeBoardId) { onBoardCreate(boardId); return; }
    spawnAtCenter("");
  }

  // Mark/unmark the current board as a live agent session (desktop watcher).
  function toggleLiveBoard() {
    const cur = tweakRef.current.liveBoards ?? [];
    const next = cur.includes(activeBoardId)
      ? cur.filter((id) => id !== activeBoardId)
      : [...cur, activeBoardId];
    setTweak("liveBoards", next);
  }

  // Composer: drop your next turn as a user note below the thread, then fly to
  // it. The Composer surfaces on boards that already hold an agent reply.
  function sendComposerTurn(text: string) {
    const t = text.trim();
    if (!t) return;
    markInteracted();
    const last = notesRef.current.reduce<Note | null>((m, n) => (!m || n.t > m.t ? n : m), null);
    const base = last
      ? { x: last.x, y: last.y + 340 }
      : screenToCanvas(window.innerWidth / 2, window.innerHeight / 2);
    const id = spawnCommitted(base.x, base.y, t);
    requestAnimationFrame(() => {
      const n = notesRef.current.find((nn) => nn.id === id);
      if (n) flyTo(n);
    });
  }

  // Consume a pending cross-board create once this board's canvas has mounted.
  const spawnHandledRef = useRef(false);
  useEffect(() => {
    if (!spawnRequested || spawnHandledRef.current) return;
    spawnHandledRef.current = true;
    spawnAtCenter("");
    onSpawnConsumed();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spawnRequested]);

  // Consume a pending cross-board focus once this board's notes are present.
  const focusHandledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusNoteId || focusHandledRef.current === focusNoteId) return;
    const n = notesRef.current.find((x) => x.id === focusNoteId);
    if (!n) return; // notes for the new board may not have merged yet
    focusHandledRef.current = focusNoteId;
    jumpToNote(n);
    onFocusConsumed();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNoteId, notes]);
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
  function fitToScreen() {
    if (!notesRef.current.length) return;
    if (!prevViewRef.current) prevViewRef.current = viewRef.current;
    frameNotes(notesRef.current);
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

  // Pointer Events so touch works alongside mouse: one contact pans (⌘/Ctrl +
  // drag marquee-selects on mouse), two contacts pinch-zoom. A second finger
  // joins the in-flight gesture via canvasGestureRef rather than starting a new
  // one. All contacts share canvasPtrs (id → live screen point).
  const canvasPtrs = useRef<Map<number, { x: number; y: number }>>(new Map());
  const canvasGestureRef = useRef<((id: number, x: number, y: number) => void) | null>(null);

  const onCanvasPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (!target.dataset.canvas) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;

    // A second contact upgrades the running gesture to a pinch.
    if (canvasGestureRef.current) {
      e.preventDefault();
      canvasGestureRef.current(e.pointerId, e.clientX, e.clientY);
      return;
    }

    e.preventDefault();
    if (e.detail > 1) return; // ignore the 2nd+ of a multi-click
    markInteracted();

    const ptrs = canvasPtrs.current;
    ptrs.clear();
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const startCanvas = screenToCanvas(e.clientX, e.clientY);
    let mode: "pan" | "marquee" | "pinch" =
      e.pointerType === "mouse" && (e.metaKey || e.ctrlKey) ? "marquee" : "pan";
    let startSX = e.clientX, startSY = e.clientY;
    let startPan = { ...viewRef.current.pan };
    let moved = false;
    let pinch: { startDist: number; startZoom: number; midCanvas: { x: number; y: number }; ids: [number, number] } | null = null;

    // Called on the second pointer-down: switch this gesture to pinch.
    canvasGestureRef.current = (id, x, y) => {
      ptrs.set(id, { x, y });
      if (ptrs.size < 2) return;
      const [a, b] = [...ptrs.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      pinch = {
        startDist: dist,
        startZoom: viewRef.current.zoom,
        midCanvas: screenToCanvas((a.x + b.x) / 2, (a.y + b.y) / 2),
        ids: [...ptrs.keys()].slice(-2) as [number, number],
      };
      mode = "pinch";
      moved = true;
      setMarquee(null);
    };

    const onMove = (ev: PointerEvent) => {
      if (!ptrs.has(ev.pointerId)) return;
      ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (mode === "pinch" && pinch) {
        const a = ptrs.get(pinch.ids[0]), b = ptrs.get(pinch.ids[1]);
        if (!a || !b) return;
        const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const midSX = (a.x + b.x) / 2, midSY = (a.y + b.y) / 2;
        const nz = Math.max(0.32, Math.min(2.5, pinch.startZoom * (dist / pinch.startDist)));
        bumpMoving();
        setView({ zoom: nz, pan: { x: midSX - pinch.midCanvas.x * nz, y: midSY - pinch.midCanvas.y * nz } });
        return;
      }
      const dx = ev.clientX - startSX, dy = ev.clientY - startSY;
      if (!moved && dx * dx + dy * dy > 9) moved = true;
      if (!moved) return;
      if (mode === "marquee") {
        const cur = screenToCanvas(ev.clientX, ev.clientY);
        setMarquee({
          x0: Math.min(startCanvas.x, cur.x), y0: Math.min(startCanvas.y, cur.y),
          x1: Math.max(startCanvas.x, cur.x), y1: Math.max(startCanvas.y, cur.y),
        });
      } else {
        bumpMoving();
        setView((v) => ({ ...v, pan: { x: startPan.x + dx, y: startPan.y + dy } }));
      }
    };

    const onUp = (ev: PointerEvent) => {
      if (!ptrs.has(ev.pointerId)) return;
      ptrs.delete(ev.pointerId);
      // One finger lifted mid-pinch → keep panning with the remaining contact.
      if (mode === "pinch" && ptrs.size === 1) {
        const [p] = [...ptrs.values()];
        mode = "pan"; pinch = null; moved = true;
        startSX = p.x; startSY = p.y; startPan = { ...viewRef.current.pan };
        return;
      }
      if (ptrs.size > 0) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      canvasGestureRef.current = null;
      if (mode === "marquee") {
        const cur = screenToCanvas(ev.clientX, ev.clientY);
        const m = {
          x0: Math.min(startCanvas.x, cur.x), y0: Math.min(startCanvas.y, cur.y),
          x1: Math.max(startCanvas.x, cur.x), y1: Math.max(startCanvas.y, cur.y),
        };
        const w = tweakRef.current.noteWidth, h = 150;
        const hit = new Set<string>();
        for (const n of notesRef.current) {
          if (n.x + w >= m.x0 && n.x <= m.x1 && n.y + h >= m.y0 && n.y <= m.y1) hit.add(n.id);
        }
        setSelectedIds(hit);
        setMarquee(null);
        return;
      }
      if (!moved) {
        // A tap on empty canvas only dismisses transient state.
        if (prevViewRef.current) { animateView(prevViewRef.current); prevViewRef.current = null; return; }
        if (editingId) { commitEditing(); return; }
        if (ambientOpen) { closeAmbient(); return; }
        if (selectedIdsRef.current.size > 0) { setSelectedIds(new Set()); return; }
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId, ambientOpen]);

  const onNoteMouseDown = useCallback((e: React.PointerEvent<HTMLDivElement>, id: string) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (editingId === id) return;
    e.stopPropagation();
    markInteracted();
    const note = notesRef.current.find((n) => n.id === id);
    if (!note) return;
    const isSelected = selectedIdsRef.current.has(id);
    const groupIds: string[] = isSelected ? Array.from(selectedIdsRef.current) : [id];
    // A drag moves the grabbed card(s)' real x/y — only them, no reflow.
    const startPositions = new Map<string, { x: number; y: number }>();
    for (const nid of groupIds) {
      const n = notesRef.current.find((x) => x.id === nid);
      if (!n) continue;
      startPositions.set(nid, { x: n.x, y: n.y });
    }
    const startSX = e.clientX, startSY = e.clientY;
    const pointerId = e.pointerId;
    let moved = false;
    setDraggingId(id);

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
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
      setNotes((ns) => ns.map((n) => {
        const sp = startPositions.get(n.id);
        return sp ? { ...n, ...at(sp) } : n;
      }));
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setDraggingId(null);
      if (!moved) {
        // Single click drops straight into editing the note in place (a drag,
        // handled below, moves it instead). startEditingExisting commits any
        // other open editor first. Remember where the click landed so the caret
        // opens there rather than jumping to the end of the text.
        if (ambientOpen) closeAmbient();
        setSelectedIds(new Set([id]));
        editClickRef.current = { x: startSX, y: startSY };
        startEditingExisting(id);
        return;
      }
      // Single-card drops snap to the nearest free spot so cards never stack.
      const el = canvasRef.current?.querySelector<HTMLElement>(`[data-note-id="${id}"]`);
      const selfW = el?.offsetWidth ?? note.w ?? tweakRef.current.noteWidth;
      const selfH = el?.offsetHeight ?? note.h ?? 96;
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
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
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
      id: "api-tokens",
      label: "API tokens",
      hint: "let an agent pipe notes here",
      run: () => setTokensOpen(true),
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
        else if (canvasMenu) setCanvasMenu(null);
        else if (selectedIdsRef.current.size > 0) setSelectedIds(new Set());
        else if (graveyardOpen) setGraveyardOpen(false);
        else if (authPanelOpen) setAuthPanelOpen(false);
        else if (tokensOpen) setTokensOpen(false);
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
  }, [editingId, ambientOpen, helpOpen, tweaksOpen, authPanelOpen, graveyardOpen, contextMenu, canvasMenu, recallQuery, recallIdx, matchIds]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  // Desktop: files opened via the OS ("Open with" / double-click a .md/.txt)
  // are read by the Rust side and buffered; drain them here on mount and on
  // each ping, dropping a note per file near the canvas centre.
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const [{ invoke }, { listen }] = await Promise.all([
        import("@tauri-apps/api/core"),
        import("@tauri-apps/api/event"),
      ]);
      if (cancelled) return;
      const drain = async () => {
        const contents = await invoke<string[]>("take_opened_files");
        contents.forEach((raw, idx) => {
          const c = screenToCanvas(window.innerWidth / 2 + idx * 30, window.innerHeight / 2 + idx * 30);
          spawnCommitted(c.x, c.y, raw.replace(/\r\n/g, "\n").trimEnd());
        });
        if (contents.length) markInteracted();
      };
      await drain();
      unlisten = await listen("open-file://pending", () => void drain());
    })();
    return () => { cancelled = true; unlisten?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Desktop agent sessions. The Rust watcher answers new turns on the boards the
  // user marked live; keep it in sync with the persisted list. Empty → stop.
  const liveBoards = t.liveBoards ?? [];
  const liveKey = liveBoards.join(",");
  useEffect(() => {
    if (!isTauri) return;
    void import("@tauri-apps/api/core").then(({ invoke }) => {
      if (liveBoards.length === 0) {
        void invoke("agent_sessions_stop");
      } else {
        void invoke("agent_sessions_start", { url: API_BASE_URL, boards: liveBoards });
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKey]);

  // When the watcher posts a reply, pull it onto the canvas at once (instead of
  // waiting for the 20s background refresh) — but only if that board is on screen.
  useEffect(() => {
    if (!isTauri || !refresh) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      if (cancelled) return;
      unlisten = await listen<string>("agent-sessions://replied", async (e) => {
        if (e.payload !== activeBoardId) return;
        const server = await refresh();
        if (!cancelled) mergeServer(server);
      });
    })();
    return () => { cancelled = true; unlisten?.(); };
  }, [refresh, activeBoardId, mergeServer]);

  // Surface watcher failures (e.g. a wrong claude path, or claude erroring out).
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      if (cancelled) return;
      unlisten = await listen<string>("agent-sessions://error", (e) => {
        console.error("[agent-sessions]", e.payload);
      });
    })();
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // ── Render ─────────────────────────────────────────────────────────
  // Overview = zoomed way out, or entered via z (can settle at zoom≈1 for a
  // tight cluster). prevViewRef flips alongside a setView, so it's safe here.
  const inOverview = view.zoom < 0.95 || prevViewRef.current != null;

  // Viewport culling: with hundreds of notes, mounting every card tanks pan/zoom.
  // Render only cards whose (over-estimated) box intersects the viewport plus a
  // buffer; the active/dragged/selected notes always render so interactions never
  // break. `viewportTick` re-runs this on resize (window dims are read live).
  const [viewportTick, setViewportTick] = useState(0);
  useEffect(() => {
    const onResize = () => setViewportTick((v) => v + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const visibleNotes = useMemo(() => {
    const W = window.innerWidth, H = window.innerHeight;
    const z = view.zoom;
    const MARGIN = 500;
    const left = -view.pan.x / z - MARGIN;
    const top = -view.pan.y / z - MARGIN;
    const right = (W - view.pan.x) / z + MARGIN;
    const bottom = (H - view.pan.y) / z + MARGIN;
    return notes.filter((n) => {
      if (n.id === editingId || n.id === draggingId || selectedIds.has(n.id)) return true;
      const w = n.kind === "page" ? (n.w ?? PAPER_W) : (n.w ?? t.noteWidth);
      const h = n.kind === "page" ? (n.h ?? PAPER_H) : (n.h ?? 500);
      return n.x < right && n.x + w > left && n.y < bottom && n.y + h > top;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes, view, editingId, draggingId, selectedIds, t.noteWidth, viewportTick]);

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

  // Persistent conversation spine: on a board that holds agent replies, tie each
  // reply back to the turn it answers (its nearest preceding non-agent note),
  // reusing the relation-thread visual. Always on — it's what makes the board
  // read as a thread, not the hover-gated tag relations.
  const replyThreads = useMemo(() => {
    if (!notes.some((n) => n.role === "assistant")) return [];
    const ordered = [...notes].sort((a, b) => a.t - b.t);
    const center = (n: Note) => ({
      x: n.x + (n.w ?? t.noteWidth) / 2,
      y: n.y + (n.h ?? 56) / 2,
    });
    const out: { id: string; d: string }[] = [];
    for (let i = 0; i < ordered.length; i++) {
      const ans = ordered[i];
      if (ans.role !== "assistant") continue;
      let q: Note | null = null;
      for (let j = i - 1; j >= 0; j--) {
        if (ordered[j].role !== "assistant") { q = ordered[j]; break; }
      }
      if (!q) continue;
      const a = center(q), b = center(ans);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const bow = Math.min(48, len * 0.14);
      const cx = mx + (-dy / len) * bow, cy = my + (dx / len) * bow;
      out.push({ id: ans.id, d: `M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x} ${b.y}` });
    }
    return out;
  }, [notes, t.noteWidth]);

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
        onPointerDown={onCanvasPointerDown}
        onContextMenu={(e) => {
          // Notes stop propagation and open their own menu, so anything that
          // reaches here is empty canvas. Stop propagation so this event
          // doesn't bubble to an open menu's window-level dismiss listener,
          // which would close the menu we're about to open.
          e.preventDefault();
          e.stopPropagation();
          markInteracted();
          const c = screenToCanvas(e.clientX, e.clientY);
          setContextMenu(null);
          setCanvasMenu({ x: e.clientX, y: e.clientY, cx: c.x, cy: c.y });
        }}
      >
        <div
          className={"notes-layer" + (smooth ? " smooth" : "") + (moving ? " moving" : "") + (inOverview ? " overview" : "")}
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
          {replyThreads.length > 0 && (
            <svg className="relation-threads reply-threads" aria-hidden="true">
              {replyThreads.map((th) => (
                <path key={th.id} d={th.d} pathLength={1} />
              ))}
            </svg>
          )}
          {relationThreads.length > 0 && (
            <svg className="relation-threads" aria-hidden="true">
              {relationThreads.map((th) => (
                <path key={th.id} d={th.d} pathLength={1} />
              ))}
            </svg>
          )}
          {visibleNotes.map((n) => (
            <NoteCard
              key={n.id}
              note={n}
              pos={{ x: n.x, y: n.y }}
              fromClipboard={clipboardIds.has(n.id)}
              onHover={onNoteHover}
              editing={editingId === n.id}
              dragging={draggingId === n.id}
              snapping={snappingId === n.id}
              dimmed={!!matchSet && !matchSet.has(n.id)}
              highlit={!!matchSet && matchSet.has(n.id)}
              focused={!!matchIds && matchIds[recallIdx] === n.id}
              selected={selectedIds.has(n.id)}
              scrubFade={scrubFadeFor(n)}
              onPointerDown={(e) => onNoteMouseDown(e, n.id)}
              clickPos={editingId === n.id ? editClickRef.current : null}
              onTextChange={(v) => updateNoteText(n.id, v)}
              onCommitEdit={commitEditing}
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
              onToggleTask={toggleTask}
            />
          ))}
        </div>
      </Canvas>

      {notes.length === 0 && <GhostCard />}

      <FileTree
        boards={boards}
        activeBoardId={activeBoardId}
        liveNotes={notes}
        notesByBoard={notesByBoard}
        selectedIds={selectedIds}
        onSelectNote={selectTreeNote}
        onCreateNote={createTreeNote}
        onSwitchBoard={onSwitchBoard}
        onCreateBoard={onCreateBoard}
        onRenameBoard={onRenameBoard}
        onDeleteBoard={onDeleteBoard}
      />

      <Toolbar
        onNewNote={() => { markInteracted(); spawnAtCenter(""); }}
        onSearch={() => { markInteracted(); openAmbient(""); }}
        overviewActive={inOverview}
        onOverview={() => { markInteracted(); toggleOverview(); }}
        relationsActive={relationsOn}
        onRelations={() => { markInteracted(); setRelationsOn((v) => !v); }}
        agentSessionShow={isTauri}
        agentSessionActive={liveBoards.includes(activeBoardId)}
        onAgentSession={() => { markInteracted(); toggleLiveBoard(); }}
        onGraveyard={() => setGraveyardOpen(true)}
        onTweaks={() => setTweaksOpen(true)}
        onHelp={() => setHelpOpen(true)}
        isAnonymous={isAnonymous}
        identityLabel={identityLabel}
        onAccount={() => setAuthPanelOpen(true)}
        count={notes.length}
        sync={syncLabel(online, lastWriteAt, nowTick)}
        syncState={!online ? "offline" : lastWriteAt && Date.now() - lastWriteAt < 4000 ? "writing" : "synced"}
      />

      <AuthPanel
        open={authPanelOpen}
        onClose={() => setAuthPanelOpen(false)}
        hasGoogle={hasGoogle}
        signedIn={!isAnonymous}
        identityLabel={identityLabel}
        accountEmail={user?.email}
        onSignOut={() => { void onSignOut(); setAuthPanelOpen(false); }}
        onApiTokens={() => { setAuthPanelOpen(false); setTokensOpen(true); }}
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

      {notes.some((n) => n.role === "assistant") && !editingId && (
        <Composer onSend={sendComposerTurn} />
      )}

      {t.compass && <Compass notes={notes} view={view} flyHome={flyHome} />}

      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}

      {contextMenu && (() => {
        const n = notes.find((x) => x.id === contextMenu.id);
        return (
          <NoteContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            kind={n?.kind ?? "card"}
            color={n?.color ?? null}
            onSetKind={(k) => setNoteKind(contextMenu.id, k)}
            onSetColor={(c) => setNoteColor(contextMenu.id, c)}
            onClose={() => setContextMenu(null)}
            onDelete={() => {
              const id = contextMenu.id;
              setContextMenu(null);
              deleteNoteById(id);
            }}
          />
        );
      })()}

      {canvasMenu && (
        <CanvasContextMenu
          x={canvasMenu.x}
          y={canvasMenu.y}
          hasNotes={notes.length > 0}
          onClose={() => setCanvasMenu(null)}
          onNew={(k) => { markInteracted(); spawnAt(canvasMenu.cx, canvasMenu.cy, "", k); setCanvasMenu(null); }}
          onPaste={() => { void pasteAtCanvas(canvasMenu.cx, canvasMenu.cy); setCanvasMenu(null); }}
          onOpenFile={() => { openFilesAt(canvasMenu.cx, canvasMenu.cy); setCanvasMenu(null); }}
          onSelectAll={() => { setSelectedIds(new Set(notesRef.current.map((n) => n.id))); setCanvasMenu(null); }}
          onFit={() => { fitToScreen(); setCanvasMenu(null); }}
        />
      )}

      <Graveyard
        open={graveyardOpen}
        onClose={() => setGraveyardOpen(false)}
        onRestored={(n) => reinsertRestoredNote(n)}
      />

      <TweaksUI t={t} setTweak={setTweak} open={tweaksOpen} onClose={() => setTweaksOpen(false)} />

      <ApiTokensPanel open={tokensOpen} onClose={() => setTokensOpen(false)} />
    </div>
  );
}

// ── Canvas ─────────────────────────────────────────────────────────────
type CanvasProps = {
  pan: { x: number; y: number };
  zoom: number;
  grid: Tweaks["grid"];
  smooth: boolean;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => void;
  children: React.ReactNode;
};

const Canvas = forwardRef<HTMLDivElement, CanvasProps>(function Canvas(
  { pan, zoom, grid, smooth, onPointerDown, onContextMenu, children },
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
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
    >
      {children}
    </div>
  );
});

// ── NoteCard ───────────────────────────────────────────────────────────
function NoteCard({
  note, pos, fromClipboard, editing, dragging, snapping,
  dimmed, highlit, focused, selected, scrubFade,
  onPointerDown, onTextChange, onCommitEdit, onContextMenu, onTagClick, onResizeStart, onHover, onToggleTask, clickPos,
}: {
  note: Note;
  pos: { x: number; y: number };
  fromClipboard: boolean;
  onHover: (id: string | null) => void;
  editing: boolean;
  dragging: boolean;
  snapping: boolean;
  dimmed: boolean;
  highlit: boolean;
  focused: boolean;
  selected: boolean;
  scrubFade: number;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onTextChange: (v: string) => void;
  onCommitEdit: () => void;
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => void;
  onTagClick: (tag: string) => void;
  onResizeStart: (e: React.PointerEvent<HTMLDivElement>, dir: ResizeDir) => void;
  onToggleTask: (id: string, taskIndex: number) => void;
  clickPos?: { x: number; y: number } | null;
}) {
  const rec = recencyOf(note.t);

  const first = firstNonEmpty(note.text);
  const rest = restAfterFirst(note.text);
  const headingMatch = first.trim().match(/^(#{1,6})\s+/);
  const headingLevel = headingMatch ? Math.min(headingMatch[1].length, 3) : 0;
  const isHeading = headingLevel > 0;
  // When the note opens with a block (code fence, list, task, quote, ordered
  // item, rule, or image), render the whole text through renderBody rather
  // than treating the first line as a headline — otherwise a task list's
  // first item becomes an un-checkable title and the toggle indices drift.
  const startsWithBlock = /^\s*(`{3,}|>|[-*]\s+\[[ xX]\]|[-*]\s|\d+\.\s|!\[[^\]]*\]\(|(-{3,}|\*{3,})\s*$)/.test(first);
  const onToggle = (taskIndex: number) => onToggleTask(note.id, taskIndex);

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
    `kind-${note.kind}`,
    note.color ? "tinted" : "",
    note.role === "assistant" ? "role-assistant" : "",
    isHeading && !editing ? "has-heading" : "",
  ].filter(Boolean).join(" ");

  // A tinted note carries its own bg/ink and opts out of the recency fade so
  // the color stays true; the fade only applies to plain cards.
  const col = resolveNoteColor(note.color);
  // Body text: on a tinted note follow its ink (the theme's text-secondary is
  // unreadable on a light tint); otherwise the usual dimmed secondary.
  const bodyColor = col ? `rgb(${col.ink})` : "rgb(var(--text-secondary))";
  const style: CSSProperties = {
    left: pos.x,
    top: pos.y,
    backgroundColor: col ? col.bg : "rgb(var(--bg-secondary))",
    color: col ? `rgb(${col.ink})` : "rgb(var(--text-primary))",
    opacity: (note.kind === "card" && !col ? RECENCY_ALPHA[rec] : 1) * (scrubFade ?? 1),
  };
  // Exposed so a tinted note can re-point the muted theme tokens at its ink,
  // keeping list/quote/mark colors legible in both the rendered view and editor.
  if (col) (style as Record<string, string | number>)["--note-ink"] = col.ink;
  if (note.kind === "page") {
    style.width = note.w ?? PAPER_W;
    style.minHeight = note.h ?? 200;
  } else {
    // card: resizable, else content-height from CSS.
    if (note.w != null) style.width = note.w;
    if (note.h != null) {
      style.maxHeight = "none";
      if (!editing) style.height = note.h;
    }
  }

  return (
    <div
      className={cls}
      data-note-id={note.id}
      style={style}
      onPointerDown={(e) => {
        const target = e.target as HTMLElement;
        const tagEl = target.closest("[data-tag]") as HTMLElement | null;
        if (tagEl && !editing) {
          e.stopPropagation();
          e.preventDefault();
          const tag = tagEl.dataset.tag;
          if (tag) onTagClick(tag);
          return;
        }
        onPointerDown(e);
      }}
      onMouseEnter={() => onHover(note.id)}
      onMouseLeave={() => onHover(null)}
      onContextMenu={onContextMenu}
    >
      {editing ? (
        <Suspense fallback={<div className="note-cm note-cm-loading" />}>
          <CmEditor
            value={note.text}
            onChange={onTextChange}
            onCommit={onCommitEdit}
            className="note-cm"
            clickPos={clickPos}
          />
        </Suspense>
      ) : startsWithBlock ? (
        <div className="note-rest" style={{ color: bodyColor }}>
          {renderBody(note.text, { onToggle })}
        </div>
      ) : (
        <>
          {first
            ? <div className={"note-first" + (headingLevel ? ` md-h md-h${headingLevel}` : "")}>{renderHeadline(first)}</div>
            : <div className="note-first" style={{ opacity: 0.35 }}>empty</div>}
          {rest && <div className="note-rest" style={{ color: bodyColor }}>{renderBody(rest, { onToggle })}</div>}
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
      {!editing && note.role === "assistant" && (
        <div className="note-agent" title="agent reply" aria-label="agent reply">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9z" />
          </svg>
          agent
        </div>
      )}
      {!editing && <div className="note-pad-cover" aria-hidden="true" />}
      {!editing && (["n", "e", "s", "w", "ne", "nw", "se", "sw"] as const).map((dir) => (
        <div
          key={dir}
          className={`note-edge note-edge-${dir}`}
          aria-hidden="true"
          onPointerDown={(e) => onResizeStart(e, dir)}
        />
      ))}
      {/* Touch: a visible, finger-sized corner grip (the thin edges are too
          fiddly on a phone). Hidden on desktop, where hover + edges suffice. */}
      {!editing && (
        <div
          className="note-grip"
          aria-label="resize"
          onPointerDown={(e) => onResizeStart(e, "se")}
        />
      )}
    </div>
  );
}

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
  agent: svg(<path d="M12 3l1.5 5.2L18.5 10l-5 1.8L12 17l-1.5-5.2L5.5 10l5-1.8z" />, true),
};

function TbBtn({ label, active, dot, onClick, children }: {
  label: string; active?: boolean; dot?: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={"tb-btn" + (active ? " active" : "") + (dot ? " signed-in" : "")}
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
      {dot && <span className="tb-dot" aria-hidden="true" />}
    </button>
  );
}

type ToolbarProps = {
  onNewNote: () => void;
  onSearch: () => void;
  overviewActive: boolean;
  onOverview: () => void;
  relationsActive: boolean;
  onRelations: () => void;
  agentSessionShow: boolean;
  agentSessionActive: boolean;
  onAgentSession: () => void;
  onGraveyard: () => void;
  onTweaks: () => void;
  onHelp: () => void;
  isAnonymous: boolean;
  identityLabel: string;
  onAccount: () => void;
  count: number;
  sync: string;
  syncState: SyncState;
};

function Toolbar(p: ToolbarProps) {
  return (
    <div className="chrome toolbar" role="toolbar" aria-label="tools">
      <TbBtn label="New note" onClick={p.onNewNote}>{TB_ICON.plus}</TbBtn>
      <TbBtn label="Search" onClick={p.onSearch}>{TB_ICON.search}</TbBtn>
      <TbBtn label="Overview" active={p.overviewActive} onClick={p.onOverview}>{TB_ICON.overview}</TbBtn>
      <TbBtn label="Relations" active={p.relationsActive} onClick={p.onRelations}>{TB_ICON.relations}</TbBtn>
      {p.agentSessionShow && (
        <TbBtn
          label={p.agentSessionActive ? "Live agent session · on (click to stop)" : "Make this board a live agent session"}
          active={p.agentSessionActive}
          onClick={p.onAgentSession}
        >
          {TB_ICON.agent}
        </TbBtn>
      )}
      <TbBtn label="Recently deleted" onClick={p.onGraveyard}>{TB_ICON.graveyard}</TbBtn>

      <div className="tb-sep" aria-hidden="true" />

      <TbBtn label="Settings" onClick={p.onTweaks}>{TB_ICON.tweaks}</TbBtn>
      <TbBtn label="Help" onClick={p.onHelp}>{TB_ICON.help}</TbBtn>
      <TbBtn
        label={p.isAnonymous ? "Sign in to sync" : `Signed in as ${p.identityLabel || "you"}`}
        dot={!p.isAnonymous}
        onClick={p.onAccount}
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
// A chat-style input pinned to the bottom of a conversation board. Enter sends
// the turn (Shift+Enter for a newline); keys are stopped from reaching the
// canvas shortcuts. Autogrows up to a few lines.
function Composer({ onSend }: { onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement | null>(null);

  function grow(el: HTMLTextAreaElement | null) {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }

  function submit() {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText("");
    requestAnimationFrame(() => grow(ref.current));
  }

  return (
    <div className="composer chrome">
      <textarea
        ref={ref}
        className="composer-input"
        value={text}
        rows={1}
        placeholder="message the agent…"
        onChange={(e) => {
          setText(e.target.value);
          grow(e.target);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button
        className="composer-send"
        onClick={submit}
        disabled={!text.trim()}
        aria-label="send turn"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7 11l5-5 5 5" />
          <path d="M12 6v13" />
        </svg>
      </button>
    </div>
  );
}

function HelpOverlay({ onClose }: { onClose: () => void }) {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  const mod = isMac ? "⌘" : "Ctrl";
  type Row = [string | string[], string];
  const rows: Row[] = [
    ["right-click empty canvas",   "menu · new note here, paste, select all, fit"],
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

const NOTE_KINDS: NoteKind[] = ["card", "page"];

function NoteContextMenu({
  x, y, kind, color, onSetKind, onSetColor, onClose, onDelete,
}: {
  x: number; y: number;
  kind: NoteKind; color: string | null;
  onSetKind: (k: NoteKind) => void;
  onSetColor: (c: string | null) => void;
  onClose: () => void; onDelete: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // pointerdown (not mousedown) so an outside tap on touch dismisses too.
    const onDocDown = (e: Event) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", onDocDown);
    window.addEventListener("contextmenu", onDocDown);
    return () => {
      window.removeEventListener("pointerdown", onDocDown);
      window.removeEventListener("contextmenu", onDocDown);
    };
  }, [onClose]);

  const W = 184, H = 176;
  const left = Math.min(x, window.innerWidth - W - 8);
  const top = Math.min(y, window.innerHeight - H - 8);

  return (
    <div
      ref={menuRef}
      className="note-ctx"
      style={{ left, top }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="note-ctx-label">Type</div>
      <div className="note-ctx-types" role="radiogroup" aria-label="note type">
        {NOTE_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={k === kind}
            className={"note-ctx-type" + (k === kind ? " active" : "")}
            onClick={() => onSetKind(k)}
          >
            {k}
          </button>
        ))}
      </div>
      <div className="note-ctx-colors" role="radiogroup" aria-label="note color">
        <button
          type="button"
          role="radio"
          aria-checked={!color}
          aria-label="default"
          title="default"
          className={"note-ctx-swatch note-ctx-swatch-none" + (!color ? " active" : "")}
          onClick={() => onSetColor(null)}
        />
        {NOTE_COLOR_KEYS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={color === c}
            aria-label={c}
            title={c}
            className={"note-ctx-swatch" + (color === c ? " active" : "")}
            style={{ background: NOTE_COLOR_MAP[c].bg }}
            onClick={() => onSetColor(c)}
          />
        ))}
      </div>
      <div className="note-ctx-sep" aria-hidden="true" />
      <button className="note-ctx-item danger" onClick={onDelete}>
        delete
        <span className="note-ctx-hint">⌘Z to undo</span>
      </button>
    </div>
  );
}

function CanvasContextMenu({
  x, y, hasNotes, onClose, onNew, onPaste, onOpenFile, onSelectAll, onFit,
}: {
  x: number; y: number; hasNotes: boolean;
  onClose: () => void;
  onNew: (k: NoteKind) => void;
  onPaste: () => void;
  onOpenFile: () => void;
  onSelectAll: () => void;
  onFit: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // pointerdown (not mousedown) so an outside tap on touch dismisses too.
    const onDocDown = (e: Event) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) onClose();
    };
    // Attach on the next tick so the right-click/long-press that opened this
    // menu — still propagating to window — can't be caught here and self-dismiss.
    const id = setTimeout(() => {
      window.addEventListener("pointerdown", onDocDown);
      window.addEventListener("contextmenu", onDocDown);
    }, 0);
    return () => {
      clearTimeout(id);
      window.removeEventListener("pointerdown", onDocDown);
      window.removeEventListener("contextmenu", onDocDown);
    };
  }, [onClose]);

  const W = 184, H = 224;
  const left = Math.min(x, window.innerWidth - W - 8);
  const top = Math.min(y, window.innerHeight - H - 8);

  return (
    <div
      ref={menuRef}
      className="note-ctx"
      style={{ left, top }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="note-ctx-label">New here</div>
      <div className="note-ctx-types" role="group" aria-label="new note type">
        {NOTE_KINDS.map((k) => (
          <button key={k} type="button" className="note-ctx-type" onClick={() => onNew(k)}>
            {k}
          </button>
        ))}
      </div>
      <div className="note-ctx-sep" aria-hidden="true" />
      <button className="note-ctx-item" onClick={onPaste}>paste here</button>
      <button className="note-ctx-item" onClick={onOpenFile}>open file…</button>
      <button className="note-ctx-item" onClick={onSelectAll} disabled={!hasNotes}>select all</button>
      <button className="note-ctx-item" onClick={onFit} disabled={!hasNotes}>fit to screen</button>
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
      <div className="ghost-text">tap + to add a note · or right-click the canvas</div>
    </div>
  );
}
