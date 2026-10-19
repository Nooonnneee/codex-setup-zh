import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  MANAGED_PORTABLE_MARKER,
  decideLocalizationTargetKind,
} from "../scripts/localization-patches.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// ── 背景（2026-09-22 客户机实测）────────────────────────────────────────────
// 客户端的「受管便携安装」根目录里**也有一份 `AppxManifest.xml`**（客户端解包时
// 主动写的，它的完整性校验要靠它）。当年这里只判「目录里有没有清单」，于是便携版
// 被判成商店版，转去找一个根本不存在的商店原版，报
// 「没有找到 Microsoft Store 安装的 Codex」——汉化与回滚双双失败。
// 下面这张表就是把那次事故钉住。

test("受管便携标记优先于一切：便携版永远原地写入", () => {
  // 客户机那台的真实形态：有标记、**也**有清单，而且系统里没有任何商店包。
  assert.equal(
    decideLocalizationTargetKind({
      managedPortable: true,
      registeredAsStorePackage: false,
    }),
    "in-place",
  );
});

test("就算系统里真有商店包，只要带便携标记也走原地写入", () => {
  // 同一台机器上「商店版 + 客户端便携版」并存：汉化的目标是**客户端那一份**，
  // 不能因为机器上碰巧装了商店版就去复制商店包。
  // （实现里这种情况不会同时取到两个 true —— 判定到便携后就不查包身份了 ——
  //  这里显式钉住优先级，免得将来有人把两个条件的位置写反。）
  assert.equal(
    decideLocalizationTargetKind({
      managedPortable: true,
      registeredAsStorePackage: true,
    }),
    "in-place",
  );
});

test("只有真的注册在系统里的包身份才走商店版路线", () => {
  assert.equal(
    decideLocalizationTargetKind({
      managedPortable: false,
      registeredAsStorePackage: true,
    }),
    "store-register",
  );
});

test("有清单但认不出包身份 —— 按原地写入，不报「请先从商店安装」", () => {
  // 手工解包副本、旧版本残留、D:\CodexTest 这类目录都能有清单，但都不是商店版。
  // 对它们走商店路线 = 去找一份不存在的源 ⇒ 报那句误导人的错误。
  assert.equal(
    decideLocalizationTargetKind({
      managedPortable: false,
      registeredAsStorePackage: false,
    }),
    "in-place",
  );
});

test("什么都不给也不抛错，按原地写入处理", () => {
  assert.equal(decideLocalizationTargetKind(), "in-place");
  assert.equal(decideLocalizationTargetKind({}), "in-place");
});

test("返回值只可能是这两个模式之一", () => {
  // `resolvePatchTarget` 的调用方按字符串分支（还有一种是存量机器的 store-copy，
  // 那条路不经过本函数）。这里防的是将来加第三种值时忘了改调用方。
  for (const input of [
    { managedPortable: true, registeredAsStorePackage: true },
    { managedPortable: true, registeredAsStorePackage: false },
    { managedPortable: false, registeredAsStorePackage: true },
    { managedPortable: false, registeredAsStorePackage: false },
  ]) {
    assert.ok(
      ["in-place", "store-register"].includes(
        decideLocalizationTargetKind(input),
      ),
      `unexpected mode for ${JSON.stringify(input)}`,
    );
  }
});

test("标记名必须与客户端写下的那个字面量一致", () => {
  assert.equal(MANAGED_PORTABLE_MARKER, ".codex-managed");

  // 跨语言契约：客户端（Rust）在便携根写这个文件，语言包在这里读它。
  // 两边一旦改名，判据就会静默失效 —— 又退回「便携版被当成商店版」。
  // 语言包分发包里没有 Rust 源码，那种情况下跳过（只查字面量）。
  const rust = path.join(here, "..", "..", "src-tauri", "src", "codex_update.rs");
  if (!fs.existsSync(rust)) return;

  const source = fs.readFileSync(rust, "utf8");
  assert.ok(
    source.includes(`"${MANAGED_PORTABLE_MARKER}"`),
    `客户端源码里找不到标记 ${MANAGED_PORTABLE_MARKER} —— 两边的判据名对不上了`,
  );
  // 便携版**同时**写清单与标记，这正是"只看清单会误判"的根源；
  // 哪天真不写清单了，本文件顶部那段说明就该改。
  assert.ok(
    source.includes('"AppxManifest.xml"'),
    "客户端不再写 AppxManifest.xml 了？那本判据的前提已经变了，去改注释与判据",
  );
});
