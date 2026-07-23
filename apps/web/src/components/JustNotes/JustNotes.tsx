import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type OnNodesChange,
  type Viewport,
} from "@xyflow/react";
import {
  GRID,
  parsePastedUrl,
  uid,
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
import { FlowCanvas } from "./flow/FlowCanvas";
import { FRAME_DEFAULT_W, FRAME_DEFAULT_H } from "./flow/FrameNode";
import {
  applyNoteNodeChanges,
  buildNoteNodes,
  buildThreadEdges,
  type NoteFlowNode,
  type NoteNodeHandlers,
} from "./flow/useNoteGraph";
import type { NotesByBoard } from "../../hooks/useAllNotes";
import { toggleTaskLine } from "./markdown";
import { formatCapturedNote } from "./clipboard";
import { clipboardOrigin } from "../../lib/clipboard-origin";
import { AmbientBar, Compass, TimeScrub } from "./cherries";
import { TweaksUI } from "./tweaks";
import { remoteStorage, type NoteLink } from "../../lib/storage";
import { authClient, clearKeychainToken } from "../../lib/auth-client";
import { API_BASE_URL, isTauri } from "../../lib/runtime";
import { AuthPanel } from "../AuthPanel";
import { ApiTokensPanel } from "./api-tokens";
import { filterCommands, type Command } from "../../lib/commands";
import { Graveyard } from "./Graveyard";

type Persist = {
  onCreate: (note: Note, opts?: { localOnly?: boolean }) => void | Promise<void>;
  onUpdate: (id: string, patch: Partial<Pick<Note, "x" | "y" | "w" | "h" | "t" | "text" | "kind" | "color" | "parentId" | "meta">>) => void;
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

// How far the docked file tree's hover-peek overlays the canvas while
// unpinned (the 232px panel opens over a 48px rail footprint). Used to keep
// note-focus jumps centered in the visible canvas, not behind the peeked
// tree; a pinned tree sits outside the canvas entirely, so the inset is 0.
const FILE_TREE_PEEK = 184;
const SIDEBAR_PIN_KEY = "justanotetaker.sidebar.pinned";

type UndoOp =
  | { type: "create"; id: string }
  | { type: "edit"; id: string; prevText: string; prevT: number }
  | { type: "delete"; note: Note }
  | { type: "move"; id: string; prevX: number; prevY: number }
  // One frame/marquee drag = one undo press, however many notes rode along.
  | { type: "move-group"; moves: { id: string; prevX: number; prevY: number }[] };

// ── App ────────────────────────────────────────────────────────────────
// The canvas is a React Flow surface; the provider gives the orchestrator
// access to the viewport (useReactFlow) for camera moves.
export default function JustNotes(props: JustNotesProps) {
  return (
    <ReactFlowProvider>
      <JustNotesInner {...props} />
    </ReactFlowProvider>
  );
}

function JustNotesInner(props: JustNotesProps) {
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

  // React Flow owns the viewport; `view` mirrors it (fed by onMove) for
  // everything that reads the camera — screenToCanvas, overview detection,
  // the Compass. Camera writes go through applyView → rf.setViewport.
  const [initialViewport] = useState<Viewport>(() => ({
    x: window.innerWidth / 2,
    y: window.innerHeight / 2 - 40,
    zoom: 1,
  }));
  const [view, setView] = useState<View>({ pan: { x: initialViewport.x, y: initialViewport.y }, zoom: 1 });
  const viewRef = useRef(view);
  useEffect(() => { viewRef.current = view; }, [view]);
  const rf = useReactFlow<NoteFlowNode>();

  // Crisp text under zoom: promote the RF viewport (will-change) only while it's
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

  // User-drawn relationships (drag from a note's link dot onto another note).
  // Always visible; click a thread to select it, Backspace deletes it.
  const [links, setLinks] = useState<NoteLink[]>([]);
  const linksRef = useRef<NoteLink[]>([]);
  useEffect(() => { linksRef.current = links; }, [links]);
  const [selectedLinkId, setSelectedLinkId] = useState<string | null>(null);
  const selectedLinkRef = useRef<string | null>(null);
  useEffect(() => { selectedLinkRef.current = selectedLinkId; }, [selectedLinkId]);
  useEffect(() => {
    let cancelled = false;
    remoteStorage.listLinks(activeBoardId)
      .then((ls) => { if (!cancelled) setLinks(ls); })
      .catch((err) => console.error("[links] list failed", err));
    return () => { cancelled = true; };
  // The board remounts this component (key), so one fetch per board.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Camera writes route through React Flow; the mirror updates via onMove.
  // Non-animated moves also stamp viewRef immediately so sequential camera
  // math within one handler reads the fresh value.
  function applyView(next: View, animate = false) {
    if (!animate) viewRef.current = next;
    void rf.setViewport(
      { x: next.pan.x, y: next.pan.y, zoom: next.zoom },
      animate ? { duration: 400 } : undefined,
    );
  }

  // Multiply zoom by `factor`, keeping the screen point (sx, sy) — relative to
  // the canvas element — fixed under the cursor. (⌘+/- path; wheel and pinch
  // zoom are handled by React Flow itself.)
  function zoomAt(factor: number, sx: number, sy: number) {
    const v = viewRef.current;
    const nextZoom = Math.max(0.32, Math.min(2.5, v.zoom * factor));
    const canvasX = (sx - v.pan.x) / v.zoom;
    const canvasY = (sy - v.pan.y) / v.zoom;
    applyView({ pan: { x: sx - canvasX * nextZoom, y: sy - canvasY * nextZoom }, zoom: nextZoom });
  }

  const markInteracted = () => { if (!interacted) setInteracted(true); };

  function animateView(next: View) {
    bumpMoving(460);
    applyView(next, true);
  }

  // With the canvas docked beside the sidebar, screen coords no longer start
  // at the pane origin — let RF subtract the pane's own offset.
  function screenToCanvas(sx: number, sy: number) {
    return rf.screenToFlowPosition({ x: sx, y: sy });
  }
  // Visible canvas dimensions (the pane, not the window — the docked sidebar
  // gutter is outside it). Camera math centers within this.
  function canvasSize() {
    const r = canvasRef.current?.getBoundingClientRect();
    return { W: r?.width ?? window.innerWidth, H: r?.height ?? window.innerHeight };
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
    else if (op.type === "move-group") {
      const byId = new Map(op.moves.map((m) => [m.id, m]));
      setNotes((ns) => ns.map((n) => {
        const m = byId.get(n.id);
        return m ? { ...n, x: m.prevX, y: m.prevY } : n;
      }));
    }
  }

  function spawnAt(canvasX: number, canvasY: number, initialText = "", kind: NoteKind = "card") {
    const id = uid();
    // Frames spawn committed and selected (no editor session — the label is
    // edited via double-click), sized to their canonical footprint.
    if (kind === "frame") {
      const note: Note = {
        id,
        x: canvasX - FRAME_DEFAULT_W / 2,
        y: canvasY - FRAME_DEFAULT_H / 2,
        w: FRAME_DEFAULT_W,
        h: FRAME_DEFAULT_H,
        t: Date.now(),
        text: initialText || "Frame",
        kind,
        color: null,
      };
      setNotes((ns) => [...ns, note]);
      pushOp({ type: "create", id });
      void onCreate(note);
      setSelectedIds(new Set([id]));
      return;
    }
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
    const layer = canvasRef.current;
    const rects: { x: number; y: number; w: number; h: number }[] = [];
    for (const n of notesRef.current) {
      if (n.id === excludeId) continue;
      // Frames are containers, not obstacles — colliding against them would
      // make the free-spot spiral eject any note dropped inside one.
      if (n.kind === "frame") continue;
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
    const { W, H } = canvasSize();
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

  // ── Frames: full containment ───────────────────────────────────────
  function frameRectOf(f: Note) {
    const m = measuredDimsRef.current.get(f.id);
    return { x: f.x, y: f.y, w: f.w ?? m?.width ?? FRAME_DEFAULT_W, h: f.h ?? m?.height ?? FRAME_DEFAULT_H };
  }

  // Topmost frame containing the point — last match wins, mirroring paint
  // order among equal-z frames.
  function hitFrame(cx: number, cy: number): Note | null {
    let hit: Note | null = null;
    for (const f of notesRef.current) {
      if (f.kind !== "frame") continue;
      const r = frameRectOf(f);
      if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) hit = f;
    }
    return hit;
  }

  function noteCenter(n: Note) {
    const m = measuredDimsRef.current.get(n.id);
    return {
      x: n.x + (m?.width ?? n.w ?? tweakRef.current.noteWidth) / 2,
      y: n.y + (m?.height ?? n.h ?? 96) / 2,
    };
  }

  // Re-derive a note's frame membership from where it sits; persist a change.
  function applyContainment(id: string) {
    const cur = notesRef.current.find((n) => n.id === id);
    if (!cur || cur.kind === "frame") return;
    const c = noteCenter(cur);
    const nextParent = hitFrame(c.x, c.y)?.id ?? null;
    if ((cur.parentId ?? null) === nextParent) return;
    setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, parentId: nextParent } : n)));
    onUpdate(id, { parentId: nextParent });
  }

  // After a frame moves or resizes, its border may have crossed notes in
  // either direction — re-derive membership for the whole board.
  function recheckAllContainment() {
    for (const n of notesRef.current) {
      if (n.kind !== "frame") applyContainment(n.id);
    }
  }

  // Deleting a frame never implicitly deletes members unless asked: the plain
  // path releases them to the board root first.
  function deleteFrameById(id: string, withContents: boolean) {
    const members = notesRef.current.filter((n) => n.parentId === id);
    if (withContents) {
      for (const m of members) deleteNoteById(m.id);
    } else {
      for (const m of members) {
        setNotes((ns) => ns.map((n) => (n.id === m.id ? { ...n, parentId: null } : n)));
        onUpdate(m.id, { parentId: null });
      }
    }
    deleteNoteById(id);
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

  function reinsertRestoredNote(note: { id: string; x: number; y: number; w?: number | null; h?: number | null; t: number; text: string; kind?: NoteKind; color?: string | null; parentId?: string | null; meta?: Note["meta"] }) {
    setNotes((ns) => (ns.some((n) => n.id === note.id) ? ns : [...ns, {
      ...note,
      w: note.w ?? null,
      h: note.h ?? null,
      kind: note.kind ?? "card",
      color: note.color ?? null,
      parentId: note.parentId ?? null,
      meta: note.meta ?? null,
    }]));
  }

  function frameNotes(list: Note[]) {
    if (!list.length) return;
    const { W, H } = canvasSize();
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
    const { W, H } = canvasSize();
    const cx = n.x + NW / 2, cy = n.y + 60;
    const pan = { x: W / 2 - cx * v.zoom, y: H / 2 - cy * v.zoom };
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
    const { W, H } = canvasSize();
    // Tree-click jumps land while the unpinned tree is peeked open over the
    // canvas's left edge; a pinned tree is outside the canvas. Read the
    // persisted pin at call time — no re-render depends on it.
    let treePinned = false;
    try { treePinned = localStorage.getItem(SIDEBAR_PIN_KEY) === "1"; } catch { /* blocked */ }
    const edge = treePinned ? 0 : FILE_TREE_PEEK;
    const fit = Math.min(((W - edge) * 0.7) / NW, (H * 0.7) / NH);
    const zoom = Math.max(0.9, Math.min(1.2, fit));
    const cx = p.x + NW / 2;
    const visibleCx = (edge + W) / 2;
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
    const { W, H } = canvasSize();
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
    const { W, H } = canvasSize();
    animateView({ pan: { x: W / 2 - cx, y: H / 2 - cy }, zoom: 1 });
    prevViewRef.current = null;
  }

  // ── React Flow event handlers ──────────────────────────────────────
  // Shift suspends grid snapping mid-drag (snapToGrid is recomputed live).
  const [shiftHeld, setShiftHeld] = useState(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === "Shift") setShiftHeld(true); };
    const up = (e: KeyboardEvent) => { if (e.key === "Shift") setShiftHeld(false); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // Drag-start positions for undo "move" ops, captured per dragged node.
  const dragStartRef = useRef<Map<string, { x: number; y: number }> | null>(null);
  const justDraggedRef = useRef(false);

  // RF-measured node sizes, cached from "dimensions" changes and stamped back
  // onto the derived nodes (see useNoteGraph). The tick re-derives the nodes
  // when a measurement lands, since the map itself is a ref.
  const measuredDimsRef = useRef(new Map<string, { width: number; height: number }>());
  const [dimsTick, setDimsTick] = useState(0);

  const onNodesChange: OnNodesChange<NoteFlowNode> = (changes) => {
    applyNoteNodeChanges(changes, {
      setNotes,
      setSelectedIds,
      measuredDims: measuredDimsRef.current,
      onDimensions: () => setDimsTick((v) => v + 1),
    });
  };

  function handleMove(_: unknown, vp: Viewport) {
    setView({ pan: { x: vp.x, y: vp.y }, zoom: vp.zoom });
    bumpMoving();
  }

  function handleMoveStart() {
    markInteracted();
  }

  // Frame members ride along with a dragged frame. Snapshot their start
  // positions keyed to their frame, skipping any the marquee already put in
  // RF's own drag set (those would double-move).
  const frameMembersRef = useRef<Map<string, { sx: number; sy: number; frameId: string }> | null>(null);

  function handleNodeDragStart(_: unknown, node: NoteFlowNode, dragged: NoteFlowNode[]) {
    markInteracted();
    setDraggingId(node.id);
    const map = new Map<string, { x: number; y: number }>();
    for (const d of dragged) map.set(d.id, { x: d.position.x, y: d.position.y });
    dragStartRef.current = map;

    const members = new Map<string, { sx: number; sy: number; frameId: string }>();
    for (const d of dragged) {
      const n = notesRef.current.find((x) => x.id === d.id);
      if (n?.kind !== "frame") continue;
      for (const m of notesRef.current) {
        if (m.parentId === n.id && !map.has(m.id) && !members.has(m.id)) {
          members.set(m.id, { sx: m.x, sy: m.y, frameId: n.id });
        }
      }
    }
    frameMembersRef.current = members.size ? members : null;
  }

  // Live tick: move each riding member by its frame's delta so the group
  // travels as one piece rather than snapping at drop.
  function handleNodeDrag(_: unknown, _node: NoteFlowNode, dragged: NoteFlowNode[]) {
    const members = frameMembersRef.current;
    const starts = dragStartRef.current;
    if (!members || !starts) return;
    const framePos = new Map(dragged.map((d) => [d.id, d.position]));
    setNotes((ns) => ns.map((n) => {
      const m = members.get(n.id);
      if (!m) return n;
      const fp = framePos.get(m.frameId);
      const fs = starts.get(m.frameId);
      if (!fp || !fs) return n;
      return { ...n, x: m.sx + (fp.x - fs.x), y: m.sy + (fp.y - fs.y) };
    }));
  }

  function handleNodeDragStop(_: unknown, node: NoteFlowNode, dragged: NoteFlowNode[]) {
    // RF can fire a click on the drop target right after a drag; swallow it so
    // a completed drag never falls into click-to-edit.
    justDraggedRef.current = true;
    window.setTimeout(() => { justDraggedRef.current = false; }, 0);
    setDraggingId(null);
    const starts = dragStartRef.current;
    dragStartRef.current = null;
    const members = frameMembersRef.current;
    frameMembersRef.current = null;
    if (!starts) return;

    const draggedAFrame = dragged.some((d) => notesRef.current.find((n) => n.id === d.id)?.kind === "frame");
    if (dragged.length === 1 && !draggedAFrame) {
      // Single-card drops snap to the nearest free spot so cards never stack.
      const sp = starts.get(node.id);
      const cur = notesRef.current.find((n) => n.id === node.id);
      if (!sp || !cur || (sp.x === cur.x && sp.y === cur.y)) return;
      const el = canvasRef.current?.querySelector<HTMLElement>(`[data-note-id="${node.id}"]`);
      const selfW = el?.offsetWidth ?? cur.w ?? tweakRef.current.noteWidth;
      const selfH = el?.offsetHeight ?? cur.h ?? 96;
      const spot = resolveFreePosition(cur.x, cur.y, selfW, selfH, measureRects(node.id));
      pushOp({ type: "move", id: node.id, prevX: sp.x, prevY: sp.y });
      if (spot.x !== cur.x || spot.y !== cur.y) {
        setNotes((ns) => ns.map((n) => (n.id === node.id ? { ...n, x: spot.x, y: spot.y } : n)));
        setSnappingId(node.id);
        window.setTimeout(() => setSnappingId((s) => (s === node.id ? null : s)), 340);
      }
      onUpdate(node.id, { x: spot.x, y: spot.y });
      applyContainment(node.id);
      return;
    }

    // Group path: any frame drag (with riding members) or a marquee multi-drag.
    // Everything persists as it landed — no collision resolve — and the whole
    // gesture is one undo op.
    const moves: { id: string; prevX: number; prevY: number }[] = [];
    for (const d of dragged) {
      const sp = starts.get(d.id);
      const cur = notesRef.current.find((n) => n.id === d.id);
      if (!sp || !cur || (sp.x === cur.x && sp.y === cur.y)) continue;
      moves.push({ id: d.id, prevX: sp.x, prevY: sp.y });
      onUpdate(d.id, { x: cur.x, y: cur.y });
    }
    if (members) {
      for (const [id, m] of members) {
        const cur = notesRef.current.find((n) => n.id === id);
        if (!cur || (m.sx === cur.x && m.sy === cur.y)) continue;
        moves.push({ id, prevX: m.sx, prevY: m.sy });
        onUpdate(id, { x: cur.x, y: cur.y });
      }
    }
    if (moves.length) pushOp({ type: "move-group", moves });
    // Membership: dragged frames may have crossed notes; dragged notes may
    // have entered/left frames. Members that rode along kept their relative
    // position, so their membership is unchanged by construction.
    if (draggedAFrame) recheckAllContainment();
    else for (const d of dragged) applyContainment(d.id);
  }

  function handleNodeClick(e: React.MouseEvent, node: NoteFlowNode) {
    if (justDraggedRef.current) return;
    markInteracted();
    // Inline #tag chips open the ambient search instead of selecting.
    const tagEl = (e.target as HTMLElement).closest("[data-tag]") as HTMLElement | null;
    if (tagEl && editingIdRef.current !== node.id) {
      const tag = tagEl.dataset.tag;
      if (tag) {
        if (editingIdRef.current) commitEditing();
        openAmbient("#" + tag);
      }
      return;
    }
    if (editingIdRef.current === node.id) return;
    // Single click selects; editing is a double-click (below).
    if (editingIdRef.current) commitEditing();
    if (ambientOpen) closeAmbient();
    setSelectedIds(new Set([node.id]));
  }

  function handleNodeDoubleClick(e: React.MouseEvent, node: NoteFlowNode) {
    markInteracted();
    if (editingIdRef.current === node.id) return;
    if ((e.target as HTMLElement).closest("[data-tag]")) return; // tag click already handled
    // Double-click drops into editing the note in place. startEditingExisting
    // commits any other open editor first. Remember where the click landed so
    // the caret opens there rather than jumping to the end of the text.
    if (ambientOpen) closeAmbient();
    setSelectedIds(new Set([node.id]));
    editClickRef.current = { x: e.clientX, y: e.clientY };
    startEditingExisting(node.id);
  }

  function handlePaneClick() {
    markInteracted();
    // A tap on empty canvas only dismisses transient state.
    if (prevViewRef.current) { animateView(prevViewRef.current); prevViewRef.current = null; return; }
    if (editingId) { commitEditing(); return; }
    if (ambientOpen) { closeAmbient(); return; }
    if (selectedLinkRef.current) { setSelectedLinkId(null); return; }
    if (selectedIdsRef.current.size > 0) setSelectedIds(new Set());
  }

  function handlePaneContextMenu(e: MouseEvent | React.MouseEvent) {
    // Stop propagation so this event doesn't bubble to an open menu's
    // window-level dismiss listener, which would close the menu we're
    // about to open.
    e.preventDefault();
    e.stopPropagation();
    markInteracted();
    const c = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    setContextMenu(null);
    setCanvasMenu({ x: e.clientX, y: e.clientY, cx: c.x, cy: c.y });
  }

  function handleNodeContextMenu(e: React.MouseEvent, node: NoteFlowNode) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ id: node.id, x: e.clientX, y: e.clientY });
  }

  function handleConnect(conn: Pick<Connection, "source" | "target">) {
    const s = conn.source, t2 = conn.target;
    if (!s || !t2 || s === t2) return;
    const [a, b] = s < t2 ? [s, t2] : [t2, s];
    if (linksRef.current.some((l) => l.a === a && l.b === b)) return;
    markInteracted();
    const id = uid();
    setLinks((ls) => [...ls, { id, a, b }]);
    markWrite();
    remoteStorage.createLink({ id, boardId: activeBoardId, aId: a, bId: b })
      .then((saved) => {
        // A duplicate races to the server's canonical row — adopt its id.
        if (saved.id !== id) setLinks((ls) => ls.map((l) => (l.id === id ? saved : l)));
      })
      .catch((err) => console.error("[links] create failed", err));
  }

  // RF only completes a connection when the drop lands on a handle it knows
  // about, and its cached handle bounds can go stale (e.g. across HMR). Treat
  // any release over a card as a valid drop: resolve the note under the
  // pointer ourselves and link to it.
  function handleConnectEnd(
    event: MouseEvent | TouchEvent,
    state: { isValid: boolean | null; fromNode: { id: string } | null },
  ) {
    if (state.isValid || !state.fromNode) return; // valid drops came through onConnect
    const pt = "changedTouches" in event ? event.changedTouches[0] : event;
    if (!pt) return;
    const el = document.elementFromPoint(pt.clientX, pt.clientY);
    const target = el?.closest<HTMLElement>("[data-note-id]")?.dataset.noteId;
    if (target) handleConnect({ source: state.fromNode.id, target });
  }

  function handleEdgeClick(e: React.MouseEvent, edge: { data?: { kind?: string; linkId?: string } }) {
    if (edge.data?.kind !== "link" || !edge.data.linkId) return;
    e.stopPropagation();
    setSelectedLinkId((cur) => (cur === edge.data!.linkId ? null : edge.data!.linkId!));
  }

  function deleteSelectedLink() {
    const id = selectedLinkRef.current;
    if (!id) return;
    setSelectedLinkId(null);
    setLinks((ls) => ls.filter((l) => l.id !== id));
    markWrite();
    remoteStorage.removeLink(id).catch((err) => console.error("[links] delete failed", err));
  }

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
        else if (selectedLinkRef.current) setSelectedLinkId(null);
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

      if ((e.key === "Backspace" || e.key === "Delete") && selectedLinkRef.current) {
        e.preventDefault();
        deleteSelectedLink();
        return;
      }

      if ((e.key === "Backspace" || e.key === "Delete") && selectedIdsRef.current.size > 0) {
        e.preventDefault();
        for (const nid of Array.from(selectedIdsRef.current)) {
          // Never mass-delete a frame's contents from the keyboard — members
          // are released to the root; the context menu has the explicit path.
          if (notesRef.current.find((n) => n.id === nid)?.kind === "frame") deleteFrameById(nid, false);
          else deleteNoteById(nid);
        }
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
  // tight cluster). prevViewRef flips alongside a camera move, so it's safe here.
  const inOverview = view.zoom < 0.95 || prevViewRef.current != null;

  // Stable handler facade for node data: the identity never changes (so memo'd
  // NoteNodes aren't re-rendered by handler churn) while the logic stays fresh
  // through the ref, avoiding stale closures over editingId & co.
  const nodeHandlersRef = useRef<NoteNodeHandlers>(null!);
  nodeHandlersRef.current = {
    onTextChange: (id, v) => updateNoteText(id, v),
    onCommitEdit: () => commitEditing(),
    onTagClick: (tag) => {
      if (editingIdRef.current) commitEditing();
      openAmbient("#" + tag);
      markInteracted();
    },
    onToggleTask: (id, i) => toggleTask(id, i),
    onResize: (id, p) =>
      setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, x: p.x, y: p.y, w: p.width, h: p.height } : n))),
    onResizeEnd: (id, p) => {
      onUpdate(id, { x: p.x, y: p.y, w: p.width, h: p.height });
      // A resized frame border may have swallowed or released notes.
      if (notesRef.current.find((n) => n.id === id)?.kind === "frame") recheckAllContainment();
    },
  };
  const nodeHandlers = useMemo<NoteNodeHandlers>(() => ({
    onTextChange: (id, v) => nodeHandlersRef.current.onTextChange(id, v),
    onCommitEdit: () => nodeHandlersRef.current.onCommitEdit(),
    onTagClick: (tag) => nodeHandlersRef.current.onTagClick(tag),
    onToggleTask: (id, i) => nodeHandlersRef.current.onToggleTask(id, i),
    onResize: (id, p) => nodeHandlersRef.current.onResize(id, p),
    onResizeEnd: (id, p) => nodeHandlersRef.current.onResizeEnd(id, p),
  }), []);

  // Controlled React Flow graph derived from app state. Deliberately does NOT
  // depend on `view`: pan/zoom moves the RF viewport transform without
  // rebuilding (or re-rendering) a single card.
  const nodes = useMemo(
    () =>
      buildNoteNodes({
        notes,
        selectedIds,
        editingId,
        draggingId,
        snappingId,
        matchSet,
        focusId: matchIds ? matchIds[recallIdx] ?? null : null,
        scrubMoment,
        clipboardIds,
        editClickPos: editClickRef.current,
        measuredDims: measuredDimsRef.current,
        handlers: nodeHandlers,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [notes, selectedIds, editingId, draggingId, snappingId, matchSet, matchIds, recallIdx, scrubMoment, clipboardIds, nodeHandlers, dimsTick],
  );

  const edges = useMemo(
    () => buildThreadEdges({ notes, links, selectedLinkId, relationsOn, hoveredId, selectedIds }),
    [notes, links, selectedLinkId, relationsOn, hoveredId, selectedIds],
  );

  const rootStyle: CSSProperties = {
    ["--radius" as string]: `${t.radius}px`,
    ["--note-w" as string]: `${t.noteWidth}px`,
  };

  return (
    <div className="jn-root" style={rootStyle}>
      {/* First flex child: the docked tree. Its footprint (rail or pinned
          panel) is layout width; the canvas flexes into the rest. */}
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

      <div
        ref={canvasRef}
        className={"jn-flow" + (moving ? " moving" : "") + (inOverview ? " overview" : "")}
      >
        <FlowCanvas
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          defaultViewport={initialViewport}
          grid={t.grid}
          snapEnabled={t.snap && !shiftHeld}
          onMove={handleMove}
          onMoveStart={handleMoveStart}
          onNodeClick={handleNodeClick}
          onNodeDoubleClick={handleNodeDoubleClick}
          onNodeContextMenu={handleNodeContextMenu}
          onNodeMouseEnter={(_, n) => onNoteHover(n.id)}
          onNodeMouseLeave={() => onNoteHover(null)}
          onNodeDragStart={handleNodeDragStart}
          onNodeDrag={handleNodeDrag}
          onNodeDragStop={handleNodeDragStop}
          onPaneClick={handlePaneClick}
          onPaneContextMenu={handlePaneContextMenu}
          onConnect={handleConnect}
          onConnectEnd={handleConnectEnd}
          onEdgeClick={handleEdgeClick}
        />
      </div>

      {notes.length === 0 && <GhostCard />}

      <Toolbar
        onNewNote={() => { markInteracted(); spawnAtCenter(""); }}
        onSearch={() => { markInteracted(); openAmbient(""); }}
        overviewActive={inOverview}
        onOverview={() => { markInteracted(); toggleOverview(); }}
        relationsActive={relationsOn}
        onRelations={() => { markInteracted(); setRelationsOn((v) => !v); }}
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
              if (n?.kind === "frame") deleteFrameById(id, false);
              else deleteNoteById(id);
            }}
            onDeleteContents={n?.kind === "frame" ? () => {
              const id = contextMenu.id;
              setContextMenu(null);
              deleteFrameById(id, true);
            } : undefined}
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
      <TbBtn
        label={p.agentSessionActive ? "Live agent session · on (click to stop)" : "Make this a live agent session — the desktop app answers new turns"}
        active={p.agentSessionActive}
        onClick={p.onAgentSession}
      >
        {TB_ICON.agent}
      </TbBtn>
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
  x, y, kind, color, onSetKind, onSetColor, onClose, onDelete, onDeleteContents,
}: {
  x: number; y: number;
  kind: NoteKind; color: string | null;
  onSetKind: (k: NoteKind) => void;
  onSetColor: (c: string | null) => void;
  onClose: () => void; onDelete: () => void;
  // Frames only: delete the frame together with its member notes.
  onDeleteContents?: () => void;
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
      {kind !== "frame" && kind !== "image" && kind !== "task" && (
        <>
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
        </>
      )}
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
        {kind === "frame" ? "delete frame" : "delete"}
        <span className="note-ctx-hint">⌘Z to undo</span>
      </button>
      {kind === "frame" && onDeleteContents && (
        <button className="note-ctx-item danger" onClick={onDeleteContents}>
          delete frame + contents
        </button>
      )}
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
        {([...NOTE_KINDS, "frame"] as NoteKind[]).map((k) => (
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
