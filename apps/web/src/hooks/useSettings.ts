import { useCallback, useEffect, useRef, useState } from "react";
import type { Tweaks } from "../components/JustNotes/lib";
import { TWEAK_DEFAULTS } from "../components/JustNotes/lib";
import { remoteStorage } from "../lib/storage";

export function useSettings(debounceMs = 400) {
  const [tweaks, setTweaksLocal] = useState<Tweaks>(TWEAK_DEFAULTS);
  const [ready, setReady] = useState(false);
  const timer = useRef<number | null>(null);
  const pendingRef = useRef<{ tweaks?: Tweaks }>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = await remoteStorage.getSettings();
        if (cancelled) return;
        if (loaded.tweaks) setTweaksLocal({ ...TWEAK_DEFAULTS, ...loaded.tweaks });
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
    (patch: { tweaks?: Tweaks }) => {
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

  return { tweaks, ready, setTweak };
}
