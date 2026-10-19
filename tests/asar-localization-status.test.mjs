import assert from "node:assert/strict";
import { constants as bufferConstants } from "node:buffer";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const entrypoint = new URL("../scripts/patch-codex-zh-cn.mjs", import.meta.url);
const mainPath = ".vite/build/main-fixture.js";
const localizedMenu = ["file", "edit", "view", "help"]
  .map(
    (key, index) =>
      `messageId:\`windowsMenuBar.${key}\`,defaultMessage:\`${["文件", "编辑", "视图", "帮助"][index]}\``,
  )
  .join(";");
const englishMenu = ["file", "edit", "view", "help"]
  .map(
    (key, index) =>
      `messageId:\`windowsMenuBar.${key}\`,defaultMessage:\`${["File", "Edit", "View", "Help"][index]}\``,
  )
  .join(";");
const bootstrap = "/* fmkj-runtime-bootstrap-v1 */";
const officialGate = "codexpp-official-i18n-gate-v1";

function writeAsar(
  destination,
  entries,
  { minimumSize = 0, entryOverrides = {} } = {},
) {
  const header = { files: {} };
  const buffers = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const buffer = Buffer.from(content);
    const parts = name.split("/");
    let node = header;
    for (const part of parts.slice(0, -1)) {
      node.files[part] ??= { files: {} };
      node = node.files[part];
    }
    node.files[parts.at(-1)] = {
      size: buffer.length,
      offset: String(offset),
      integrity: {
        algorithm: "SHA256",
        hash: "fixture",
        blockSize: 4194304,
        blocks: [],
      },
      ...entryOverrides[name],
    };
    buffers.push(buffer);
    offset += buffer.length;
  }
  if (minimumSize > offset) {
    header.files["unrelated-payload.bin"] = {
      size: minimumSize - offset,
      offset: String(offset),
    };
  }
  const json = Buffer.from(JSON.stringify(header));
  const payloadSize = Math.ceil((4 + json.length) / 4) * 4;
  const prefix = Buffer.alloc(12 + payloadSize);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(4 + payloadSize, 4);
  prefix.writeUInt32LE(payloadSize, 8);
  prefix.writeUInt32LE(json.length, 12);
  json.copy(prefix, 16);
  fs.writeFileSync(destination, Buffer.concat([prefix, ...buffers]));
  if (minimumSize) {
    const fd = fs.openSync(destination, "r+");
    try {
      fs.ftruncateSync(fd, prefix.length + minimumSize);
    } finally {
      fs.closeSync(fd);
    }
  }
}

function statusFor(entries, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmkj-asar-status-"));
  try {
    fs.mkdirSync(path.join(root, "resources"));
    fs.writeFileSync(path.join(root, "ChatGPT.exe"), "fixture");
    writeAsar(path.join(root, "resources", "app.asar"), entries, options);
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(entrypoint), "status", "--codex-path", root, "--json"],
      { encoding: "utf8", timeout: 30000, windowsHide: true },
    );
    assert.equal(result.error, undefined, "Status command did not finish");
    assert.equal(result.status, 0, `Status command failed: ${result.stderr}`);
    const reportLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("{"));
    assert.ok(
      reportLine,
      `Status command did not return JSON: ${result.stderr}`,
    );
    return JSON.parse(reportLine);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("status validates real bundle entries even when the ASAR exceeds Node's string limit", () => {
  const report = statusFor(
    [
      [mainPath, `${localizedMenu};${bootstrap}`],
      ["webview/assets/index-fixture.js", officialGate],
    ],
    // Leave room for the few multi-byte Chinese menu characters: the failure
    // depends on decoded string length, not just the archive's byte length.
    { minimumSize: bufferConstants.MAX_STRING_LENGTH + 64 * 1024 },
  );
  assert.equal(
    report.asarLocalized,
    true,
    "A large unrelated payload must not report 菜单翻译未就绪",
  );
  assert.equal(report.runtimeLocalized, true);
  assert.equal(report.officialI18nGatePatched, true);
});

test("localized menus and runtime markers in unrelated files cannot validate an English main bundle", () => {
  const report = statusFor([
    ["unrelated.js", `${localizedMenu};${bootstrap};${officialGate}`],
    [mainPath, englishMenu],
    ["webview/assets/index-fixture.js", "unpatched webview"],
  ]);
  assert.equal(report.asarLocalized, false);
  assert.equal(report.runtimeLocalized, false);
  assert.equal(report.officialI18nGatePatched, false);
});

test("a missing fourth translated menu and a broken edit submenu remain unlocalized", () => {
  const missingHelp = statusFor([
    [mainPath, localizedMenu.replace("帮助", "Help")],
  ]);
  assert.equal(missingHelp.asarLocalized, false);
  const broken = statusFor([
    [
      mainPath,
      `${localizedMenu};{label:\`编辑\`,submenu:[{role:\`selectAll\`,label:\`全选\`}]}`,
    ],
  ]);
  assert.equal(broken.asarLocalized, false);
});

test("legacy translated main menus remain recognized", () => {
  const report = statusFor([[mainPath, "label:`文件`;label:`编辑`"]]);
  assert.equal(report.asarLocalized, true);
});

test("modern menus still require all four translations when legacy labels also appear", () => {
  const report = statusFor([
    [mainPath, `${englishMenu};label:\`文件\`;label:\`编辑\``],
  ]);
  assert.equal(report.asarLocalized, false);
});

test("menu translations cannot be combined from separate main bundle entries", () => {
  const menus = localizedMenu.split(";");
  const report = statusFor([
    [mainPath, menus.slice(0, 2).join(";")],
    [".vite/build/main-other.js", menus.slice(2).join(";")],
  ]);
  assert.equal(report.asarLocalized, false);
});

test("out-of-bounds and invalid packed entries cannot validate localization", () => {
  for (const invalid of [
    { offset: "999999" },
    { offset: "-1" },
    { size: 999999 },
    { size: -1 },
  ]) {
    const report = statusFor([[mainPath, `${localizedMenu};${bootstrap}`]], {
      entryOverrides: { [mainPath]: invalid },
    });
    assert.equal(report.asarLocalized, false);
    assert.equal(report.runtimeLocalized, false);
  }
});
