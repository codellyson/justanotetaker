import { JustNotesLoader } from "./components/JustNotesLoader";
import { AuthBootstrap } from "./components/AuthBootstrap";
import { UpdateBanner } from "./components/UpdateBanner";

export default function App() {
  return (
    <>
      <AuthBootstrap>
        <JustNotesLoader />
      </AuthBootstrap>
      <UpdateBanner />
    </>
  );
}
