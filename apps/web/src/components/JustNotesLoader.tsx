import JustNotes from "./JustNotes/JustNotes";
import { useNotes } from "../hooks/useNotes";
import { useSettings } from "../hooks/useSettings";
import { authClient } from "../lib/auth-client";

export function JustNotesLoader() {
  const { data: session, isPending } = authClient.useSession();
  const userId = session?.user?.id;
  if (isPending || !userId) return null;
  return <Session key={userId} />;
}

function Session() {
  const notes = useNotes();
  const settings = useSettings();

  if (!notes.ready || !settings.ready || !notes.initialNotes) return null;

  return (
    <JustNotes
      initialNotes={notes.initialNotes}
      tweaks={settings.tweaks}
      setTweak={settings.setTweak}
      onCreate={notes.onCreate}
      onUpdate={notes.onUpdate}
      onDelete={notes.onDelete}
    />
  );
}
