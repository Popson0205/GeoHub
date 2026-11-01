import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./lib/auth";
import { ConfirmProvider, ToastProvider } from "./components/ui";
import { UpdateBanner } from "./components/PwaPrompts";
import { initPwa } from "./lib/pwa";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
// The map library's stylesheet must come before the app's, which adjusts it. Pages load on demand, so it is
// imported here rather than with the map component, where it would arrive later and win.
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles/app.css";

initPwa();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <ConfirmProvider>
          <AuthProvider>
            <App />
            <UpdateBanner />
          </AuthProvider>
        </ConfirmProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>
);
