import { StrictMode, createElement } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { installMonacoEnvironment } from "./editor/monaco-environment";
import "./styles.css";
import "@xterm/xterm/css/xterm.css";

installMonacoEnvironment();

const rootElement = document.getElementById("app");

if (!rootElement) {
  throw new Error("Renderer root element '#app' was not found.");
}

createRoot(rootElement).render(createElement(StrictMode, null, createElement(App)));
