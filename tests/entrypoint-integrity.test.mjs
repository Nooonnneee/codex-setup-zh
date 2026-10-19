import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const entrypoint = path.join(here, "..", "scripts", "patch-codex-zh-cn.mjs");

test("localization entrypoint contains real line breaks and executable code", () => {
  const source = fs.readFileSync(entrypoint, "utf8");
  const lines = source.split(/\r?\n/);

  assert.ok(lines.length > 100, "entrypoint collapsed into a one-line shebang");
  assert.equal(lines[0], "#!/usr/bin/env node");
  assert.match(source, /const options = parseArgs\(process\.argv\);/);
  assert.match(
    source,
    /if \(options\.action === "status"\) status\(options\);/,
  );
});
