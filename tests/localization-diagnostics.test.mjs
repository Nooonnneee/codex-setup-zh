import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLocalizationDiagnostic } from "../scripts/localization-diagnostics.mjs";
const context = {
  step: "register_package",
  installKind: "registered",
  packageIdentity: "OpenAI.Codex_customer-install",
  rollback: "not_attempted",
};
test("reports step and HRESULT even when the original cause contains private paths", () => {
  const result = buildLocalizationDiagnostic(
    context,
    new Error(
      "Add-AppxPackage: 0x80073D28 C:\\Users\\private\\package requires administrator",
    ),
    "0.1.10-fmkj16",
  );
  assert.equal(result.category, "permission_denied");
  assert.equal(result.systemCode, "0x80073D28");
  assert.equal(result.step, "register_package");
  assert.equal(result.packageIdentity, "OpenAI.Codex_customer-install");
  assert.doesNotMatch(JSON.stringify(result), /Users|private|administrator/);
});
test("keeps a bounded errno and unknown cause without guessing from arbitrary text", () => {
  const result = buildLocalizationDiagnostic(
    { ...context, step: "copy_package" },
    Object.assign(new Error("C:\\secret: disk failure"), { code: "ENOSPC" }),
    "0.1.10-fmkj16",
  );
  assert.equal(result.category, "disk_full");
  assert.equal(result.errno, "ENOSPC");
  const unknown = buildLocalizationDiagnostic(
    { ...context, step: "patch_asar" },
    new Error("my private content"),
    "0.1.10-fmkj16",
  );
  assert.equal(unknown.category, "unknown");
  assert.doesNotMatch(JSON.stringify(unknown), /private/);
});

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
test("a failure restoring files is classified as restore after successful process and permission checks", () => {
  const source = fs.readFileSync(
    new URL("../scripts/patch-codex-zh-cn.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function uninstall(options)");
  const diagnostic = { step: "unknown" };
  const scope = {
    path,
    localizationDiagnostic: diagnostic,
    ensureCodexStopped() {
      diagnostic.step = "stop_processes";
    },
    removeRegisteredLocalization: () => false,
    findCodexInstall: () => ({ app: "/app", resources: "/app/resources" }),
    resolvePatchTarget: () => ({
      app: "/app",
      resources: "/app/resources",
      mode: "in-place",
    }),
    resolveBackupRoot: () => "/backup",
    prepareInstallWriteAccess() {
      diagnostic.step = "write_access";
    },
    restoreBackup() {
      throw Object.assign(new Error("C:/Users/private: denied"), {
        code: "EPERM",
      });
    },
  };
  vm.createContext(scope);
  vm.runInContext(
    source.slice(start, source.indexOf("\nfunction isCodexRunning", start)),
    scope,
  );
  assert.throws(() => scope.uninstall({}), /denied/);
  assert.equal(diagnostic.step, "restore");
});

test("registered copy removal failures retain restore as the failing step", () => {
  const source = fs.readFileSync(
    new URL("../scripts/patch-codex-zh-cn.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function uninstall(options)");
  const diagnostic = { step: "unknown" };
  const scope = {
    localizationDiagnostic: diagnostic,
    ensureCodexStopped() {
      diagnostic.step = "stop_processes";
    },
    removeRegisteredLocalization() {
      throw new Error("failed to unregister");
    },
  };
  vm.createContext(scope);
  vm.runInContext(
    source.slice(start, source.indexOf("\nfunction isCodexRunning", start)),
    scope,
  );
  assert.throws(() => scope.uninstall({}), /unregister/);
  assert.equal(diagnostic.step, "restore");
});

test("keeps inner registration HRESULTs needed to distinguish a generic registration rejection", () => {
  const diagnostic = buildLocalizationDiagnostic(
    context,
    new Error("Registration 0x80073CF6: inner 0x80073D26, C:/Users/private"),
    "0.1.10-fmkj16",
  );
  assert.deepEqual(diagnostic.systemCodes, ["0x80073CF6", "0x80073D26"]);
  assert.doesNotMatch(JSON.stringify(diagnostic), /private/);
});
