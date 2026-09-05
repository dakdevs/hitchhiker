import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./site";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Hitchhiker site root is missing");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
