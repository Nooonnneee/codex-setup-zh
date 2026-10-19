import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";

const script = fs.readFileSync(
  new URL("../scripts/patch-codex-zh-cn.mjs", import.meta.url),
  "utf8",
);
function loadFunction(name, end, scope) {
  scope.localizationDiagnostic = { step: "unknown" };
  vm.createContext(scope);
  const start = script.indexOf(`function ${name}(`);
  vm.runInContext(script.slice(start, script.indexOf(end, start)), scope);
  return scope[name];
}

for (const name of ["OpenAI.Codex", "OpenAI.Codex_customer-install"]) {
  test(`copies the selected original ${name} without searching another installation`, () => {
    const source = {
      app: "/selected/app",
      resources: "/selected/app/resources",
    };
    let copies = 0;
    const scope = {
      path,
      REGISTERED_COPY_ROOT: "/copy",
      fs: { existsSync: () => false, mkdirSync() {}, writeFileSync() {} },
      queryRegisteredPackage: () => null,
      readRegisteredCopyMarker: () => null,
      findWindowsAppsCodex: () => {
        throw new Error("must not rediscover an explicit original");
      },
      resolveAppxPackageRoot: (app) => path.dirname(app),
      readManifestIdentityField: () => name,
      readSourcePackageVersion: () => "26.930.7945.0",
      ensureDeveloperMode() {},
      ensureCodexStopped() {},
      logInfo() {},
      logOk() {},
      progressLog() {},
      INSTALL_STEP_TOTAL: 8,
      runWithProgressHeartbeat: (_, run) => run(),
      copyStorePackage: (root) => {
        assert.equal(root, "/selected");
        copies++;
        return 1;
      },
      patchRegisteredManifest() {},
      getRegisteredCopyMarkerPath: () => "/copy/marker",
      sameWindowsPath: (a, b) => a === b,
    };
    const run = loadFunction(
      "ensureRegisteredAppxCopy",
      "/** 跑一次 `Add-AppxPackage",
      scope,
    );
    const target = run(source, { skipStop: true });
    assert.equal(copies, 1);
    assert.equal(target.sourceApp, source.app);
  });

  test(`rewrites ${name} identity and sandbox references without dropping extensions`, () => {
    let manifest = `<Package><Identity Name="${name}" Publisher="CN=OpenAI" Version="26.930.7945.0"/><DisplayName>ChatGPT</DisplayName><Extensions><Extension Category="windows.firewallRules"/><Extension Category="windows.appExecutionAlias"/><Extension EntryPoint="CodexSandboxService.${name}"><AppService Name="CodexSandboxService.${name}"/></Extension></Extensions></Package>`;
    const scope = {
      path,
      fs: {
        readFileSync: () => manifest,
        writeFileSync: (_, text) => {
          manifest = text;
        },
      },
      REGISTERED_PACKAGE_NAME: "OpenAI.Codex.FMKJ",
      REGISTERED_SERVICE_NAME: "CodexSandboxService.OpenAI.Codex.FMKJ",
      REGISTERED_DISPLAY_NAME: "ChatGPT 汉化版",
      logInfo() {},
      logOk() {},
    };
    const run = loadFunction(
      "patchRegisteredManifest",
      "/** 递归清掉只读属性",
      scope,
    );
    run("/copy");
    assert.ok(manifest.includes('Name="OpenAI.Codex.FMKJ"'));
    assert.ok(
      manifest.includes('Name="CodexSandboxService.OpenAI.Codex.FMKJ"'),
    );
    assert.ok(
      manifest.includes('EntryPoint="CodexSandboxService.OpenAI.Codex.FMKJ"'),
    );
    assert.ok(manifest.includes('Category="windows.firewallRules"'));
    assert.ok(manifest.includes('Category="windows.appExecutionAlias"'));
    assert.ok(manifest.includes('Publisher="CN=OpenAI"'));
    const once = manifest;
    run("/copy");
    assert.equal(manifest, once);
  });
}

test("fallback discovers both exact original package identities, excluding the localized copy", () => {
  let query = "";
  const scope = {
    spawnSync: (_, args) => {
      query = args.join(" ");
      return { stdout: "/original" };
    },
    resolveCodexInstallDir: () => ({ app: "/original/app" }),
    path,
    fs: {},
    process: { env: {} },
  };
  const run = loadFunction(
    "findWindowsAppsCodex",
    "const CODEX_DIR_PATTERN",
    scope,
  );
  run();
  assert.ok(query.includes("$_.Name -eq 'OpenAI.Codex'"));
  assert.ok(query.includes("$_.Name -eq 'OpenAI.Codex_customer-install'"));
  assert.ok(!query.includes("-like"));
});

test("rejects an unrelated manifest rather than registering it as a localized copy", () => {
  const scope = {
    path,
    fs: {
      readFileSync: () =>
        '<Package><Identity Name="OpenAI.CodexSomething"/></Package>',
      writeFileSync: () => assert.fail("must not write unrelated package"),
    },
    REGISTERED_PACKAGE_NAME: "OpenAI.Codex.FMKJ",
    REGISTERED_SERVICE_NAME: "CodexSandboxService.OpenAI.Codex.FMKJ",
    REGISTERED_DISPLAY_NAME: "ChatGPT 汉化版",
    logInfo() {},
    logOk() {},
  };
  const run = loadFunction(
    "patchRegisteredManifest",
    "/** 递归清掉只读属性",
    scope,
  );
  assert.throws(() => run("/copy"), /不是受支持的 Codex 包/);
});

test("WindowsApps fallback accepts customer installer directories but excludes similarly named packages", () => {
  const scope = {
    path,
    process: { env: { ProgramFiles: "/mock" } },
    spawnSync: () => ({ stdout: "" }),
    fs: {
      existsSync: () => true,
      readdirSync: () =>
        [
          "OpenAI.CodexSomething_26.930.7945.0_x64",
          "OpenAI.Codex_customer-install_26.930.7945.0_x64",
        ].map((name) => ({ name, isDirectory: () => true })),
      statSync: () => ({ mtimeMs: 0 }),
    },
    resolveCodexInstallDir: (root) => {
      assert.ok(root.includes("OpenAI.Codex_customer-install_"));
      return { app: `${root}/app` };
    },
  };
  const run = loadFunction(
    "findWindowsAppsCodex",
    "const CODEX_DIR_PATTERN",
    scope,
  );
  assert.ok(run().app.includes("customer-install"));
});

test("a selected localized copy is never reused as its own original source", () => {
  let copiedFrom;
  const scope = {
    path,
    REGISTERED_COPY_ROOT: "/copy",
    fs: { existsSync: () => false, mkdirSync() {}, writeFileSync() {} },
    queryRegisteredPackage: () => null,
    readRegisteredCopyMarker: () => null,
    findWindowsAppsCodex: () => ({
      app: "/original/app",
      resources: "/original/app/resources",
    }),
    resolveAppxPackageRoot: (app) => path.dirname(app),
    readManifestIdentityField: (root) =>
      root === "/copy" ? "OpenAI.Codex.FMKJ" : "OpenAI.Codex_customer-install",
    readSourcePackageVersion: () => "26.930.7945.0",
    ensureDeveloperMode() {},
    ensureCodexStopped() {},
    logInfo() {},
    logOk() {},
    progressLog() {},
    INSTALL_STEP_TOTAL: 8,
    runWithProgressHeartbeat: (_, run) => run(),
    copyStorePackage: (root) => {
      copiedFrom = root;
      return 1;
    },
    patchRegisteredManifest() {},
    getRegisteredCopyMarkerPath: () => "/copy/marker",
    sameWindowsPath: (a, b) => a === b,
  };
  const run = loadFunction(
    "ensureRegisteredAppxCopy",
    "/** 跑一次 `Add-AppxPackage",
    scope,
  );
  assert.equal(
    run({ app: "/copy/app" }, { skipStop: true }).sourceApp,
    "/original/app",
  );
  assert.equal(copiedFrom, "/original");
});
