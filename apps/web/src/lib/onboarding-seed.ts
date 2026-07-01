// x/y are top-left in canvas coordinates, clustered around origin (0,0) — the
// point the initial view centers on.
export type SeedNote = { x: number; y: number; text: string };

export const ONBOARDING_SEED: SeedNote[] = [
  {
    x: -360,
    y: -230,
    text: "Welcome 👋\n\nThis is your canvas — one quiet, infinite space for everything you want to keep close.",
  },
  {
    x: -90,
    y: -250,
    text: "Double-click a note to edit it.",
  },
  {
    x: 180,
    y: -170,
    text: "Drag me anywhere — arrange thoughts the way you hold them in your head.",
  },
  {
    x: -385,
    y: -20,
    text: "Drag anywhere to fly around. Scroll to roam, ⌘ + scroll to zoom. Hold ⌘ / Ctrl and drag to select.",
  },
  {
    x: -110,
    y: 30,
    text: "Just start typing to search — the canvas drifts you back to what you remember.",
  },
  {
    x: 185,
    y: 70,
    text: "Tag a thought with #ideas, then press r to thread related notes together.",
  },
  {
    x: -150,
    y: 250,
    text: "Click any empty space to write a new note. Delete these whenever — the canvas is yours from here. ✨",
  },
];
