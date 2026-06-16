import { useEffect, useState } from "react";
import JustNotes from "./JustNotes/JustNotes";
import { SEED, uid, type Note } from "./JustNotes/lib";
import { useNotes } from "../hooks/useNotes";
import { useSettings } from "../hooks/useSettings";
import { authClient } from "../lib/auth-client";

// Outer loader: watches the live session. When the user_id changes
// (sign-in, sign-up linking, sign-out → new anon), the inner component
// is remounted via key, which throws away its hook state and triggers
// fresh fetches of notes + settings for the new identity. Without this
// the canvas would keep showing the previous user's data after sign-in
// — anon notes wouldn't refresh, and a real user with notes on another
// device wouldn't see them.
export function JustNotesLoader() {
  const { data: session, isPending } = authClient.useSession();
  const userId = session?.user?.id;
  if (isPending || !userId) return null;
  return <Session key={userId} />;
}

// Inner per-identity component. Loads notes + settings, decides
// whether to seed, then renders the canvas.
function Session() {
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
