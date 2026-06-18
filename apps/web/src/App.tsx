import { ThemeToggle } from "@codellyson/justui/react";
import { JustNotesLoader } from "./components/JustNotesLoader";
import { AuthBootstrap } from "./components/AuthBootstrap";

export default function App() {
  return (
    <>
      <AuthBootstrap>
        <JustNotesLoader />
      </AuthBootstrap>
      {/* Floating bottom-right widget. Independent of auth state so the
          user can re-theme on the boot screen too. Visually overlapped
          by the Tweaks panel while it's open — acceptable since both
          are transient settings UIs. */}
      <ThemeToggle />
    </>
  );
}
