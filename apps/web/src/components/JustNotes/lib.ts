// Per-mode card positions, synced with the note. Absent ⇒ that mode falls
// back to a freshly-declumped spot. Canvas (default) uses x/y, not this.
export type ModePos = {
  sticky?: { x: number; y: number };
  paper?: { x: number; y: number };
};

export type Note = {
  id: string;
  x: number;
  y: number;
  w: number | null;
  h: number | null;
  t: number;
  text: string;
  modePos: ModePos | null;
};

export type Recency = "fresh" | "recent" | "older" | "ancient";

export const GRID = 28;

// A view mode is a lens over the whole canvas; real note positions are kept
// underneath and restored on return to "default".
export type ViewMode = "default" | "sticky" | "paper";

// Card geometry, canvas units. Paper is A4 portrait (1:√2).
export const STICKY_SIZE = 190;
export const STICKY_GAP = 30;
export const PAPER_W = 420;
export const PAPER_H = Math.round(PAPER_W * Math.SQRT2); // 594
export const PAPER_GAP = 44;

// Assigned per note stably by id, so a sticky keeps its color across renders.
export const STICKY_COLORS: readonly { bg: string; ink: string }[] = [
  { bg: "#fde68a", ink: "#713f12" }, // amber
  { bg: "#fbcfe8", ink: "#831843" }, // pink
  { bg: "#bfdbfe", ink: "#1e3a8a" }, // blue
  { bg: "#bbf7d0", ink: "#14532d" }, // green
  { bg: "#ddd6fe", ink: "#4c1d95" }, // violet
  { bg: "#fed7aa", ink: "#7c2d12" }, // orange
];

export function stickyColorOf(id: string): { bg: string; ink: string } {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return STICKY_COLORS[h % STICKY_COLORS.length];
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

export type Tweaks = {
  grid: "dots" | "lines" | "off";
  radius: number;
  noteWidth: number;
  snap: boolean;
  editMode: "in place" | "focused";
  // Canvas view mode. Persisted, so reopening restores the last mode.
  viewMode: ViewMode;
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
  editMode: "in place",
  viewMode: "default",
  compass: true,
  clipboardCapture: false,
  clipboardSyncToCloud: true,
};

