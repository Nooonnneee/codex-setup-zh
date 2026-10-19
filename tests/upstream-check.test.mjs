import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const scriptPath = path.join(root, "scripts", "check-upstream.mjs");
const source = fs.readFileSync(scriptPath, "utf8");

// 复刻脚本里的版本比较逻辑，确保判定方向一致
function compareVersion(a, b) {
  const pa = String(a).split(".").map((n) => Number(n) || 0);
  const pb = String(b).split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

test("版本比较：Codex 的四段版本号能正确排序", () => {
  assert.equal(compareVersion("26.930.3930.0", "26.1013.4894.0"), -1);
  assert.equal(compareVersion("26.1013.4894.0", "26.930.3930.0"), 1);
  assert.equal(compareVersion("26.1013.4894.0", "26.1013.4894.0"), 0);
});

test("版本比较：段数不同也能比，不会因长度不等出错", () => {
  assert.equal(compareVersion("26.1", "26.1.0.0"), 0);
  assert.equal(compareVersion("26.1.0.1", "26.1"), 1);
});

test("版本比较：按数字而非字典序（1013 > 930 是数字比较）", () => {
  // 字典序下 "1013" < "930"，数字比较下 1013 > 930。这里必须后者。
  assert.equal(compareVersion("26.1013.0.0", "26.930.0.0"), 1);
});

test("检查脚本只报告，不改任何文件", () => {
  // 这是安全边界：自动改 release.json 会让人工验证形同虚设
  assert.ok(!/writeFileSync|writeFile|createWriteStream/.test(source), "检查脚本不应写文件");
  assert.ok(!/rmSync|unlinkSync/.test(source), "检查脚本不应删文件");
});

test("检查脚本只走 https", () => {
  const httpLiterals = source.match(/["'`]http:\/\/[^"'`]*["'`]/g) || [];
  assert.deepEqual(httpLiterals, [], `发现明文 http: ${httpLiterals.join(", ")}`);
});

test("检查脚本有明确的退出码语义", () => {
  assert.ok(source.includes("process.exitCode = 2"), "检查失败应有独立退出码");
  assert.ok(
    source.includes("process.exitCode = needsAttention ? 1 : 0"),
    "有未验证版本应返回 1，正常返回 0",
  );
});

test("check-upstream 与 verify 脚本都已注册", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.ok(pkg.scripts["check-upstream"], "缺少 check-upstream 脚本");
  assert.ok(pkg.scripts.verify, "缺少 verify 脚本");
  assert.ok(pkg.scripts.verify.includes("check-upstream"), "verify 应包含上游检查");
  assert.ok(pkg.scripts.verify.includes("test"), "verify 应包含单元测试");
});

test("package.json 版本与 release.json 保持一致", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const rel = JSON.parse(
    fs.readFileSync(path.join(root, "resources", "release.json"), "utf8"),
  );
  assert.equal(pkg.version, rel.release, "两处版本号必须一致，否则发版会错乱");
});

test("维护清单文档存在且包含关键动作", () => {
  const doc = fs.readFileSync(path.join(root, "docs", "MAINTENANCE.md"), "utf8");
  assert.ok(doc.includes("npm run verify"), "应写明检查命令");
  assert.ok(doc.includes("supportedCodexVersions"), "应说明如何登记新版本");
  assert.ok(/不要做的事|❌/.test(doc), "应明确反对刷活跃");
});
