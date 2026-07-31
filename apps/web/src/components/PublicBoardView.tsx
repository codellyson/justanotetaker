import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import { API_BASE_URL } from "../lib/runtime";
import type { FrameMeta, Note, NoteKind, NoteMeta } from "./JustNotes/lib";
import type { NoteNodeHandlers } from "./JustNotes/flow/useNoteGraph";
import { PublicCanvas } from "./JustNotes/flow/PublicCanvas";

type PublicNote = {
  id: string;
  x: number;
  y: number;
  w: number | null;
  h: number | null;
  t: number;
  text: string;
  kind: string;
  color: string | null;
  role: string | null;
  parentId: string | null;
  meta: unknown;
};
type PublicBoard = {
  board: { id: string; name: string };
  notes: PublicNote[];
  links: { id: string; aId: string; bId: string }[];
};

const noop = () => {};

export function PublicBoardView() {
  const { boardId } = useParams();
  const [status, setStatus] = useState<"loading" | "missing" | "error" | "ready">("loading");
  const [boardName, setBoardName] = useState("");
  const [notes, setNotes] = useState<Note[]>([]);
  const [links, setLinks] = useState<{ id: string; a: string; b: string }[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!boardId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/api/public/boards/${boardId}`);
        if (cancelled) return;
        if (!res.ok) {
          setStatus(res.status === 404 ? "missing" : "error");
          return;
        }
        const data = (await res.json()) as PublicBoard;
        if (cancelled) return;
        setBoardName(data.board.name);
        setNotes(
          data.notes.map((n) => ({
            id: n.id,
            x: n.x,
            y: n.y,
            w: n.w,
            h: n.h,
            t: n.t,
            text: n.text,
            kind: (n.kind as NoteKind) ?? "card",
            color: n.color,
            role: n.role,
            parentId: n.parentId,
            meta: (n.meta as NoteMeta | null) ?? null,
          })),
        );
        setLinks(data.links.map((l) => ({ id: l.id, a: l.aId, b: l.bId })));
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [boardId]);

  // Collapse/expand work locally so viewers can fold frames and peek tall
  // notes; nothing persists.
  const handlers = useMemo<NoteNodeHandlers>(
    () => ({
      onTextChange: noop,
      onCommitEdit: noop,
      onTagClick: noop,
      onToggleTask: noop,
      onResize: noop,
      onResizeEnd: noop,
      onToggleCollapse: (id) =>
        setNotes((ns) =>
          ns.map((n) =>
            n.id === id
              ? { ...n, meta: { ...((n.meta as FrameMeta | null) ?? {}), collapsed: !(n.meta as FrameMeta | null)?.collapsed } }
              : n,
          ),
        ),
      onToggleLayout: noop,
      onFrameLabelClick: noop,
      onToggleHeight: (id) =>
        setExpandedIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        }),
      onObjectState: noop,
    }),
    [],
  );

  const embed = useMemo(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("embed") === "1" || window.parent !== window;
  }, []);

  if (status !== "ready") {
    const message =
      status === "loading" ? "loading…" : status === "missing" ? "this board isn't public" : "couldn't load this board";
    return (
      <div className="public-board-boot">
        <div>{message}</div>
        {status !== "loading" && (
          <a href="https://justanotetaker.kreativekorna.com">just a notetaker</a>
        )}
      </div>
    );
  }

  return (
    <div className="public-board">
      {!embed && (
        <header className="public-board-header">
          <span className="public-board-name">{boardName}</span>
          <a href="https://justanotetaker.kreativekorna.com" target="_blank" rel="noopener">
            made with just a notetaker
          </a>
        </header>
      )}
      <div className="public-board-canvas">
        <PublicCanvas notes={notes} links={links} expandedIds={expandedIds} handlers={handlers} />
      </div>
    </div>
  );
}
