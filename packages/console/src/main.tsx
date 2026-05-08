import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./themes/tokens.css";
import "./themes/colors_and_type.css";
import "./themes/app.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root element");
createRoot(rootEl).render(<App />);
