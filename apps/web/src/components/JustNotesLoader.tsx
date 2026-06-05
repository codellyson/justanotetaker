import { useEffect, useState } from "react";
import JustNotes from "./JustNotes/JustNotes";
import { SEED, uid, type Note } from "./JustNotes/lib";
import { useNotes } from "../hooks/useNotes";
import { useSettings } from "../hooks/useSettings";

// Orchestrates "auth ready → load notes + settings → seed if first visit
// → render the canvas." Pulled out so JustNotes itself stays oblivious
// to storage timing; it accepts initialNotes + persistence callbacks
// and behaves like the in-memory original from there.
export function JustNotesLoader() {
  const notes = useNotes();
  const settings = useSettings();
  const [resolvedNotes, setResolvedNotes] = useState<Note[] | null>(null);

  useEffect(() => {
    if (resolvedNotes !== null) return;
    if (!notes.ready || !settings.ready || !notes.initialNotes) return;

    if (notes.initialNotes.length === 0 && !settings.seeded) {
      const seed: Note[] = SEED.map((s) => ({
        id: uid(),
        x: s.x,
        y: s.y,
        t: s.t,
        text: s.text,
      }));
      setResolvedNotes(seed);
      void notes.seedAndMarkSynced(seed);
      void settings.markSeeded();
    } else {
      setResolvedNotes(notes.initialNotes);
    }
  }, [notes, settings, resolvedNotes]);

  if (resolvedNotes === null) return null;

  return (
    <JustNotes
      initialNotes={resolvedNotes}
      tweaks={settings.tweaks}
      setTweak={settings.setTweak}
      onCreate={notes.onCreate}
      onUpdate={notes.onUpdate}
      onDelete={notes.onDelete}
    />
  );
}
