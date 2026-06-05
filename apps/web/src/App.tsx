import JustNotes from "./components/JustNotes/JustNotes";
import { AuthBootstrap } from "./components/AuthBootstrap";

export default function App() {
  return (
    <AuthBootstrap>
      <JustNotes />
    </AuthBootstrap>
  );
}
