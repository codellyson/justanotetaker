// How a single note presents itself. `card` is the everyday note (optionally
// tinted with a color); `page` a document surface a long note auto-promotes to;
// `frame` a containment region other notes belong to; `image` an uploaded
// picture; `task` a live agent job with a status lifecycle.
export type NoteKind = "card" | "page" | "frame" | "image" | "task";

// Kind-specific payloads carried in `meta`.
export type ImageMeta = {
  key: string;
  w: number;
  h: number;
  size: number;
  alt?: string;
};
export type TaskStatus = "queued" | "running" | "done" | "error";
export type TaskMeta = {
  status: TaskStatus;
  prompt: string;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
};
export type FrameMeta = {
  collapsed?: boolean;
};
export type NoteMeta = ImageMeta | TaskMeta | FrameMeta;

// Markdown task tally across a text: `- [ ]` and `- [x]` items.
export function countTasks(text: string): { done: number; total: number } {
  let done = 0, total = 0;
  for (const m of text.matchAll(/^\s*[-*]\s+\[([ xX])\]\s/gm)) {
    total++;
    if (m[1] !== " ") done++;
  }
  return { done, total };
}

export type Note = {
  id: string;
  x: number;
  y: number;
  w: number | null;
  h: number | null;
  t: number;
  text: string;
  kind: NoteKind;
  color: string | null;
  // Conversational role for agent-session boards: "assistant" = written by an
  // agent (via the MCP reply tool); null/absent = the person's own note.
  role?: string | null;
  // Frame membership: id of the containing frame note (null = board root).
  parentId?: string | null;
  // Kind-specific payload (image/task); null for plain notes.
  meta?: NoteMeta | null;
};

export type Recency = "fresh" | "recent" | "older" | "ancient";

export const GRID = 28;

// Paper is true A4 portrait at 96 CSS px/in (210×297mm ⇒ 794×1123px, 1:√2).
export const PAPER_W = 794;
export const PAPER_H = Math.round(PAPER_W * Math.SQRT2); // 1123
export const PAPER_GAP = 44;

// A card can be tinted with one of these colors (stored by key in `note.color`,
// chosen from the context menu; null = the default themed card).
export const NOTE_COLOR_KEYS = ["amber", "pink", "blue", "green", "violet", "orange"] as const;
export type NoteColorKey = (typeof NOTE_COLOR_KEYS)[number];

// `ink` is an "r g b" triplet (not hex) so it can drive both `rgb(…)` text
// colors and a CSS custom property that recolors muted tokens on a tint.
export const NOTE_COLOR_MAP: Record<NoteColorKey, { bg: string; ink: string }> = {
  amber: { bg: "#fde68a", ink: "113 63 18" },
  pink: { bg: "#fbcfe8", ink: "131 24 67" },
  blue: { bg: "#bfdbfe", ink: "30 58 138" },
  green: { bg: "#bbf7d0", ink: "20 83 45" },
  violet: { bg: "#ddd6fe", ink: "76 29 149" },
  orange: { bg: "#fed7aa", ink: "124 45 18" },
};

export function resolveNoteColor(color: string | null): { bg: string; ink: string } | null {
  return (color && NOTE_COLOR_MAP[color as NoteColorKey]) || null;
}

/**
 * Maps a note's `t` (last-touched timestamp) to one of four recency
 * buckets. Used to derive paper opacity + the recency-key legend in
 * Chrome. The thresholds (6h / 48h / 14d) are tuned for the canvas
 * vibe — "fresh" should still feel warm hours later, "ancient" should
 * feel like archive.
 */
export function recencyOf(ms: number): Recency {
  const h = (Date.now() - ms) / 3.6e6;
  if (h < 6) return "fresh";
  if (h < 48) return "recent";
  if (h < 24 * 14) return "older";
  return "ancient";
}

/**
 * Opacity multiplier per recency bucket. The base note style uses the
 * theme's bg-secondary token; multiplying by this number is what gives
 * older notes the faded-paper feeling without needing per-theme color
 * tables. The values are tuned against dark themes — light themes get
 * close-to-correct because the canvas bg behind them is also light.
 */
export const RECENCY_ALPHA: Record<Recency, number> = {
  fresh: 1.0,
  recent: 0.92,
  older: 0.78,
  ancient: 0.55,
};

export const uid = () => Math.random().toString(36).slice(2, 10);

export function parsePastedUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  if (/\s/.test(text)) return null;
  if (/^https?:\/\//i.test(text)) {
    try {
      return new URL(text).toString();
    } catch {
      return null;
    }
  }
  if (/^([a-z0-9][a-z0-9-]*\.)+[a-z]{2,}(\/.*)?$/i.test(text)) {
    try {
      return new URL("https://" + text).toString();
    } catch {
      return null;
    }
  }
  return null;
}

export const firstNonEmpty = (s: string) => {
  for (const line of s.split("\n")) if (line.trim()) return line;
  return "";
};

export const restAfterFirst = (s: string) => {
  const lines = s.split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  return lines.slice(i + 1).join("\n").replace(/^\n+/, "");
};

// Lowercased, de-duped #tags in a note. Same token shape as the inline
// markdown renderer (#word, letters/digits/-/_). Tags are the relationship
// substrate: two notes are "related" when they share at least one.
export function tagsOf(text: string): string[] {
  const re = /#[A-Za-z][A-Za-z0-9_-]*/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.add(m[0].slice(1).toLowerCase());
  return [...out];
}

// A board is a separate infinite canvas with its own notes + view mode.
export type Board = {
  id: string;
  name: string;
  sort: number;
};

export type Tweaks = {
  grid: "dots" | "lines" | "off";
  radius: number;
  noteWidth: number;
  snap: boolean;
  compass: boolean;
  // Desktop only: poll the OS clipboard and auto-create notes from new copies.
  clipboardCapture: boolean;
  // Whether clipboard-captured notes sync to the cloud. When false they stay
  // on this device only (localStorage), never sent to the API.
  clipboardSyncToCloud: boolean;
};

export const TWEAK_DEFAULTS: Tweaks = {
  grid: "dots",
  radius: 6,
  noteWidth: 220,
  snap: true,
  compass: true,
  clipboardCapture: false,
  clipboardSyncToCloud: true,
};

