import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { SessionProvider } from "./session";
import "@tabler/icons-webfont/dist/tabler-icons.min.css";
import "./styles.css";
import "./data-ui.css";
import "./prep-refinements.css";
import "./derivative-hover.css";
import "./image-prep-stage1.css";
import "./exception-editor.css";
import "./exception-editor-polish.css";
import "./image-prep-v6.css";
import "./image-prep-v6-polish.css";
import "./caption-workbench.css";
import "./caption-review-pager.css";
import "./caption-template.css";
import "./caption-methodologies.css";
import "./caption-toast.css";
import "./start-source-layout.css";
import "./image-helper-overlays.css";
import "./training-filenames.css";
import "./caption-training-names.css";
import "./caption-runtime-controls.css";
import "./caption-validation.css";
import "./stage-refinements.css";
import "./runtime-notification.css";
import "./caption-sampling-polish.css";
import "./training-harness.css";
import "./training-telemetry.css";
import "./training-run-review.css";
import "./preferences.css";
import "./tabler-icon-tuneups.css";
import "./project-transfer.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <App />
      </SessionProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
