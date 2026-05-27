export type Note = {
  id: string;
  x: number;
  y: number;
  t: number;
  text: string;
};

export type Recency = "fresh" | "recent" | "older" | "ancient";

export type PaperTone = {
  bg: string;
  fg: string;
  muted: string;
  alpha: number;
};

export type Palette = Record<Recency, PaperTone>;

export const AMBER = "#e8a13f";
export const GRID = 28;
export const WARM_MS = 2 * 60 * 1000;
export const INK_MS = 1000;

export const PALETTES: Record<string, Palette> = {
  warm: {
    fresh:   { bg: "#fcf7e5", fg: "#1a1611", muted: "#5d5648", alpha: 1.0 },
    recent:  { bg: "#f1ead8", fg: "#1a1611", muted: "#5d5648", alpha: 1.0 },
    older:   { bg: "#dcd5c2", fg: "#2a2520", muted: "#6b6557", alpha: 1.0 },
    ancient: { bg: "#9c9789", fg: "#2a2520", muted: "#534f47", alpha: 0.62 },
  },
  cool: {
    fresh:   { bg: "#eef3fb", fg: "#0f1622", muted: "#4a5568", alpha: 1.0 },
    recent:  { bg: "#dde5f0", fg: "#0f1622", muted: "#4a5568", alpha: 1.0 },
    older:   { bg: "#c4cdda", fg: "#1a2030", muted: "#525c6b", alpha: 1.0 },
    ancient: { bg: "#8e95a1", fg: "#1a2030", muted: "#3a4150", alpha: 0.62 },
  },
  mono: {
    fresh:   { bg: "#f3f3f0", fg: "#15151a", muted: "#555", alpha: 1.0 },
    recent:  { bg: "#e3e3df", fg: "#15151a", muted: "#555", alpha: 1.0 },
    older:   { bg: "#c8c8c2", fg: "#1f1f23", muted: "#4f4f54", alpha: 1.0 },
    ancient: { bg: "#8a8a85", fg: "#1f1f23", muted: "#3a3a3e", alpha: 0.6 },
  },
};

export function recencyOf(ms: number): Recency {
  const h = (Date.now() - ms) / 3.6e6;
  if (h < 6) return "fresh";
  if (h < 48) return "recent";
  if (h < 24 * 14) return "older";
  return "ancient";
}

export const uid = () => Math.random().toString(36).slice(2, 10);

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

export type Tweaks = {
  grid: "dots" | "lines" | "off";
  palette: "warm" | "cool" | "mono";
  bodyFont: "serif" | "sans";
  radius: number;
  glow: boolean;
  noteWidth: number;
  showRecencyKey: boolean;
  snap: boolean;
  editMode: "in place" | "focused";
  ink: boolean;
  warmTrail: boolean;
  paperAge: boolean;
  compass: boolean;
};

export const TWEAK_DEFAULTS: Tweaks = {
  grid: "dots",
  palette: "warm",
  bodyFont: "serif",
  radius: 2,
  glow: true,
  noteWidth: 220,
  showRecencyKey: false,
  snap: true,
  editMode: "in place",
  ink: true,
  warmTrail: true,
  paperAge: true,
  compass: true,
};

const NOW = Date.now();
const HOUR = 3.6e6;
const DAY = 24 * HOUR;

export const SEED: Omit<Note, "id">[] = [
  { x: -340, y: -180, t: NOW - 0.3 * HOUR, text: "the answer is that capture is the problem.\nnot organization." },
  { x:   20, y: -260, t: NOW - 1.5 * HOUR, text: "call mom\nthursday after 6" },
  { x:  300, y: -200, t: NOW - 3   * HOUR, text: "# groceries\n- oat milk\n- eggs\n- rye bread\n- clementines" },
  { x: -480, y:   30, t: NOW - 8   * HOUR, text: "ship date moved to the 14th\nemail eli, push the design review one week" },
  { x: -140, y:   60, t: NOW - 14  * HOUR, text: "if folders are the answer, **search** is broken" },
  { x:  210, y:   40, t: NOW - 26  * HOUR, text: "tuesday 11:30 — coffee w/ priya\nbluestone lane on greenwich\nhttps://maps.app.goo.gl/x" },
  { x:  500, y:    0, t: NOW - 1.8 * DAY,  text: "# book idea\na week with no calendar. you only get the next 30 minutes." },
  { x: -380, y:  240, t: NOW - 3.5 * DAY,  text: "rent due fri\nremember the parking permit" },
  { x:  -70, y:  280, t: NOW - 5   * DAY,  text: "rewatch tampopo. the food in it." },
  { x:  240, y:  260, t: NOW - 9   * DAY,  text: "dentist moved to thu 3:30\nthe new place on 6th" },
  { x:  540, y:  220, t: NOW - 16  * DAY,  text: "the second album is always the production. nobody remembers the songs." },
  { x: -620, y:  340, t: NOW - 20  * DAY,  text: "# interview prep — staff PM, fintech\n- the story: shipped X, learned Y, moved Z.\n- frame everything as a tradeoff, never a win.\n- questions to ask them: what's the last thing the team killed? who decided? what would have to be true for this product to exist in 5 years?\n- practice the comp number out loud. don't flinch." },
  { x: -240, y:  460, t: NOW - 28  * DAY,  text: "library card expires aug" },
  { x:  140, y:  470, t: NOW - 45  * DAY,  text: "passport. renew before sept. one photo left in the drawer." },
  { x:  460, y:  440, t: NOW - 78  * DAY,  text: "address for the cabin\n412 spruce, hwy 50 mile 8" },
];
