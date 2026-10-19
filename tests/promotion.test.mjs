import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const patcher = fs.readFileSync(
  path.join(root, "scripts", "patch-codex-zh-cn.mjs"),
  "utf8",
);

/** 面向用户 / 发布者的文档：这些文件里都不允许出现死链。 */
const DOC_FILES = [
  "README.md",
  "README.en.md",
  "PROMOTION.md",
  "PUBLISHING.md",
  "RELEASE_NOTES_v1.0.0.md",
];

test("任何文档都不再引用已失效的 fanmeng.ai", () => {
  // 该域名没有 DNS 记录（实测 No such host is known），写进文档就是死链。
  // 真实落地页是 app.fmkj.top/download。
  // 例外：明确标注它是死链的警示语句可以有，否则没人知道为什么不能用。
  const WARNING = /死链|没有 DNS|不要再写/;
  for (const file of DOC_FILES) {
    const full = path.join(root, file);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes("fanmeng.ai")) continue;
      assert.ok(
        WARNING.test(line),
        `${file} 仍在引用死链 fanmeng.ai（非警示语境）: ${line.trim()}`,
      );
    }
  }
});

test("推荐链接指向真实可用的下载页", () => {
  for (const file of ["README.md", "README.en.md"]) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    assert.ok(
      text.includes("app.fmkj.top/download"),
      `${file} 应指向 app.fmkj.top/download`,
    );
  }
  assert.ok(
    patcher.includes("app.fmkj.top/download"),
    "安装完成的推荐应指向下载页",
  );
});
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

test("推荐位只出现一次，且可关闭", () => {
  const promos = patcher.match(/app\.fmkj\.top/g) || [];
  assert.equal(promos.length, 1, `推荐链接应只有一处，实际 ${promos.length} 处`);
  assert.ok(
    patcher.includes("CODEX_ZH_NO_PROMO"),
    "推荐必须可以被环境变量关掉",
  );
});

test("推荐位带 UTM，能区分来源", () => {
  const line = patcher
    .split("\n")
    .find((l) => l.includes("app.fmkj.top")) || "";
  for (const param of ["utm_source=", "utm_medium=", "utm_campaign="]) {
    assert.ok(line.includes(param), `推荐链接缺少 ${param}`);
  }
});

test("推荐位只在成功路径上，不在失败路径", () => {
  // 安装成功后才推荐；报错时还在推销会非常败好感。
  const successAt = patcher.indexOf("汉化安装完成");
  assert.ok(successAt > 0, "应能找到安装完成的日志点");
  const promoAt = patcher.indexOf("app.fmkj.top");
  assert.ok(
    promoAt > successAt,
    "推荐应位于安装完成之后，而不是更早的失败分支里",
  );

  // catch 块里不允许出现推荐链接
  const catchBlocks = patcher.match(/catch\s*\([^)]*\)\s*\{[\s\S]{0,800}?\n\}/g) || [];
  for (const block of catchBlocks) {
    assert.ok(
      !block.includes("app.fmkj.top"),
      "错误处理分支里不应出现推荐链接",
    );
  }
});

test("推荐不弹窗、不要求注册", () => {
  const promoLine = patcher
    .split("\n")
    .find((l) => l.includes("app.fmkj.top")) || "";
  assert.ok(!/Popup|MessageBox|WScript/i.test(promoLine), "推荐不应弹窗");
  assert.ok(!/注册|register|signup/i.test(promoLine), "推荐不应要求注册");
});

test("README 顶部推荐有边界说明，不硬推", () => {
  assert.ok(readme.includes("app.fmkj.top"), "README 应有推荐入口");
  assert.ok(
    /如果你只想把界面变中文，这个仓库就够了|不需要跳到别处/.test(readme),
    "README 推荐应明确边界，避免硬推反感",
  );
});
