import { BrowserRouter, Route, Routes } from "react-router";
import { JustNotesLoader } from "./components/JustNotesLoader";
import { AuthBootstrap } from "./components/AuthBootstrap";
import { UpdateBanner } from "./components/UpdateBanner";
import { PublicBoardView } from "./components/PublicBoardView";

// The share view renders outside AuthBootstrap — viewers must not get an
// anonymous user row minted for them.
function AuthedApp() {
  return (
    <>
      <AuthBootstrap>
        <JustNotesLoader />
      </AuthBootstrap>
      <UpdateBanner />
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/b/:boardId" element={<PublicBoardView />} />
        <Route path="*" element={<AuthedApp />} />
      </Routes>
    </BrowserRouter>
  );
}
