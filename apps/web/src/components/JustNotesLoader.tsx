import { useEffect, useRef, useState } from "react";
import JustNotes from "./JustNotes/JustNotes";
import type { Note } from "./JustNotes/lib";
import { uid } from "./JustNotes/lib";
import { useNotes } from "../hooks/useNotes";
import { useSettings } from "../hooks/useSettings";
import { authClient } from "../lib/auth-client";
import { ONBOARDING_SEED } from "../lib/onboarding-seed";
import { seedIdStore } from "../lib/seed-ids";

export function JustNotesLoader() {
  const { data: session, isPending } = authClient.useSession();
  const userId = session?.user?.id;
  if (isPending || !userId) return null;
  return <Session key={userId} />;
}

function Session() {
  const notes = useNotes();
  const settings = useSettings();
  const [resolved, setResolved] = useState<Note[] | null>(null);
  const [seedIds, setSeedIds] = useState<string[]>([]);
  const doneRef = useRef(false);

  useEffect(() => {
    if (!notes.ready || !settings.ready || !notes.initialNotes) return;
    if (doneRef.current) return;
    doneRef.current = true;

    if (notes.initialNotes.length === 0 && !settings.seeded) {
      const now = Date.now();
      const seeds: Note[] = ONBOARDING_SEED.map((s, i) => ({
        id: uid(),
        x: s.x,
        y: s.y,
        w: null,
        h: null,
        t: now - i * 1000,
        text: s.text,
        modePos: null,
      }));
      // Render optimistically; persist in the background so the canvas isn't
      // gated on a handful of round-trips.
      seeds.forEach((n) => void notes.onCreate(n));
      settings.markSeeded();
      const ids = seeds.map((n) => n.id);
      seedIdStore.write(ids);
      setSeedIds(ids);
      setResolved(seeds);
    } else {
      setSeedIds(seedIdStore.list());
      setResolved(notes.initialNotes);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes.ready, settings.ready]);

  if (!resolved) return null;

  return (
    <JustNotes
      initialNotes={resolved}
      seedIds={seedIds}
      tweaks={settings.tweaks}
      setTweak={settings.setTweak}
      onCreate={notes.onCreate}
      onUpdate={notes.onUpdate}
      onDelete={notes.onDelete}
    />
  );
}
