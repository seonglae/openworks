import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "../src/App.tsx";
import "../src/index.css";

// No provider and no Clerk: `convex/react` is aliased to the fixture stub for
// this build, so the shell mounts straight into the app it would render for a
// signed-in owner. The real entry point is src/main.tsx.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
