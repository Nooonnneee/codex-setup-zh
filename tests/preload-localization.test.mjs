import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);

test("React restores an English label on the same node and it is translated again", async () => {
  const dom = new JSDOM("<!doctype html><button>New Chat</button>", {
    url: "https://codex.local/",
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    CustomEvent: dom.window.CustomEvent,
  };
  Object.assign(globalThis, globals);

  const preload = require.resolve("../runtime/preload-localization.cjs");
  delete require.cache[preload];
  require(preload);
  if (dom.window.document.readyState === "loading") {
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
  }

  const button = dom.window.document.querySelector("button");
  assert.equal(button.textContent, "新对话");

  button.textContent = "New Chat";
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  assert.equal(button.textContent, "新对话");

  dom.window.close();
  for (const name of Object.keys(globals)) delete globalThis[name];
});
