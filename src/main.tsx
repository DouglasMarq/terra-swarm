import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/index.css";
import { SystemRoot } from "./components/integration/SystemRoot";
import { useLocaleStore } from "./i18n";

document.documentElement.lang = useLocaleStore.getState().locale;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SystemRoot />
  </React.StrictMode>,
);
