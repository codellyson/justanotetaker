import { useOnViewportChange } from "@xyflow/react";

// Mounted only inside the note being edited: bumps CmEditor's measureSignal on
// every pan/zoom so CodeMirror re-measures its rendered band (a transform pan
// fires no scroll event, so CM would otherwise show blank filler when panned
// past the band it measured on focus).
export function CmMeasureBridge({ onViewportChange }: { onViewportChange: () => void }) {
  useOnViewportChange({ onChange: onViewportChange });
  return null;
}
