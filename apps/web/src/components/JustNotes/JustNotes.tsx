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
  firstNonEmpty,
  restAfterFirst,
  resolveNoteColor,
  NOTE_COLOR_KEYS,
  NOTE_COLOR_MAP,
  NOTE_DEFAULT_W,
  PAPER_W,
  PAPER_H,
  type FrameMeta,
  type ImageMeta,
  type TaskMeta,
  type ObjectMeta,
  type ObjectType,
  emptyTable,
  emptyEmbed,
  type Note,
  type NoteKind,
  type Board,
  type Tweaks,
} from "./lib";
import { FileTree } from "./FileTree";
import { FlowCanvas } from "./flow/FlowCanvas";
import { FRAME_DEFAULT_W, FRAME_DEFAULT_H, FRAME_MIN_W, FRAME_MIN_H, FRAME_PAD, FRAME_LABEL_H } from "./flow/FrameNode";
import {
  applyNoteNodeChanges,
  buildNoteNodes,
  buildThreadEdges,
  type NoteFlowNode,
  type NoteNodeHandlers,
} from "./flow/useNoteGraph";
import type { NotesByBoard } from "../../hooks/useAllNotes";
import { renderBody, renderHeadline, toggleTaskLine } from "./markdown";
import { formatCapturedNote } from "./clipboard";
import { clipboardOrigin } from "../../lib/clipboard-origin";
import { AmbientBar, Compass, TimeScrub } from "./cherries";
import { TweaksUI } from "./tweaks";
import { remoteStorage, uploadMedia, type NoteLink } from "../../lib/storage";
import { authClient, clearKeychainToken } from "../../lib/auth-client";
import { API_BASE_URL, isTauri } from "../../lib/runtime";
import { hasAiKey, runAiStream } from "../../lib/ai";
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
  onDuplicateBoard: (id: string) => void;
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
  const { initialNotes, tweaks: t, setTweak, onCreate: rawOnCreate, onUpdate: rawOnUpdate, onDelete: rawOnDelete, refresh, boards, activeBoardId, notesByBoard, onBoardJump, focusNoteId, onFocusConsumed, onBoardCreate, spawnRequested, onSpawnConsumed, onSwitchBoard, onCreateBoard, onRenameBoard, onDeleteBoard, onDuplicateBoard } = props;
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [tokensOpen, setTokensOpen] = useState(false);

  const [notes, setNotes] = useState<Note[]>(initialNotes);
  const notesRef = useRef(notes);
  useEffect(() => { notesRef.current = notes; }, [notes]);

  // Ids deleted this session. A background refresh() can race a just-issued
  // server soft-delete (list() may still return the row for a beat); the merge
  // consults this so a deleted note is never resurrected.
  const deletedRef = useRef<Set<string>>(new Set());

  // Merge server notes we don't already hold, and additionally adopt server
  // copies of TASK cards whose status/text changed out-of-band (an MCP agent
  // or the Tauri run_task command driving the lifecycle) — the only kind we
  // update in place, since a card/page could hold unsynced local edits. Never
  // clobbers the note being edited or dragged, nor resurrects a just-deleted
  // note (deletedRef guards the soft-delete race).
  const mergeServer = useCallback((server: Note[]) => {
    if (!server.length) return;
    setNotes((prev) => {
      const have = new Map(prev.map((n) => [n.id, n]));
      const additions = server.filter((n) => !have.has(n.id) && !deletedRef.current.has(n.id));
      const busy = new Set([editingIdRef.current, draggingIdRef.current].filter(Boolean) as string[]);
      let changed = additions.length > 0;
      const merged = prev.map((n) => {
        if (busy.has(n.id)) return n;
        // Canvas objects (tables) are agent-writable: adopt server state unless
        // there's a local edit still in flight (a pending debounced persist).
        if (n.kind === "object") {
          const srv = have.has(n.id) ? server.find((s) => s.id === n.id) : undefined;
          if (!srv || objPersistRef.current.has(n.id)) return n;
          if (JSON.stringify(srv.meta) === JSON.stringify(n.meta) && srv.text === n.text) return n;
          changed = true;
          return { ...n, text: srv.text, meta: srv.meta, t: srv.t };
        }
        if (n.kind !== "task") {
          // Card/page content from another device (or MCP update_note): adopt
          // the server copy only when it's strictly NEWER than what we hold —
          // our own unflushed edits carry a fresher t, so they win locally and
          // reach the server on their own. Content only; position is left to
          // the drag/containment machinery.
          const srv = have.has(n.id) ? server.find((s) => s.id === n.id) : undefined;
          if (!srv || srv.t <= n.t) return n;
          if (srv.text === n.text && srv.color === n.color && srv.kind === n.kind) return n;
          changed = true;
          return { ...n, kind: srv.kind, text: srv.text, color: srv.color, meta: srv.meta, t: srv.t };
        }
        const srv = have.has(n.id) ? server.find((s) => s.id === n.id) : undefined;
        if (!srv) return n;
        const sm = srv.meta as { status?: string } | null;
        const nm = n.meta as { status?: string } | null;
        // Adopt status/result changes AND the task→page transition: a done task
        // resolves into a plain page (every note is a page), so carry srv.kind.
        if (srv.kind === n.kind && srv.text === n.text && sm?.status === nm?.status) return n;
        changed = true;
        return { ...n, kind: srv.kind, text: srv.text, meta: srv.meta, t: srv.t };
      });
      return changed ? [...merged, ...additions] : prev;
    });
  }, []);

  // Refresh a board on demand from the tree. The active board re-pulls from the
  // server (agent writes, other devices); a different board just switches to it,
  // which reloads it fresh.
  const refreshBoard = useCallback((id: string) => {
    if (id !== activeBoardId) { onSwitchBoard(id); return; }
    if (refresh) void refresh().then((server) => mergeServer(server));
  }, [activeBoardId, onSwitchBoard, refresh, mergeServer]);

  // Pull in notes created out-of-band — another device, or an agent piping via
  // the MCP server. The app has no realtime channel, so we poll gently while
  // the tab is visible and refetch on focus.
  useEffect(() => {
    if (!refresh) return;
    let cancelled = false;
    const pull = async () => {
      if (document.hidden) return;
      const server = await refresh();
      if (cancelled) return;
      mergeServer(server);
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
  }, [refresh, mergeServer]);

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

  // Focus/read mode: a note opened in a fixed, legible overlay independent of
  // canvas zoom, so reading never forces a pan-and-zoom hunt. j/k step through
  // notes in reading order without touching the mouse.
  const [focusId, setFocusId] = useState<string | null>(null);
  const focusIdRef = useRef<string | null>(null);
  useEffect(() => { focusIdRef.current = focusId; }, [focusId]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const editingIdRef = useRef<string | null>(null);
  useEffect(() => { editingIdRef.current = editingId; }, [editingId]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const draggingIdRef = useRef<string | null>(null);
  useEffect(() => { draggingIdRef.current = draggingId; }, [draggingId]);
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
  // A pending typed follow-up: which notes it hangs off, and a label to show.
  const [followUp, setFollowUp] = useState<{ ids: string[]; label: string } | null>(null);
  // Right-click on app chrome (sidebar bg, toolbar, backdrop) — misc actions.
  const [globalMenu, setGlobalMenu] = useState<{ x: number; y: number } | null>(null);

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
  // Which tall notes the user chose to show at full height. A view preference,
  // kept device-local (localStorage) rather than synced — the auto-collapse
  // default is derived from content height, so only the override needs storing.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("jnt-expanded-notes");
      return new Set<string>(raw ? JSON.parse(raw) : []);
    } catch { return new Set<string>(); }
  });
  const toggleNoteHeight = useCallback((id: string) => {
    markInteracted();
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem("jnt-expanded-notes", JSON.stringify([...next])); } catch { /* private mode */ }
      return next;
    });
    const n = notesRef.current.find((x) => x.id === id);
    if (n?.parentId) window.setTimeout(() => scheduleReflow(id), 60);
  }, []);
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

  function spawnAt(canvasX: number, canvasY: number, initialText = "", kind: NoteKind = "page") {
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
    const w = kind === "page" ? NOTE_DEFAULT_W : tweakRef.current.noteWidth;
    const spot = findFreeSpot(canvasX - w / 2, canvasY - 22);
    // Spawned inside a frame? Adopt it as a member so it moves with the frame.
    const parentId = hitFrame(canvasX, canvasY)?.id ?? null;
    setNotes((ns) => [...ns, { id, x: spot.x, y: spot.y, w: null, h: null, t: Date.now(), text: initialText, kind, color: null, parentId }]);
    editSnapshotRef.current = { id, isNew: true, prevText: "", prevT: Date.now() };
    editClickRef.current = null; // new note → caret at end, not a stale click point
    setEditingId(id);
    if (parentId) scheduleReflow(id);
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
    const w = NOTE_DEFAULT_W;
    const spot = findFreeSpot(canvasX - w / 2, canvasY - 22);
    const x = spot.x;
    const y = spot.y;
    const now = Date.now();
    const note: Note = { id, x, y, w: null, h: null, t: now, text, kind: "page", color: null };
    setNotes((ns) => [...ns, note]);
    pushOp({ type: "create", id });
    void onCreate(note, opts);
    enrichIfUrlNote(id);
    return id;
  }

  // Copy/paste/duplicate whole notes. A device-local clipboard holds the copied
  // notes (with kind/color/meta); the system clipboard gets their text too, so a
  // copied note can also be pasted into another app.
  const noteClipboardRef = useRef<Note[]>([]);

  function copyNotes(ids: string[]) {
    const src = notesRef.current.filter((n) => ids.includes(n.id));
    if (!src.length) return;
    noteClipboardRef.current = src.map((n) => ({ ...n }));
    const text = src.map((n) => n.text).filter(Boolean).join("\n\n");
    if (text) void navigator.clipboard?.writeText(text).catch(() => {});
    markInteracted();
  }

  // Create copies of the given notes, offset from a base. Preserves kind, color,
  // and meta; frame membership is dropped so copies land free (not swallowed).
  function placeNoteCopies(src: Note[], dx: number, dy: number) {
    if (!src.length) return;
    const now = Date.now();
    const copies: Note[] = src.map((n) => ({ ...n, id: uid(), x: n.x + dx, y: n.y + dy, t: now, parentId: null }));
    setNotes((ns) => [...ns, ...copies]);
    for (const c of copies) { pushOp({ type: "create", id: c.id }); void onCreate(c); }
    setSelectedIds(new Set(copies.map((c) => c.id)));
    markInteracted();
  }

  function duplicateNotes(ids: string[]) {
    placeNoteCopies(notesRef.current.filter((n) => ids.includes(n.id)), 26, 26);
  }

  // Paste copied notes centered on a canvas point (keeps their relative layout).
  function pasteNotesAt(cx: number, cy: number) {
    const src = noteClipboardRef.current;
    if (!src.length) return false;
    let minX = Infinity, minY = Infinity;
    for (const n of src) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); }
    placeNoteCopies(src, Math.round(cx - minX - 120), Math.round(cy - minY - 40));
    return true;
  }

  // Paste/drop an image file: optimistic placeholder card immediately, then
  // the upload fills in meta and the note persists. Display size caps at
  // 360px wide; natural dimensions live in meta.
  async function uploadImageAt(cx: number, cy: number, file: File) {
    const id = uid();
    // Read natural dimensions via <img> — more lenient than createImageBitmap
    // across formats/sizes. 4:3 is only a last-resort aspect fallback.
    const { nw, nh } = await new Promise<{ nw: number; nh: number }>((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { resolve({ nw: img.naturalWidth || 4, nh: img.naturalHeight || 3 }); URL.revokeObjectURL(url); };
      img.onerror = () => { resolve({ nw: 4, nh: 3 }); URL.revokeObjectURL(url); };
      img.src = url;
    });
    const dispW = Math.min(nw, 360);
    const dispH = Math.max(1, Math.round(dispW * (nh / nw)));
    const note: Note = {
      id,
      x: cx - dispW / 2,
      y: cy - dispH / 2,
      w: dispW,
      h: dispH,
      t: Date.now(),
      text: "",
      kind: "image",
      color: null,
      meta: null,
    };
    setNotes((ns) => [...ns, note]);
    try {
      const { key, size } = await uploadMedia(file);
      const meta: ImageMeta = { key, w: nw, h: nh, size };
      setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, meta } : n)));
      pushOp({ type: "create", id });
      void onCreate({ ...note, meta });
      applyContainment(id);
    } catch (err) {
      console.error("[image] upload failed", err);
      setNotes((ns) => ns.filter((n) => n.id !== id));
    }
  }

  async function pasteAtCanvas(cx: number, cy: number) {
    let text = "";
    try {
      text = (await navigator.clipboard.readText()).trim();
    } catch {
      text = ""; // clipboard blocked — may still have internally-copied notes
    }
    // Prefer full copies of our own notes over a plain-text re-creation.
    const internal = noteClipboardRef.current;
    if (internal.length && (!text || text === internal.map((n) => n.text).filter(Boolean).join("\n\n").trim())) {
      pasteNotesAt(cx, cy);
      return;
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
  }

  function updateNoteText(id: string, text: string) {
    setNotes((ns) => ns.map((n) => n.id === id ? { ...n, text } : n));
  }

  function setNoteColor(id: string, color: string | null) {
    setNotes((ns) => ns.map((n) => n.id === id ? { ...n, color } : n));
    onUpdate(id, { color });
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

  function isCollapsed(f: Note) {
    return !!(f.meta as FrameMeta | null)?.collapsed;
  }

  // Innermost frame containing the point — the smallest-area match, so a card
  // dropped in a lane nested inside a board lands in the lane, not the board.
  // Collapsed frames don't capture: their visible footprint is just the label.
  function hitFrame(cx: number, cy: number): Note | null {
    let hit: Note | null = null;
    let best = Infinity;
    for (const f of notesRef.current) {
      if (f.kind !== "frame" || isCollapsed(f)) continue;
      const r = frameRectOf(f);
      if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) {
        const area = r.w * r.h;
        if (area < best) { best = area; hit = f; }
      }
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
    // Members of a folded frame are hidden and ride with it — their membership
    // is not up for geometric re-derivation until the frame expands.
    const curFrame = cur.parentId ? notesRef.current.find((n) => n.id === cur.parentId) : null;
    if (curFrame && isCollapsed(curFrame)) return;
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

  // Grow a frame so it wraps every member (plus padding + room for the label
  // bar). Grow-only: a note that pokes out expands the frame; the frame never
  // auto-shrinks, so intentional empty space is preserved. Members keep their
  // absolute positions — only the frame's box changes.
  function fitFrameToMembers(frameId: string) {
    const frame = notesRef.current.find((n) => n.id === frameId);
    if (!frame || frame.kind !== "frame" || isCollapsed(frame)) return;
    const members = notesRef.current.filter((n) => n.parentId === frameId);
    if (!members.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const m of members) {
      const mm = measuredDimsRef.current.get(m.id);
      const w = m.w ?? mm?.width ?? tweakRef.current.noteWidth;
      const h = m.h ?? mm?.height ?? 96;
      minX = Math.min(minX, m.x); minY = Math.min(minY, m.y);
      maxX = Math.max(maxX, m.x + w); maxY = Math.max(maxY, m.y + h);
    }
    const cur = frameRectOf(frame);
    const x = Math.min(cur.x, minX - FRAME_PAD);
    const y = Math.min(cur.y, minY - FRAME_PAD - FRAME_LABEL_H);
    const right = Math.max(cur.x + cur.w, maxX + FRAME_PAD);
    const bottom = Math.max(cur.y + cur.h, maxY + FRAME_PAD);
    const next = { x, y, w: right - x, h: bottom - y };
    if (next.x === cur.x && next.y === cur.y && next.w === cur.w && next.h === cur.h) return;
    setNotes((ns) => ns.map((n) => (n.id === frameId ? { ...n, ...next } : n)));
    onUpdate(frameId, next);
  }

  function frameLayoutOf(f: Note): "free" | "stack" {
    return (f.meta as FrameMeta | null)?.layout === "stack" ? "stack" : "free";
  }

  // Kanban column layout: lay a frame's members out as a single top-aligned
  // vertical stack in their current top-to-bottom order. A column is a
  // fixed-width lane: the frame's width is set by the user (or the kanban
  // preset), members render at that lane width (see stackWidth in the node
  // build), and the lane's height fits their content. Order is re-derived from
  // drop-Y on every drop/reorder.
  const STACK_GAP = 12;
  const stackInnerW = (frame: Note) => Math.max(80, (frame.w ?? FRAME_DEFAULT_W) - FRAME_PAD * 2);
  function restackFrame(frameId: string) {
    const frame = notesRef.current.find((n) => n.id === frameId);
    if (!frame || frame.kind !== "frame" || isCollapsed(frame)) return;
    if (frameLayoutOf(frame) !== "stack") return;
    const members = notesRef.current.filter((n) => n.parentId === frameId);
    if (!members.length) return;
    const innerX = frame.x + FRAME_PAD;
    let cursorY = frame.y + FRAME_LABEL_H + FRAME_PAD;
    const moves: { id: string; x: number; y: number }[] = [];
    for (const m of [...members].sort((a, b) => a.y - b.y)) {
      // Height measured at the lane width — members render narrow (stackWidth),
      // so measuredDims already reflects the wrapped height.
      const h = measuredDimsRef.current.get(m.id)?.height ?? m.h ?? 96;
      if (m.x !== innerX || m.y !== cursorY) moves.push({ id: m.id, x: innerX, y: cursorY });
      cursorY += h + STACK_GAP;
    }
    // Lane keeps its (user-set) width; only its height tracks the content.
    const newH = Math.max(FRAME_MIN_H, cursorY - STACK_GAP + FRAME_PAD - frame.y);
    const frameChanged = newH !== frame.h;
    if (!moves.length && !frameChanged) return;
    setNotes((ns) => ns.map((n) => {
      if (n.id === frameId) return frameChanged ? { ...n, h: newH } : n;
      const mv = moves.find((x) => x.id === n.id);
      return mv ? { ...n, x: mv.x, y: mv.y } : n;
    }));
    for (const mv of moves) onUpdate(mv.id, { x: mv.x, y: mv.y });
    if (frameChanged) onUpdate(frameId, { h: newH });
    // A lane inside a board grew/shrank — grow the board to keep wrapping it.
    if (frameChanged && frame.parentId) requestAnimationFrame(() => reflowFrame(frame.parentId as string));
  }

  // A frame's members settled — reflow by its layout: stack columns re-pack,
  // free frames grow to wrap.
  function reflowFrame(frameId: string) {
    const f = notesRef.current.find((n) => n.id === frameId);
    if (!f || f.kind !== "frame") return;
    if (frameLayoutOf(f) === "stack") restackFrame(frameId);
    else fitFrameToMembers(frameId);
  }

  function restackAllStacks() {
    for (const f of notesRef.current) {
      if (f.kind === "frame" && frameLayoutOf(f) === "stack") restackFrame(f.id);
    }
  }

  // Re-pack columns after a member's measured height settles (a card narrows to
  // the lane width and re-wraps, or grows while editing). Coalesced to one pass
  // per frame; skipped mid-drag, where the gap preview owns member positions.
  const stackSettleRef = useRef(false);
  function scheduleStackSettle() {
    if (stackSettleRef.current) return;
    stackSettleRef.current = true;
    requestAnimationFrame(() => {
      stackSettleRef.current = false;
      if (draggingIdRef.current) return;
      restackAllStacks();
    });
  }

  // Reflow a note's parent frame after its position/size/membership has
  // settled. Deferred a frame so notesRef reflects the committed geometry.
  function scheduleReflow(noteId: string) {
    requestAnimationFrame(() => {
      const n = notesRef.current.find((x) => x.id === noteId);
      if (n?.parentId) reflowFrame(n.parentId);
    });
  }

  function setFrameLayout(id: string, layout: "free" | "stack") {
    const f = notesRef.current.find((n) => n.id === id);
    if (!f || f.kind !== "frame") return;
    const meta: FrameMeta = { ...((f.meta as FrameMeta | null) ?? {}), layout };
    setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, meta } : n)));
    onUpdate(id, { meta });
    markInteracted();
    if (layout === "stack") requestAnimationFrame(() => restackFrame(id));
  }

  const memberH = (n: Note) =>
    n.h ?? measuredDimsRef.current.get(n.id)?.height ?? 96;

  // Live drag preview inside a kanban column: lay the OTHER members out with a
  // gap opened at the slot the dragged card currently hovers, so cards part to
  // reveal where it will land. Local-only (no persist) — the drop's restack
  // writes the final layout. With the stack-member CSS transition, the cards
  // glide as the gap moves.
  function layoutStackWithGap(frameId: string, draggedId: string, dragCenterY: number, dragH: number) {
    const frame = notesRef.current.find((n) => n.id === frameId);
    if (!frame) return;
    const members = notesRef.current
      .filter((n) => n.parentId === frameId && n.id !== draggedId)
      .sort((a, b) => a.y - b.y);
    const innerX = frame.x + FRAME_PAD;
    const top = frame.y + FRAME_LABEL_H + FRAME_PAD;
    // Insertion index: the first member whose vertical center sits below the
    // dragged card's center.
    let idx = members.length;
    let scan = top;
    for (let i = 0; i < members.length; i++) {
      const mh = memberH(members[i]);
      if (dragCenterY < scan + mh / 2) { idx = i; break; }
      scan += mh + STACK_GAP;
    }
    let cursorY = top;
    const moves: { id: string; x: number; y: number }[] = [];
    members.forEach((m, i) => {
      if (i === idx) cursorY += dragH + STACK_GAP;
      if (m.x !== innerX || m.y !== cursorY) moves.push({ id: m.id, x: innerX, y: cursorY });
      cursorY += memberH(m) + STACK_GAP;
    });
    if (!moves.length) return;
    setNotes((ns) => ns.map((n) => {
      const mv = moves.find((x) => x.id === n.id);
      return mv ? { ...n, x: mv.x, y: mv.y } : n;
    }));
  }

  // A ready-made kanban: a titled board frame wrapping three stacked columns.
  function spawnKanban(cx: number, cy: number) {
    markInteracted();
    const COL_W = 300, COL_H = 440, GAP = 32;
    const labels = ["To do", "Doing", "Done"];
    const innerW = labels.length * COL_W + (labels.length - 1) * GAP;
    const boardW = innerW + FRAME_PAD * 2;
    const boardH = COL_H + FRAME_PAD * 2 + FRAME_LABEL_H;
    const boardX = Math.round(cx - boardW / 2);
    const boardY = Math.round(cy - boardH / 2);
    const now = Date.now();
    const board: Note = {
      id: uid(), x: boardX, y: boardY, w: boardW, h: boardH, t: now,
      text: "Board", kind: "frame", color: null,
    };
    const colY = boardY + FRAME_LABEL_H + FRAME_PAD;
    const colX0 = boardX + FRAME_PAD;
    const cols: Note[] = labels.map((label, i) => ({
      id: uid(),
      x: colX0 + i * (COL_W + GAP),
      y: colY,
      w: COL_W,
      h: COL_H,
      t: now,
      text: label,
      kind: "frame",
      color: null,
      parentId: board.id,
      meta: { layout: "stack" } as FrameMeta,
    }));
    const created = [board, ...cols];
    setNotes((ns) => [...ns, ...created]);
    for (const n of created) { pushOp({ type: "create", id: n.id }); void onCreate(n); }
    setSelectedIds(new Set([board.id]));
  }

  // Every note nested (at any depth) under a frame — its columns, their cards,
  // and so on. Used for group-drag and subtree collapse.
  function descendantsOf(frameId: string): Set<string> {
    const out = new Set<string>();
    const stack = [frameId];
    while (stack.length) {
      const pid = stack.pop() as string;
      for (const n of notesRef.current) {
        if (n.parentId === pid && !out.has(n.id)) {
          out.add(n.id);
          if (n.kind === "frame") stack.push(n.id);
        }
      }
    }
    return out;
  }

  // ── Canvas objects (tables, …) ─────────────────────────────────────
  // A committed object edit updates state at once (so the render stays live)
  // and persists after a short idle — cell typing shouldn't PATCH per keystroke.
  // A pending timer also marks the note "locally dirty" so an incoming poll
  // doesn't clobber an edit in flight.
  const objPersistRef = useRef(new Map<string, number>());
  function onObjectState(id: string, meta: ObjectMeta) {
    const cur = notesRef.current.find((n) => n.id === id);
    if (!cur) return;
    setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, meta } : n)));
    markInteracted();
    const timers = objPersistRef.current;
    const prev = timers.get(id);
    if (prev) window.clearTimeout(prev);
    timers.set(id, window.setTimeout(() => {
      timers.delete(id);
      onUpdate(id, { meta });
    }, 500));
  }

  // Unsynced-edit flush: writes waiting on a debounce (object edits) or on an
  // edit-session commit (note text) would die with the tab. On tab-hide, push
  // them now; on pagehide (close/navigate), also commit the open editor. The
  // api-client marks small bodies keepalive so these survive the unload.
  // commitEditing closes over editingId state, so the mount-time listener goes
  // through a ref to reach the current render's version.
  const commitEditingRef = useRef<() => void>(() => {});
  commitEditingRef.current = commitEditing;
  useEffect(() => {
    const flushPending = () => {
      const timers = objPersistRef.current;
      for (const [id, timer] of timers) {
        window.clearTimeout(timer);
        timers.delete(id);
        const n = notesRef.current.find((x) => x.id === id);
        if (n?.meta) onUpdate(id, { meta: n.meta });
      }
      // Checkpoint an existing note's in-progress text without ending the edit
      // session (the user may come back). New notes wait for their first commit.
      const editing = editingIdRef.current;
      if (editing && !editSnapshotRef.current?.isNew) {
        const cur = notesRef.current.find((x) => x.id === editing);
        if (cur && editSnapshotRef.current && cur.text !== editSnapshotRef.current.prevText) {
          onUpdate(editing, { text: cur.text, t: Date.now() });
        }
      }
    };
    const onHide = () => { if (document.hidden) flushPending(); };
    const onPageHide = () => { flushPending(); commitEditingRef.current(); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function spawnObject(cx: number, cy: number, objectType: ObjectType = "table") {
    markInteracted();
    const id = uid();
    const w = objectType === "embed" ? 480 : 440;
    const parentId = hitFrame(cx, cy)?.id ?? null;
    const meta: ObjectMeta = objectType === "embed"
      ? { objectType: "embed", state: emptyEmbed() }
      : { objectType: "table", state: emptyTable() };
    const note: Note = {
      id, x: Math.round(cx - w / 2), y: Math.round(cy - 60), w, h: null, t: Date.now(),
      text: "", kind: "object", color: null, parentId,
      meta,
    };
    setNotes((ns) => [...ns, note]);
    pushOp({ type: "create", id });
    void onCreate(note);
    setSelectedIds(new Set([id]));
    if (parentId) scheduleReflow(id);
  }

  // Fold/unfold a frame. Collapsed members vanish from the canvas (state and
  // sync untouched), so they can't stay selected or mid-edit.
  function toggleFrameCollapsed(id: string) {
    const f = notesRef.current.find((n) => n.id === id);
    if (!f || f.kind !== "frame") return;
    const collapsed = !isCollapsed(f);
    const meta: FrameMeta = { ...((f.meta as FrameMeta | null) ?? {}), collapsed };
    setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, meta } : n)));
    onUpdate(id, { meta });
    if (collapsed) {
      // The whole subtree vanishes — a nested lane, its cards, everything — so
      // nothing folded away can stay selected or mid-edit.
      const memberIds = descendantsOf(id);
      if (editingIdRef.current && memberIds.has(editingIdRef.current)) commitEditing();
      setSelectedIds((prev) => {
        if (![...prev].some((x) => memberIds.has(x))) return prev;
        return new Set([...prev].filter((x) => !memberIds.has(x)));
      });
    }
    markInteracted();
  }

  // Run (or retry) a task card: flip it to running optimistically, then let the
  // Rust command drive the local claude CLI and PATCH the result back. The
  // task://updated event pulls the final status/result onto the canvas.
  function runTaskCard(id: string) {
    if (!isTauri) return;
    const cur = notesRef.current.find((n) => n.id === id);
    if (!cur || cur.kind !== "task") return;
    const meta: TaskMeta = { ...(cur.meta as TaskMeta), status: "running", startedAt: Date.now(), error: undefined };
    setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, meta } : n)));
    markInteracted();
    void import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke("run_task", { url: API_BASE_URL, noteId: id }).catch((err) => {
        console.error("[task] run failed", err);
        const errMeta: TaskMeta = { ...(notesRef.current.find((n) => n.id === id)?.meta as TaskMeta), status: "error", error: String(err) };
        setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, meta: errMeta } : n)));
      }),
    );
  }

  // Ask an agent about a cluster of notes. Assemble the selected notes (a
  // selected frame contributes its members) into a prompt, drop a task card
  // beside the cluster, and — on desktop — run it at once so the answer resolves
  // in place. On the web it stays queued for an MCP agent to answer via
  // update_task; either way the poll/merge pulls the result onto the canvas.
  function askCluster(noteIds: string[], question?: string) {
    const wanted = new Set<string>();
    let topic = "";
    for (const nid of noteIds) {
      const n = notesRef.current.find((x) => x.id === nid);
      if (!n) continue;
      if (n.kind === "frame") {
        if (!topic) topic = firstNonEmpty(n.text);
        for (const m of notesRef.current) if (m.parentId === n.id) wanted.add(m.id);
      } else {
        wanted.add(nid);
      }
    }
    // Fold in linked neighbours so asking along a thread carries its history
    // (this is what makes a follow-up work: ask on the answer → the question and
    // its prior answer come with it).
    const askIds = new Set(noteIds);
    for (const nid of linkedNeighbors(wanted)) wanted.add(nid);
    const members = notesRef.current.filter(
      (n) => wanted.has(n.id) && n.kind !== "task" && n.kind !== "image",
    );
    if (!members.length) return;

    const ordered = [...members].sort((a, b) => (Math.abs(a.y - b.y) > 40 ? a.y - b.y : a.x - b.x));
    const context = ordered.map((n) => n.text.trim()).filter(Boolean).join("\n\n---\n\n");
    const q = question?.trim();
    const prompt =
      `These notes come from a spatial thinking canvas` +
      (topic ? `, grouped under "${topic}"` : "") +
      `, listed in reading order:\n\n${context}\n\n---\n\n` +
      (q
        ? `Answer this question using the notes above as context:\n\n${q}`
        : `Using them as context, give a useful response: if they pose a question, answer it; ` +
          `if they are ideas or fragments, synthesize, extend, or reconcile them. Be concise.`);

    let maxX = -Infinity, minY = Infinity;
    for (const n of members) {
      const m = measuredDimsRef.current.get(n.id);
      const w = n.w ?? m?.width ?? tweakRef.current.noteWidth;
      maxX = Math.max(maxX, n.x + w);
      minY = Math.min(minY, n.y);
    }
    const id = uid();
    const meta: TaskMeta = { status: "queued", prompt };
    const note: Note = {
      id,
      x: maxX + 48,
      y: minY,
      w: 320,
      h: null,
      t: Date.now(),
      text: q ? `Ask: ${q.slice(0, 60)}` : topic ? `Ask: ${topic}` : `Ask: ${members.length} note${members.length === 1 ? "" : "s"}`,
      kind: "task",
      color: null,
      meta,
    };
    setNotes((ns) => [...ns, note]);
    pushOp({ type: "create", id });
    setSelectedIds(new Set([id]));
    markInteracted();
    // Thread the answer back to what you asked — provenance, and the anchor a
    // follow-up ask reads its context from.
    for (const nid of askIds) if (notesRef.current.some((n) => n.id === nid)) linkNotes(id, nid);
    // Wait for the create to persist, then run it: desktop drives the local
    // claude CLI; web runs the user's own key browser-direct (BYOK).
    void Promise.resolve(onCreate(note)).then(() => {
      if (isTauri) runTaskCard(id);
      else void runWebAsk(id);
    });
  }

  // Web runner for a task card: answer it with the user's own AI key
  // (browser-direct), then resolve the task into a page (every note is a page).
  // No key set → leave it queued with a hint and open the key settings.
  async function runWebAsk(id: string) {
    const cur = notesRef.current.find((n) => n.id === id);
    if (!cur || cur.kind !== "task") return;
    const prompt = (cur.meta as TaskMeta).prompt;
    if (!hasAiKey()) {
      const meta: TaskMeta = { ...(cur.meta as TaskMeta), status: "error", error: "Add an AI key in Settings to run on the web." };
      setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, meta } : n)));
      onUpdate(id, { meta });
      setTokensOpen(true);
      return;
    }
    const running: TaskMeta = { ...(cur.meta as TaskMeta), status: "running", startedAt: Date.now(), error: undefined };
    setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, meta: running } : n)));
    onUpdate(id, { meta: running });
    try {
      // Stream the answer into the card's text so it types in live. Flush on a
      // timer (not every token) so the graph re-derives at most ~10×/s.
      let acc = "";
      let flush: number | null = null;
      const paint = () => { flush = null; setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, text: acc } : n))); };
      const answer = await runAiStream(
        "You are a thoughtful assistant helping someone think on a spatial canvas. Answer in clear, concise markdown.",
        prompt,
        (tok) => { acc += tok; if (flush == null) flush = window.setTimeout(paint, 90); },
      );
      if (flush != null) window.clearTimeout(flush);
      // Resolve into a page, mirroring the desktop run_task → page conversion.
      setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, kind: "page", text: answer, meta: null, t: Date.now() } : n)));
      onUpdate(id, { kind: "page", text: answer, meta: null, t: Date.now() });
    } catch (err) {
      const meta: TaskMeta = { ...(notesRef.current.find((n) => n.id === id)?.meta as TaskMeta), status: "error", error: String(err instanceof Error ? err.message : err) };
      setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, meta } : n)));
      onUpdate(id, { meta });
    }
  }

  // ── Focus / read mode ──────────────────────────────────────────────
  // Readable notes in reading order (top-to-bottom, then left-to-right),
  // excluding frames (structure, not content) and members hidden inside a
  // collapsed frame. This is the sequence j/k walks.
  function readableOrder(): Note[] {
    const collapsed = new Set(
      notesRef.current.filter((n) => n.kind === "frame" && isCollapsed(n)).map((n) => n.id),
    );
    return notesRef.current
      .filter((n) => n.kind !== "frame" && n.kind !== "object" && !(n.parentId && collapsed.has(n.parentId)))
      .sort((a, b) => (Math.abs(a.y - b.y) > 40 ? a.y - b.y : a.x - b.x));
  }

  function openFocus(id: string) {
    if (editingIdRef.current) commitEditing();
    if (ambientOpen) closeAmbient();
    setSelectedIds(new Set([id]));
    setFocusId(id);
    markInteracted();
  }

  // Step to the next/previous readable note without moving the camera.
  function stepFocus(delta: number) {
    const order = readableOrder();
    if (order.length === 0) return;
    const cur = focusIdRef.current;
    const idx = order.findIndex((n) => n.id === cur);
    const next = order[(idx + delta + order.length) % order.length];
    if (next) { setFocusId(next.id); setSelectedIds(new Set([next.id])); }
  }

  // Named-neighborhood navigation: fit the frame (plus breathing room) in view.
  function flyToFrame(f: Note) {
    const r = frameRectOf(f);
    const { W, H } = canvasSize();
    const pad = 90;
    const zoom = Math.max(0.32, Math.min(1.2, Math.min((W - pad * 2) / r.w, (H - pad * 2) / r.h)));
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    animateView({ pan: { x: W / 2 - cx * zoom, y: H / 2 - cy * zoom }, zoom });
    prevViewRef.current = null;
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
    // Close the gap left in a kanban column.
    if (cur.parentId) requestAnimationFrame(() => reflowFrame(cur.parentId!));
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
    // Frames navigate rather than edit.
    if (n.kind === "frame") {
      setSelectedIds(new Set([n.id]));
      flyToFrame(n);
      return;
    }
    // A member of a folded frame is invisible — unfold before flying there.
    const parent = n.parentId ? notesRef.current.find((x) => x.id === n.parentId) : null;
    if (parent && isCollapsed(parent)) toggleFrameCollapsed(parent.id);
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
      onDimensions: () => { setDimsTick((v) => v + 1); scheduleStackSettle(); },
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
  // The stack column currently showing a live insertion gap during a card drag.
  const stackPreviewRef = useRef<string | null>(null);
  // The column highlighted as the drop target (drives the frame's lane glow).
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

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
      // The whole subtree rides — nested lanes AND their cards — all moving by
      // this frame's delta so a board and everything in it travels as one piece.
      for (const id of descendantsOf(n.id)) {
        if (map.has(id) || members.has(id)) continue;
        const m = notesRef.current.find((x) => x.id === id);
        if (m) members.set(id, { sx: m.x, sy: m.y, frameId: n.id });
      }
    }
    frameMembersRef.current = members.size ? members : null;
  }

  // Live tick during a drag.
  function handleNodeDrag(_: unknown, node: NoteFlowNode, dragged: NoteFlowNode[]) {
    const starts = dragStartRef.current;
    if (!starts) return;
    const members = frameMembersRef.current;
    if (members) {
      // A frame is dragging — carry its riding members so the group moves as one.
      const framePos = new Map(dragged.map((d) => [d.id, d.position]));
      setNotes((ns) => ns.map((n) => {
        const m = members.get(n.id);
        if (!m) return n;
        const fp = framePos.get(m.frameId);
        const fs = starts.get(m.frameId);
        if (!fp || !fs) return n;
        return { ...n, x: m.sx + (fp.x - fs.x), y: m.sy + (fp.y - fs.y) };
      }));
      return;
    }
    // A single card is dragging — if it's over a kanban column, part the cards
    // to reveal the slot it will drop into.
    if (dragged.length !== 1) return;
    const card = notesRef.current.find((n) => n.id === node.id);
    if (!card || card.kind === "frame") return;
    const dim = measuredDimsRef.current.get(card.id);
    const w = card.w ?? dim?.width ?? tweakRef.current.noteWidth;
    const h = card.h ?? dim?.height ?? 96;
    const cx = node.position.x + w / 2;
    const cy = node.position.y + h / 2;
    const target = hitFrame(cx, cy);
    if (target && frameLayoutOf(target) === "stack") {
      if (stackPreviewRef.current && stackPreviewRef.current !== target.id) {
        restackFrame(stackPreviewRef.current); // repack the column we just left
      }
      stackPreviewRef.current = target.id;
      layoutStackWithGap(target.id, card.id, cy, h);
      setDropTargetId(target.id);
    } else if (stackPreviewRef.current) {
      restackFrame(stackPreviewRef.current);
      stackPreviewRef.current = null;
      setDropTargetId(null);
    }
  }

  function handleNodeDragStop(_: unknown, node: NoteFlowNode, dragged: NoteFlowNode[]) {
    // RF can fire a click on the drop target right after a drag; swallow it so
    // a completed drag never falls into click-to-edit.
    justDraggedRef.current = true;
    window.setTimeout(() => { justDraggedRef.current = false; }, 0);
    setDraggingId(null);
    stackPreviewRef.current = null;
    setDropTargetId(null);
    const starts = dragStartRef.current;
    dragStartRef.current = null;
    const members = frameMembersRef.current;
    frameMembersRef.current = null;
    if (!starts) return;

    const draggedAFrame = dragged.some((d) => notesRef.current.find((n) => n.id === d.id)?.kind === "frame");
    if (dragged.length === 1 && !draggedAFrame) {
      const sp = starts.get(node.id);
      const cur = notesRef.current.find((n) => n.id === node.id);
      if (!sp || !cur) return;
      // Trust RF's node.position for the drop location — notesRef lags a render
      // behind the drag, so a fast drop can otherwise read the stale start point.
      const fx = node.position.x, fy = node.position.y;
      if (sp.x === fx && sp.y === fy) return;
      pushOp({ type: "move", id: node.id, prevX: sp.x, prevY: sp.y });

      const dim = measuredDimsRef.current.get(node.id);
      const selfW = cur.w ?? dim?.width ?? tweakRef.current.noteWidth;
      const selfH = cur.h ?? dim?.height ?? 96;
      const target = hitFrame(fx + selfW / 2, fy + selfH / 2);
      const prevParent = cur.parentId ?? null;

      // Dropped into (or reordered within) a kanban column: commit the landing
      // position + membership, then reflow the stack by drop-Y.
      if (target && frameLayoutOf(target) === "stack") {
        setNotes((ns) => ns.map((n) => (n.id === node.id ? { ...n, x: fx, y: fy, parentId: target.id } : n)));
        if (prevParent !== target.id) onUpdate(node.id, { parentId: target.id });
        scheduleReflow(node.id);
        if (prevParent && prevParent !== target.id) requestAnimationFrame(() => reflowFrame(prevParent));
        return;
      }

      // Free drop: snap to the nearest free spot so cards never stack, then
      // re-derive membership from the landing spot (fresh position, not notesRef).
      const spot = resolveFreePosition(fx, fy, selfW, selfH, measureRects(node.id));
      const landedIn = hitFrame(spot.x + selfW / 2, spot.y + selfH / 2);
      const nextParent = landedIn ? landedIn.id : null;
      setNotes((ns) => ns.map((n) => (n.id === node.id ? { ...n, x: spot.x, y: spot.y, parentId: nextParent } : n)));
      if (spot.x !== fx || spot.y !== fy) {
        setSnappingId(node.id);
        window.setTimeout(() => setSnappingId((s) => (s === node.id ? null : s)), 340);
      }
      onUpdate(node.id, { x: spot.x, y: spot.y });
      if (prevParent !== nextParent) onUpdate(node.id, { parentId: nextParent });
      scheduleReflow(node.id);
      // Pulled out of a stack column? close its gap.
      if (prevParent && prevParent !== nextParent) requestAnimationFrame(() => reflowFrame(prevParent));
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
    if (draggedAFrame) { recheckAllContainment(); requestAnimationFrame(restackAllStacks); }
    else { for (const d of dragged) { applyContainment(d.id); scheduleReflow(d.id); } requestAnimationFrame(restackAllStacks); }
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
    // Image and task cards have no in-place editor.
    const dk = notesRef.current.find((n) => n.id === node.id)?.kind;
    if (dk === "image" || dk === "task") return;
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
    // Right-click a frame's empty body → the create menu, so you can drop a
    // note (or another frame) inside it; the note adopts the frame as parent.
    // The label bar still opens the frame's own menu (color / collapse / delete).
    const n = notesRef.current.find((x) => x.id === node.id);
    if (n?.kind === "frame" && !(e.target as HTMLElement).closest(".frame-bar")) {
      const c = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      setContextMenu(null);
      setGlobalMenu(null);
      setCanvasMenu({ x: e.clientX, y: e.clientY, cx: c.x, cy: c.y });
      return;
    }
    setContextMenu({ id: node.id, x: e.clientX, y: e.clientY });
  }

  // Create an undirected thread between two notes (deduped, normalized a<b).
  function linkNotes(s: string, t2: string) {
    if (!s || !t2 || s === t2) return;
    const [a, b] = s < t2 ? [s, t2] : [t2, s];
    if (linksRef.current.some((l) => l.a === a && l.b === b)) return;
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

  // Ids linked (1 hop) to any of the given notes — the thread neighbours whose
  // text an ask folds in as context, so following a thread carries its history.
  function linkedNeighbors(ids: Set<string>): Set<string> {
    const out = new Set<string>();
    for (const l of linksRef.current) {
      if (ids.has(l.a)) out.add(l.b);
      if (ids.has(l.b)) out.add(l.a);
    }
    return out;
  }

  function handleConnect(conn: Pick<Connection, "source" | "target">) {
    if (!conn.source || !conn.target) return;
    markInteracted();
    linkNotes(conn.source, conn.target);
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
        if (focusIdRef.current) setFocusId(null);
        else if (contextMenu) setContextMenu(null);
        else if (canvasMenu) setCanvasMenu(null);
        else if (globalMenu) setGlobalMenu(null);
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

      // Focus/read mode owns the keyboard while open. Arrows / PageUp-Down /
      // Space / Home / End SCROLL the note (the reader body isn't focusable, so
      // scroll it by hand); j/k step to the prev/next note; Enter edits;
      // everything else is swallowed so canvas shortcuts don't fire behind it.
      if (focusIdRef.current) {
        if (e.key === "j") { e.preventDefault(); stepFocus(1); return; }
        if (e.key === "k") { e.preventDefault(); stepFocus(-1); return; }
        if (e.key === "Enter") {
          e.preventDefault();
          const id = focusIdRef.current;
          const n = id ? notesRef.current.find((x) => x.id === id) : null;
          setFocusId(null);
          if (n && (n.kind === "card" || n.kind === "page")) { editClickRef.current = null; focusNoteForEdit(n); startEditingExisting(n.id); }
          return;
        }
        const body = document.querySelector<HTMLElement>(".reader-body");
        if (body) {
          const page = body.clientHeight * 0.9;
          if (e.key === "ArrowDown") { e.preventDefault(); body.scrollTop += 60; return; }
          if (e.key === "ArrowUp") { e.preventDefault(); body.scrollTop -= 60; return; }
          if (e.key === "PageDown" || e.key === " ") { e.preventDefault(); body.scrollTop += page; return; }
          if (e.key === "PageUp") { e.preventDefault(); body.scrollTop -= page; return; }
          if (e.key === "Home") { e.preventDefault(); body.scrollTop = 0; return; }
          if (e.key === "End") { e.preventDefault(); body.scrollTop = body.scrollHeight; return; }
        }
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        if (editingId) { e.preventDefault(); commitEditing(); return; }
        if (ambientOpen) { e.preventDefault(); commitAmbient(true); return; }
        if (selectedIdsRef.current.size > 0) { e.preventDefault(); askCluster([...selectedIdsRef.current]); return; }
      }

      if (!isInput && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }

      // ⌘C / ⌘D — copy / duplicate the selected notes. Gated on !editing so the
      // editor keeps native text copy; ⌘V paste is handled by the paste listener.
      if (!isInput && !editingId && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c" && selectedIdsRef.current.size > 0) {
        e.preventDefault();
        copyNotes([...selectedIdsRef.current]);
        return;
      }
      if (!isInput && !editingId && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d" && selectedIdsRef.current.size > 0) {
        e.preventDefault();
        duplicateNotes([...selectedIdsRef.current]);
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

      // Enter on a single selected note opens it in the reader.
      if (e.key === "Enter" && !editingId && !ambientOpen && selectedIdsRef.current.size === 1) {
        e.preventDefault();
        openFocus([...selectedIdsRef.current][0]);
        return;
      }

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
  }, [editingId, ambientOpen, helpOpen, tweaksOpen, authPanelOpen, graveyardOpen, contextMenu, canvasMenu, globalMenu, recallQuery, recallIdx, matchIds]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  // Right-click anywhere on the app chrome — sidebar background, toolbar,
  // reader backdrop — opens a global misc menu (and suppresses the browser's
  // native menu; this is a canvas surface, not a document). The canvas pane and
  // notes stopPropagation in their own handlers, so those never reach here —
  // they keep their spatial / note menus. Editors and tree rows opt out (native
  // paste; the tree wires its own note menu).
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, [contenteditable="true"], .cm-editor')) return;
      e.preventDefault();
      if (t?.closest(".note-ctx, .ft-note")) return; // inside a menu, or a tree note (its own menu)
      setContextMenu(null);
      setCanvasMenu(null);
      setGlobalMenu({ x: e.clientX, y: e.clientY });
    };
    window.addEventListener("contextmenu", onCtx);
    return () => window.removeEventListener("contextmenu", onCtx);
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

      // Image paste (screenshot in the clipboard, copied image file) becomes
      // an image card, taking priority over any text representation.
      const imageFiles = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (imageFiles.length > 0) {
        e.preventDefault();
        markInteracted();
        const sx = lastMouseRef.current?.x ?? window.innerWidth / 2;
        const sy = lastMouseRef.current?.y ?? window.innerHeight / 2;
        const c = screenToCanvas(sx, sy);
        imageFiles.forEach((f, i) => void uploadImageAt(c.x + i * 36, c.y + i * 36, f));
        return;
      }

      const text = e.clipboardData?.getData("text/plain")?.trim();
      if (!text) return;
      e.preventDefault();
      markInteracted();

      const sx = lastMouseRef.current?.x ?? window.innerWidth / 2;
      const sy = lastMouseRef.current?.y ?? window.innerHeight / 2;
      const c = screenToCanvas(sx, sy);

      // If the clipboard text is exactly what we last copied from notes, paste
      // the full copies (kind/color/meta), not a plain-text re-creation.
      const internal = noteClipboardRef.current;
      if (internal.length && text === internal.map((n) => n.text).filter(Boolean).join("\n\n").trim()) {
        pasteNotesAt(c.x, c.y);
        return;
      }

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

  // A local run_task job PATCHed a task card's status — pull the change in at
  // once (the 20s poll would eventually catch it, but the run is interactive).
  useEffect(() => {
    if (!isTauri || !refresh) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      if (cancelled) return;
      unlisten = await listen<string>("task://updated", async () => {
        const server = await refresh();
        if (!cancelled) mergeServer(server);
      });
    })();
    return () => { cancelled = true; unlisten?.(); };
  }, [refresh, mergeServer]);

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
      const n = notesRef.current.find((x) => x.id === id);
      // A resized frame border may have swallowed or released notes; a resized
      // member may now poke out of its frame — grow the frame to fit.
      if (n?.kind === "frame") {
        recheckAllContainment();
        if (frameLayoutOf(n) === "stack") requestAnimationFrame(() => restackFrame(n.id));
      } else if (n?.parentId) reflowFrame(n.parentId);
    },
    onToggleCollapse: (id) => toggleFrameCollapsed(id),
    onToggleHeight: (id) => toggleNoteHeight(id),
    onToggleLayout: (id) => {
      const f = notesRef.current.find((n) => n.id === id);
      if (f) setFrameLayout(id, frameLayoutOf(f) === "stack" ? "free" : "stack");
    },
    onFrameLabelClick: (id) => {
      const f = notesRef.current.find((n) => n.id === id);
      if (f) { markInteracted(); flyToFrame(f); }
    },
    onRunTask: (id) => { if (isTauri) runTaskCard(id); else void runWebAsk(id); },
    onObjectState: (id, meta) => onObjectState(id, meta),
  };
  const nodeHandlers = useMemo<NoteNodeHandlers>(() => ({
    onTextChange: (id, v) => nodeHandlersRef.current.onTextChange(id, v),
    onCommitEdit: () => nodeHandlersRef.current.onCommitEdit(),
    onTagClick: (tag) => nodeHandlersRef.current.onTagClick(tag),
    onToggleTask: (id, i) => nodeHandlersRef.current.onToggleTask(id, i),
    onResize: (id, p) => nodeHandlersRef.current.onResize(id, p),
    onResizeEnd: (id, p) => nodeHandlersRef.current.onResizeEnd(id, p),
    onToggleCollapse: (id) => nodeHandlersRef.current.onToggleCollapse(id),
    onToggleHeight: (id) => nodeHandlersRef.current.onToggleHeight(id),
    onToggleLayout: (id) => nodeHandlersRef.current.onToggleLayout(id),
    onFrameLabelClick: (id) => nodeHandlersRef.current.onFrameLabelClick(id),
    onRunTask: (id) => nodeHandlersRef.current.onRunTask?.(id),
    onObjectState: (id, meta) => nodeHandlersRef.current.onObjectState(id, meta),
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
        expandedIds,
        editClickPos: editClickRef.current,
        measuredDims: measuredDimsRef.current,
        dropTargetId,
        handlers: nodeHandlers,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [notes, selectedIds, editingId, draggingId, snappingId, matchSet, matchIds, recallIdx, scrubMoment, clipboardIds, expandedIds, dropTargetId, nodeHandlers, dimsTick],
  );

  const edges = useMemo(
    () => buildThreadEdges({ notes, links, selectedLinkId, relationsOn, hoveredId, selectedIds }),
    [notes, links, selectedLinkId, relationsOn, hoveredId, selectedIds],
  );

  const NOTE_FONTS: Record<Tweaks["noteFont"], string> = {
    sans: "var(--font-jn-sans), ui-sans-serif, system-ui, sans-serif",
    serif: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif',
    mono: "var(--font-jn-mono), ui-monospace, monospace",
  };
  const rootStyle: CSSProperties = {
    ["--radius" as string]: `${t.radius}px`,
    ["--note-w" as string]: `${t.noteWidth}px`,
    ["--note-font" as string]: NOTE_FONTS[t.noteFont ?? "sans"],
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
        onNoteContextMenu={(boardId, noteId, mx, my) => {
          // The note menu reads the live `notes` state, which only holds the
          // active board. For another board, jump there first (it selects the
          // note); the user can right-click again once it's live.
          if (boardId !== activeBoardId) { onBoardJump(boardId, noteId); return; }
          setGlobalMenu(null);
          setCanvasMenu(null);
          setSelectedIds(new Set([noteId]));
          setContextMenu({ id: noteId, x: mx, y: my });
        }}
        onCreateNote={createTreeNote}
        onSwitchBoard={onSwitchBoard}
        onCreateBoard={onCreateBoard}
        onRenameBoard={onRenameBoard}
        onDeleteBoard={onDeleteBoard}
        onDuplicateBoard={onDuplicateBoard}
        onRefreshBoard={refreshBoard}
      />

      <div
        ref={canvasRef}
        className={"jn-flow" + (moving ? " moving" : "") + (inOverview ? " overview" : "")}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDrop={(e) => {
          const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
          if (files.length === 0) return;
          e.preventDefault();
          markInteracted();
          const c = screenToCanvas(e.clientX, e.clientY);
          files.forEach((f, i) => void uploadImageAt(c.x + i * 36, c.y + i * 36, f));
        }}
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

      {t.compass && <Compass notes={notes} view={view} flyHome={flyHome} />}

      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}

      {focusId && (() => {
        const order = readableOrder();
        const idx = order.findIndex((n) => n.id === focusId);
        const fn = idx >= 0 ? order[idx] : notes.find((n) => n.id === focusId);
        if (!fn) return null;
        return (
          <FocusReader
            note={fn}
            index={idx < 0 ? 0 : idx}
            total={order.length || 1}
            onClose={() => setFocusId(null)}
            onPrev={() => stepFocus(-1)}
            onNext={() => stepFocus(1)}
            onEdit={() => {
              setFocusId(null);
              if (fn.kind === "card" || fn.kind === "page") { editClickRef.current = null; focusNoteForEdit(fn); startEditingExisting(fn.id); }
            }}
          />
        );
      })()}

      {contextMenu && (() => {
        const n = notes.find((x) => x.id === contextMenu.id);
        // Ask the whole selection when the right-clicked note is part of a
        // multi-select; otherwise ask this frame / this note.
        const inMultiSel = selectedIds.has(contextMenu.id) && selectedIds.size > 1;
        const askIds = inMultiSel ? [...selectedIds] : [contextMenu.id];
        const askLabel = inMultiSel
          ? `ask these ${selectedIds.size} notes`
          : n?.kind === "frame" ? "ask this frame" : "ask this note";
        return (
          <NoteContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            kind={n?.kind ?? "card"}
            color={n?.color ?? null}
            frameLayout={n?.kind === "frame" ? frameLayoutOf(n) : undefined}
            askLabel={askLabel}
            onAsk={() => { setContextMenu(null); askCluster(askIds); }}
            onFollowUp={() => {
              const label = inMultiSel ? `${selectedIds.size} notes` : firstNonEmpty(n?.text ?? "") || "this note";
              setContextMenu(null);
              setFollowUp({ ids: askIds, label });
            }}
            onDuplicate={() => { setContextMenu(null); duplicateNotes(askIds); }}
            onCopy={() => { setContextMenu(null); copyNotes(askIds); }}
            onSetColor={(c) => setNoteColor(contextMenu.id, c)}
            onClose={() => setContextMenu(null)}
            onToggleLayout={n?.kind === "frame" ? () => {
              const id = contextMenu.id;
              setContextMenu(null);
              setFrameLayout(id, frameLayoutOf(n) === "stack" ? "free" : "stack");
            } : undefined}
            onRead={n && n.kind !== "frame" ? () => { const id = contextMenu.id; setContextMenu(null); openFocus(id); } : undefined}
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

      {followUp && (
        <FollowUpBar
          label={followUp.label}
          onSubmit={(question) => {
            const ids = followUp.ids;
            setFollowUp(null);
            if (question.trim()) askCluster(ids, question.trim());
          }}
          onCancel={() => setFollowUp(null)}
        />
      )}

      {canvasMenu && (
        <CanvasContextMenu
          x={canvasMenu.x}
          y={canvasMenu.y}
          hasNotes={notes.length > 0}
          onClose={() => setCanvasMenu(null)}
          onNew={(k) => { markInteracted(); spawnAt(canvasMenu.cx, canvasMenu.cy, "", k); setCanvasMenu(null); }}
          onTable={() => { spawnObject(canvasMenu.cx, canvasMenu.cy, "table"); setCanvasMenu(null); }}
          onEmbed={() => { spawnObject(canvasMenu.cx, canvasMenu.cy, "embed"); setCanvasMenu(null); }}
          onKanban={() => { spawnKanban(canvasMenu.cx, canvasMenu.cy); setCanvasMenu(null); }}
          onPaste={() => { void pasteAtCanvas(canvasMenu.cx, canvasMenu.cy); setCanvasMenu(null); }}
          onOpenFile={() => { openFilesAt(canvasMenu.cx, canvasMenu.cy); setCanvasMenu(null); }}
          onSelectAll={() => { setSelectedIds(new Set(notesRef.current.map((n) => n.id))); setCanvasMenu(null); }}
          onFit={() => { fitToScreen(); setCanvasMenu(null); }}
          onRefreshBoard={() => { refreshBoard(activeBoardId); setCanvasMenu(null); }}
          onDuplicateBoard={() => { onDuplicateBoard(activeBoardId); setCanvasMenu(null); }}
        />
      )}

      {globalMenu && (() => {
        const close = () => setGlobalMenu(null);
        const run = (fn: () => void) => { close(); markInteracted(); fn(); };
        return (
          <GlobalContextMenu
            x={globalMenu.x}
            y={globalMenu.y}
            hasNotes={notes.length > 0}
            relationsOn={relationsOn}
            isAnonymous={isAnonymous}
            onClose={close}
            onNewNote={() => run(() => spawnAtCenter(""))}
            onSearch={() => run(() => openAmbient(""))}
            onOverview={() => run(() => toggleOverview())}
            onRelations={() => run(() => setRelationsOn((v) => { if (v) setHoveredId(null); return !v; }))}
            onFit={() => run(() => fitToScreen())}
            onGraveyard={() => run(() => setGraveyardOpen(true))}
            onTweaks={() => run(() => setTweaksOpen(true))}
            onHelp={() => run(() => setHelpOpen(true))}
            onAccount={() => run(() => (isAnonymous ? setAuthPanelOpen(true) : setAuthPanelOpen(true)))}
          />
        );
      })()}

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

// A slim input for a typed follow-up question, anchored to a note (or the
// selection). Enter asks; Escape cancels. Context comes from the anchor and its
// linked neighbours, and the answer threads back to the anchor.
function FollowUpBar({ label, onSubmit, onCancel }: { label: string; onSubmit: (q: string) => void; onCancel: () => void }) {
  const [q, setQ] = useState("");
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="followup-bar" onMouseDown={(e) => e.stopPropagation()}>
      <span className="followup-label">Follow up on <b>{label.length > 40 ? label.slice(0, 40) + "…" : label}</b></span>
      <input
        ref={ref}
        className="followup-input"
        placeholder="Ask a question…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") onSubmit(q);
          else if (e.key === "Escape") onCancel();
        }}
      />
    </div>
  );
}

function NoteContextMenu({
  x, y, kind, color, frameLayout, askLabel, onAsk, onFollowUp, onDuplicate, onCopy, onSetColor, onClose, onDelete, onDeleteContents, onRead, onToggleLayout,
}: {
  x: number; y: number;
  kind: NoteKind; color: string | null;
  // Frames only: current member layout, and a toggle between free/stack.
  frameLayout?: "free" | "stack";
  // Hand this note / frame / selection to an agent as context.
  askLabel?: string;
  onAsk?: () => void;
  // Ask a typed question anchored here (a follow-up along the thread).
  onFollowUp?: () => void;
  onDuplicate?: () => void;
  onCopy?: () => void;
  onSetColor: (c: string | null) => void;
  onClose: () => void; onDelete: () => void;
  // Open in the reader (non-frames).
  onRead?: () => void;
  onToggleLayout?: () => void;
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
      {onRead && (
        <button className="note-ctx-item" onClick={onRead}>
          read
          <span className="note-ctx-hint">↵</span>
        </button>
      )}
      {onCopy && (
        <button className="note-ctx-item" onClick={onCopy}>
          copy
          <span className="note-ctx-hint">⌘C</span>
        </button>
      )}
      {onDuplicate && (
        <button className="note-ctx-item" onClick={onDuplicate}>
          duplicate
          <span className="note-ctx-hint">⌘D</span>
        </button>
      )}
      {onAsk && askLabel && (
        <button className="note-ctx-item" onClick={onAsk}>
          {askLabel}
          <span className="note-ctx-hint">⌘↵</span>
        </button>
      )}
      {onFollowUp && (
        <button className="note-ctx-item" onClick={onFollowUp}>
          ask a follow-up…
        </button>
      )}
      {kind === "frame" && onToggleLayout && (
        <button className="note-ctx-item" onClick={onToggleLayout}>
          {frameLayout === "stack" ? "free layout" : "stack items"}
        </button>
      )}
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
  x, y, hasNotes, onClose, onNew, onKanban, onTable, onEmbed, onPaste, onOpenFile, onSelectAll, onFit, onRefreshBoard, onDuplicateBoard,
}: {
  x: number; y: number; hasNotes: boolean;
  onClose: () => void;
  onNew: (k: NoteKind) => void;
  onKanban: () => void;
  onTable: () => void;
  onEmbed: () => void;
  onPaste: () => void;
  onOpenFile: () => void;
  onSelectAll: () => void;
  onFit: () => void;
  onRefreshBoard: () => void;
  onDuplicateBoard: () => void;
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

  const W = 184, H = 320;
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
      <div className="note-ctx-types" role="group" aria-label="new item">
        {(["page", "frame"] as NoteKind[]).map((k) => (
          <button key={k} type="button" className="note-ctx-type" onClick={() => onNew(k)}>
            {k === "page" ? "note" : k}
          </button>
        ))}
      </div>
      <button className="note-ctx-item" onClick={onKanban}>kanban board</button>
      <button className="note-ctx-item" onClick={onTable}>table</button>
      <button className="note-ctx-item" onClick={onEmbed}>embed</button>
      <div className="note-ctx-sep" aria-hidden="true" />
      <button className="note-ctx-item" onClick={onPaste}>paste here</button>
      <button className="note-ctx-item" onClick={onOpenFile}>open file…</button>
      <button className="note-ctx-item" onClick={onSelectAll} disabled={!hasNotes}>select all</button>
      <button className="note-ctx-item" onClick={onFit} disabled={!hasNotes}>fit to screen</button>
      <div className="note-ctx-sep" aria-hidden="true" />
      <button className="note-ctx-item" onClick={onRefreshBoard}>refresh board</button>
      <button className="note-ctx-item" onClick={onDuplicateBoard}>duplicate board</button>
    </div>
  );
}

// Dismiss-on-outside-click hook shared by the menus.
function useMenuDismiss(onClose: () => void) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDocDown = (e: Event) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
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
  return menuRef;
}

// Right-click anywhere on the app chrome: app-wide misc actions (mirrors the
// toolbar + ⌘K palette, reachable from wherever the cursor is).
function GlobalContextMenu({
  x, y, hasNotes, relationsOn, isAnonymous,
  onClose, onNewNote, onSearch, onOverview, onRelations, onFit, onGraveyard, onTweaks, onHelp, onAccount,
}: {
  x: number; y: number; hasNotes: boolean; relationsOn: boolean; isAnonymous: boolean;
  onClose: () => void;
  onNewNote: () => void; onSearch: () => void; onOverview: () => void; onRelations: () => void;
  onFit: () => void; onGraveyard: () => void; onTweaks: () => void; onHelp: () => void; onAccount: () => void;
}) {
  const menuRef = useMenuDismiss(onClose);
  const W = 200, H = 344;
  const left = Math.min(x, window.innerWidth - W - 8);
  const top = Math.min(y, window.innerHeight - H - 8);
  const item = (label: string, onClick: () => void, hint?: string, disabled?: boolean) => (
    <button className="note-ctx-item" onClick={onClick} disabled={disabled}>
      {label}{hint && <span className="note-ctx-hint">{hint}</span>}
    </button>
  );
  return (
    <div ref={menuRef} className="note-ctx" style={{ left, top }} onMouseDown={(e) => e.stopPropagation()}>
      {item("New note", onNewNote)}
      {item("Search", onSearch, "⌘K")}
      <div className="note-ctx-sep" aria-hidden="true" />
      {item("Overview", onOverview, "z", !hasNotes)}
      {item(relationsOn ? "Hide relations" : "Show relations", onRelations, "r")}
      {item("Fit to screen", onFit, undefined, !hasNotes)}
      <div className="note-ctx-sep" aria-hidden="true" />
      {item("Recently deleted", onGraveyard)}
      {item("Settings", onTweaks, "⌘,")}
      {item("Help", onHelp, "?")}
      <div className="note-ctx-sep" aria-hidden="true" />
      {item(isAnonymous ? "Sign in" : "Account", onAccount)}
    </div>
  );
}

// ── FocusReader ────────────────────────────────────────────────────────
// A note opened for reading in a fixed, legible overlay — decoupled from
// canvas zoom, so a tiny note on the map is read at full size without
// panning or zooming. ↑↓ / j k step through notes; Enter edits; Esc closes.
function FocusReader({
  note, index, total, onClose, onPrev, onNext, onEdit,
}: {
  note: Note; index: number; total: number;
  onClose: () => void; onPrev: () => void; onNext: () => void; onEdit: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const col = resolveNoteColor(note.color);
  const meta = note.meta;
  const editable = note.kind === "card" || note.kind === "page";
  const title = firstNonEmpty(note.text) || (note.kind === "image" ? "Image" : note.kind === "task" ? "Task" : note.kind === "object" ? "Table" : "Untitled");

  // Card/page content is rendered with the note's OWN markup + classes so the
  // reader is pixel-identical to the canvas (same fonts, code chrome, colors),
  // just scaled up for reading (CSS zoom on .reader-note). Mirrors NoteNode.
  const first = firstNonEmpty(note.text);
  const rest = restAfterFirst(note.text);
  const headingMatch = first.trim().match(/^(#{1,6})\s+/);
  const headingLevel = headingMatch ? Math.min(headingMatch[1].length, 3) : 0;
  const startsWithBlock = /^\s*(`{3,}|>|[-*]\s+\[[ xX]\]|[-*]\s|\d+\.\s|!\[[^\]]*\]\(|(-{3,}|\*{3,})\s*$)/.test(first);
  const bodyColor = col ? `rgb(${col.ink})` : "rgb(var(--text-secondary))";
  const noteCls = `reader-note note kind-${note.kind}` + (col ? " tinted" : "");
  const noteStyle: CSSProperties = col ? { ["--note-ink" as string]: col.ink } : {};

  const surface: CSSProperties = col
    ? { background: col.bg, color: `rgb(${col.ink})`, ["--note-ink" as string]: col.ink }
    : {};

  return (
    <div
      className="reader-scrim"
      onPointerDown={onClose}
      // The reader is a narrow panel in a wide dimmed backdrop; a wheel over
      // the margin (or the header bar) should still scroll the content, not
      // fall on dead space. Redirect any wheel that isn't already inside the
      // scrollable body.
      onWheel={(e) => {
        const body = bodyRef.current;
        if (body && !body.contains(e.target as Node)) body.scrollTop += e.deltaY;
      }}
    >
      <div
        className={"reader" + (col ? " tinted" : "") + ` reader-${note.kind}`}
        style={surface}
        onPointerDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Note reader"
      >
        <div className="reader-bar">
          <span className="reader-count">{index + 1} / {total}</span>
          <div className="reader-actions">
            {editable && <button type="button" className="reader-btn" onClick={onEdit}>Edit <kbd>↵</kbd></button>}
            <button type="button" className="reader-btn" onClick={onClose} aria-label="Close reader">Close <kbd>Esc</kbd></button>
          </div>
        </div>
        <div className="reader-body" ref={bodyRef}>
          {note.kind === "image" ? (
            <>
              {(meta as ImageMeta | null)?.key && (
                <img className="reader-image" src={`${API_BASE_URL}/api/media/${(meta as ImageMeta).key}`} alt={(meta as ImageMeta).alt ?? ""} />
              )}
              {note.text && <div className="reader-caption">{note.text}</div>}
            </>
          ) : note.kind === "task" ? (
            <>
              <div className="reader-task-status">{(meta as TaskMeta | null)?.status ?? "queued"}</div>
              {(meta as TaskMeta | null)?.prompt && <div className="reader-task-prompt">{(meta as TaskMeta).prompt}</div>}
              {note.text && <div className={noteCls} style={noteStyle}><div className="note-rest">{renderBody(note.text)}</div></div>}
            </>
          ) : !note.text ? (
            <div className="reader-empty">empty</div>
          ) : (
            <div className={noteCls} style={noteStyle}>
              {startsWithBlock ? (
                <div className="note-rest" style={{ color: bodyColor }}>{renderBody(note.text)}</div>
              ) : (
                <>
                  <div className={"note-first" + (headingLevel ? ` md-h md-h${headingLevel}` : "")}>{renderHeadline(first)}</div>
                  {rest && <div className="note-rest" style={{ color: bodyColor }}>{renderBody(rest)}</div>}
                </>
              )}
            </div>
          )}
        </div>
        <button type="button" className="reader-nav reader-prev" onClick={onPrev} aria-label="Previous note" title="Previous note (k)">‹</button>
        <button type="button" className="reader-nav reader-next" onClick={onNext} aria-label="Next note" title="Next note (j)">›</button>
        <div className="reader-hint" aria-hidden="true">{title}</div>
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
      <div className="ghost-text">tap + to add a note · or right-click the canvas</div>
    </div>
  );
}
