import { render } from "preact";
import { App } from "./app";
import "./index.css";

const root = document.getElementById("app");
if (root === null) {
  throw new Error("app root element is missing");
}

render(<App />, root);
