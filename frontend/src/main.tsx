import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { SessionProvider } from "./session";
import "./styles.css";
import "./data-ui.css";
import "./prep-refinements.css";
import "./derivative-hover.css";
import "./image-prep-stage1.css";
import "./exception-editor.css";
import "./exception-editor-polish.css";
import "./caption-workbench.css";
import "./caption-toast.css";
import "./start-source-layout.css";
import "./image-helper-overlays.css";
import "./training-filenames.css";
import "./caption-training-names.css";
import "./caption-runtime-controls.css";
import "./caption-validation.css";
import "./stage-refinements.css";
import "./runtime-notification.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <App />
      </SessionProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
