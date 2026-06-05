import { useCallback, useEffect, useRef, useState } from "react";
import type { Tweaks } from "../components/JustNotes/lib";
import { TWEAK_DEFAULTS } from "../components/JustNotes/lib";
import { remoteStorage } from "../lib/storage";

// useSettings replaces the in-memory useTweaks: same interface but the
// tweaks are loaded from / written to the server. `seeded` rides along
// because it's the first-load marker for the SEED-once behavior.
//
// Save semantics: every setTweak is optimistic locally + debounced PUT
// to the server. Debounce is intentional — the slider tweaks fire dozens
// of changes per second when dragged, and we don't want to PUT each one.
export function useSettings(debounceMs = 400) {
  const [tweaks, setTweaksLocal] = useState<Tweaks>(TWEAK_DEFAULTS);
  const [seeded, setSeededLocal] = useState(false);
  const [ready, setReady] = useState(false);
  const timer = useRef<number | null>(null);
  const pendingRef = useRef<{ tweaks?: Tweaks; seeded?: boolean }>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = await remoteStorage.getSettings();
        if (cancelled) return;
        if (loaded.tweaks) setTweaksLocal({ ...TWEAK_DEFAULTS, ...loaded.tweaks });
        setSeededLocal(loaded.seeded);
      } catch (err) {
        console.error("[useSettings] load failed", err);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  const flush = useCallback(async () => {
    const next = pendingRef.current;
    pendingRef.current = {};
    timer.current = null;
    try {
      await remoteStorage.putSettings(next);
    } catch (err) {
      console.error("[useSettings] save failed", err);
    }
  }, []);

  const schedule = useCallback(
    (patch: { tweaks?: Tweaks; seeded?: boolean }) => {
      pendingRef.current = { ...pendingRef.current, ...patch };
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, debounceMs);
    },
    [debounceMs, flush],
  );

  const setTweak = useCallback(
    <K extends keyof Tweaks>(key: K, val: Tweaks[K]) => {
      setTweaksLocal((prev) => {
        const next = { ...prev, [key]: val };
        schedule({ tweaks: next });
        return next;
      });
    },
    [schedule],
  );

  // Mark the user as seeded — called once after SEED is dumped into
  // their notes table. Persisted immediately (no debounce) so a reload
  // before the debounce timer can't re-seed.
  const markSeeded = useCallback(async () => {
    setSeededLocal(true);
    try {
      await remoteStorage.putSettings({ seeded: true });
    } catch (err) {
      console.error("[useSettings] markSeeded failed", err);
    }
  }, []);

  return { tweaks, seeded, ready, setTweak, markSeeded };
}
