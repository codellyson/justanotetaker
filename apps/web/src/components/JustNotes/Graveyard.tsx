import { useEffect, useState } from "react";
import { Button, Modal } from "@codellyson/justui/react";
import { remoteStorage, type DeletedNote } from "../../lib/storage";
import { firstNonEmpty } from "./lib";

const DAY_MS = 24 * 60 * 60 * 1000;

function ageLabel(deletedAt: number): string {
  const ms = Date.now() - deletedAt;
  if (ms < 60_000) return "just now";
  if (ms < 3.6e6) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < DAY_MS) return `${Math.floor(ms / 3.6e6)}h ago`;
  return `${Math.floor(ms / DAY_MS)}d ago`;
}

export function Graveyard({
  open,
  onClose,
  onRestored,
}: {
  open: boolean;
  onClose: () => void;
  onRestored: (note: { id: string; x: number; y: number; t: number; text: string }) => void;
}) {
  const [items, setItems] = useState<DeletedNote[] | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setItems(null);
    setError(null);
    remoteStorage
      .listDeleted()
      .then((rows) => { if (!cancelled) setItems(rows); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [open]);

  async function handleRestore(id: string) {
    setRestoring(id);
    try {
      const note = await remoteStorage.restore(id);
      if (note) {
        onRestored(note);
        setItems((cur) => (cur ? cur.filter((n) => n.id !== id) : cur));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestoring(null);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="recently deleted"
      description="deleted notes are kept for 30 days, then purged"
      className="!max-w-xl"
    >
      {error && (
        <div className="mb-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
          {error}
        </div>
      )}
      {items === null && !error && (
        <div className="py-8 text-center font-mono text-xs text-secondary">loading…</div>
      )}
      {items && items.length === 0 && (
        <div className="py-8 text-center font-mono text-xs text-secondary">nothing in the graveyard</div>
      )}
      {items && items.length > 0 && (
        <ul className="grave-list">
          {items.map((n) => {
            const first = firstNonEmpty(n.text) || "(empty)";
            return (
              <li key={n.id} className="grave-row">
                <div className="grave-text">
                  <div className="grave-first">{first}</div>
                  <div className="grave-meta">deleted {ageLabel(n.deletedAt)}</div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleRestore(n.id)}
                  disabled={restoring === n.id}
                >
                  {restoring === n.id ? "…" : "restore"}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
