export const OFFICIAL_I18N_GATE_MARKER = "codexpp-official-i18n-gate-v1";
export const OFFICIAL_I18N_GATE_CONFIG_ID = "72216192";

const OFFICIAL_I18N_GATE_PATTERN =
  /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\([\x60"']72216192[\x60"']\),([A-Za-z_$][\w$]*);([A-Za-z_$][\w$]*)\[0\]===\1\?\3=\4\[1\]:\(\3=\1\?\.get\([\x60"']enable_i18n[\x60"'],!1\),\4\[0\]=\1,\4\[1\]=\3\)/;

/**
 * Enable the official Codex i18n path only when the known minified structure
 * occurs exactly once. Unknown versions are left untouched so the runtime DOM
 * localization can remain the safe fallback.
 */
export function patchOfficialI18nGateSource(source) {
  if (source.includes(OFFICIAL_I18N_GATE_MARKER)) {
    return { source, changed: false, recognized: true };
  }

  const fingerprints = [
    OFFICIAL_I18N_GATE_CONFIG_ID,
    "enable_i18n",
    "locale_source",
    "Failed to load locale messages",
  ];
  if (!fingerprints.every((value) => source.includes(value))) return null;

  const matches = [
    ...source.matchAll(new RegExp(OFFICIAL_I18N_GATE_PATTERN.source, "g")),
  ];
  if (matches.length !== 1) return null;

  const match = matches[0];
  const tick = String.fromCharCode(96);
  const replacement = `${match[1]}=${match[2]}(${tick}${OFFICIAL_I18N_GATE_CONFIG_ID}${tick}),${match[3]};${match[3]}=!0`;
  const next = source.replace(OFFICIAL_I18N_GATE_PATTERN, replacement);
  if (next === source) return null;
  return {
    source: `${next}\n/* ${OFFICIAL_I18N_GATE_MARKER} */`,
    changed: true,
    recognized: true,
  };
}

export function hasOfficialI18nGatePatch(source) {
  return source.includes(OFFICIAL_I18N_GATE_MARKER);
}

// 运行时引导的实现已迁到 `localization-runtime.mjs`：开源版不再依赖
// `%LOCALAPPDATA%\FMKJ Connect\Tools\`，语言包就在本工具的 `runtime/` 目录。
// 这里只做转发，保持既有调用方与单测的 import 路径不变。
export {
  RUNTIME_BOOTSTRAP_MARKER,
  LEGACY_RUNTIME_BOOTSTRAP_MARKER,
  buildRuntimeBootstrap,
  injectRuntimeBootstrapSource,
  hasRuntimeBootstrap,
  needsRuntimeBootstrapUpgrade,
  resolveRuntimeDir,
  resolveRuntimeStatusPath,
} from "./localization-runtime.mjs";

/**
 * 把 Codex 桌面端内建更新器弹的「去商店更新」提示，替换成引导用户回客户端
 * 点「一键汉化」。
 *
 * 为什么必须动这块：汉化版是一份**松散注册的副本**（包名 `OpenAI.Codex.FMKJ`、
 * `SignatureKind=None`），Microsoft Store 不认它 ⇒ 内建更新器做不到静默下载，
 * 只会走到 `update-available-in-store` 那一支，弹一句
 * 「… update is available. / Open Microsoft Store to install the update.」。
 * 用户照着点，装回 / 更新的是**官方英文版**，中文版还停在旧版本 —— 一个走不通的入口。
 *
 * ⚠️ 只改这两句**界面文案**，一行更新逻辑都不碰：真出现新版该怎么办交给安装器
 * 在下次运行时判断（它读 `~/.codex/zh-cn-registered.json` 的来源版本，比 Codex 自己更清楚
 * 汉化副本的状态）；在这里改判定只会在下次 Codex 换写法时静默失灵。
 *
 * 逐条替换，且**要求该条在文本里恰好出现一次**：出现 0 次 = 已经打过或这个 Codex
 * 版本换写法了（跳过是安全的）；出现多次 = 分不清哪一处才是那一句，宁可不改，
 * 也不要误伤别处。
 */
export function applyUpdatePromptPatches(source, replacements) {
  const pairs = Array.isArray(replacements) ? replacements : [];
  let text = source;
  let applied = 0;
  let ambiguous = 0;
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const [from, to] = pair;
    if (typeof from !== "string" || typeof to !== "string") continue;
    if (!from || !to) continue;
    const occurrences = text.split(from).length - 1;
    if (occurrences === 0) continue;
    if (occurrences > 1) {
      ambiguous += 1;
      continue;
    }
    text = text.replace(from, to);
    applied += 1;
  }
  return { source: text, changed: text !== source, applied, ambiguous };
}

/**
 * 匹配清单里所有 `Category="windows.firewallRules"` 的 `<...Extension>` 声明。
 *
 * 为什么必须删掉它们：松散注册（`Add-AppxPackage -Register`）会按清单逐条登记
 * 「应用扩展」。登记 `windows.firewallRules` 时，部署栈要向防火墙服务（`mpssvc`）
 * 发一次 RPC 去加规则；网吧/客户机上防火墙服务常被停用或锁死，这一次 RPC 就返
 * `0x800706D9`（终结点映射器中没有更多的终结点可用），整个注册随之失败 ——
 * 外层看到的是 `0x80073CF6`，内层才是 `0x800706D9`。
 *
 * 2026-09-21 CD015 实测：标准安装与「复制副本 + 松散注册」两条路一起挂，报的是同一个错
 * —— 这条路不删它就没法在网吧机器上用。我们这份副本由自己控制（商店包改不了、
 * 改了签名就失效），删掉即可让注册完全不碰防火墙。代价只是副本不再预留几个
 * **入站**端口（1455/1457、本地代理 3128–3159、8081–8112），出站流量本来就默认放行，
 * 功能不受影响。
 *
 * ⚠️ 属性判断必须放在**先行断言**里（`(?=[^>]*\bCategory="...")`），不能写成
 * `<...Extension\b[^>]*\bCategory="...">` 那种「属性字面量跟在贪婪 `[^>]*` 后面」的形态。
 * 反例后果（2026-09-21 单测实测）：对**自闭合**的
 * `<Extension Category="windows.firewallRules" Executable="..." />`，贪婪的 `[^>]*`
 * 会被回溯到 `Category=` 之前，于是 `\s*\/>` 分支面对的是 `Executable="..." />`
 * ——中间隔着别的属性，它匹配不上；正则只好走「`>` + 到下一个 `</Extension>`」这一支，
 * 把紧随其后的**无关扩展（`appService`）一起吞掉**。
 * 用先行断言先确认属性、再让 `[^>]*` 只在**同一个标签内**回溯，就不会跨标签吞并。
 * 另外仍保留一道「Extension 总数必须正好少 K 个」的复核兜底（见下），
 * 万一将来又出现没预料到的清单形态，宁可抛错也不写坏清单。
 *
 * ⚠️ 调用时机是**条件删**（2026-09-21 定）：先拿原清单去注册，健康机器因此保住几条
 * 入站端口预授权；只有注册真被防火墙服务拒了（`isFirewallRegistrationFailure`）
 * 才调用本函数删声明、重注册一次。别再改回「注册前无条件先删」。
 */
export const FIREWALL_EXTENSION_PATTERN =
  /<(?:\w[\w.-]*:)?Extension\b(?=[^>]*\bCategory="windows\.firewallRules")(?:[^>]*\/>|[^>]*>[\s\S]*?<\/(?:\w[\w.-]*:)?Extension>)/g;

/** 清单里 `<...Extension` 开始标签的个数（用于复核删对了几个、没多删）。 */
export function countExtensionTags(manifest) {
  return (manifest.match(/<(?:\w[\w.-]*:)?Extension\b/g) || []).length;
}

/**
 * 删掉清单里全部防火墙规则声明，返回新清单与删除处数。
 *
 * 两道自检都**抛错而不是静默继续**，因为这两类错误都会在离这里很远的地方才炸：
 *  - 漏删一处 → 注册在防火墙服务被停用的机器上以「终结点映射器中没有更多的终结点可用」告败；
 *  - 多删了无关扩展 → 副本少了能力（别名、服务、协议处理），但这台机器上未必立刻看得见。
 */
export function stripFirewallRulesExtensions(manifest) {
  const firewallCount = (manifest.match(FIREWALL_EXTENSION_PATTERN) || [])
    .length;
  const extensionCountBefore = countExtensionTags(manifest);
  const stripped = manifest.replace(FIREWALL_EXTENSION_PATTERN, "");

  if (/windows\.firewallRules/i.test(stripped)) {
    throw new Error(
      "副本清单里仍残留 windows.firewallRules 声明，注册会在防火墙服务不可用的机器上失败",
    );
  }
  if (countExtensionTags(stripped) !== extensionCountBefore - firewallCount) {
    throw new Error(
      "改写副本清单时误删了无关扩展，已停止注册（清单会保持原样）",
    );
  }
  return { manifest: stripped, removed: firewallCount };
}

/**
 * 判断一次 `Add-AppxPackage -Register` 的失败，是不是「登记防火墙声明被防火墙服务拒了」。
 *
 * 部署栈会按清单声明逐条登记「应用扩展」；登记 `windows.firewallRules` 那一条要向
 * 防火墙服务（`mpssvc`）发一次 RPC。服务被停用或锁死的机器上（网吧、精简镜像的常态）
 * 这一次调用就返 `0x800706D9`「终结点映射器中没有更多的终结点可用」，
 * **整个注册随之失败** —— 外层看到的是 `0x80073CF6`，内层才是它（2026-09-21 CD015 实测）。
 *
 * 命中这条判据意味着还有一手没打：调用 `stripFirewallRulesExtensions` 把声明删掉，
 * 再注册一次。所以本函数只回答「该不该删」—— 其余注册失败（权限不足、开发者模式没开、
 * 应用占用、签名不受信）删声明也救不回来，别白删。
 */
export function isFirewallRegistrationFailure(detail) {
  const text = String(detail ?? "").toLowerCase();
  if (!text) return false;
  return (
    text.includes("0x800706d9") ||
    (text.includes("windows.firewallrules") &&
      (text.includes("endpoint mapper") || text.includes("终结点映射器")))
  );
}

/**
 * 客户端「受管便携安装」的标记文件名 —— 解包时写在**便携根**，
 * 客户端的完整性校验（`validate_managed_install`）也认它。
 */
export const MANAGED_PORTABLE_MARKER = ".codex-managed";

/**
 * 这次汉化（或回滚）该打在哪儿 —— 纯判据，只回答 `"in-place"` 还是 `"store-register"`。
 *
 * 🔴 为什么单独抽出来：2026-09-22 客户机实测，便携版被**误判成商店版**。
 *   - 客户端的受管便携安装，根目录里**本来就有一份 `AppxManifest.xml`**
 *     （`portable_transaction.rs::extract_payload()` 主动写进去的，
 *     `validate_managed_install()` 靠它校验完整性，删不得）；
 *   - 而这里当年的判据只有一句「有没有清单」⇒ 便携版走了商店版那条路；
 *   - 商店版那条路要**以商店原版为源复制一份**，可这台机器上根本没有商店版
 *     ⇒ 报「没有找到 Microsoft Store 安装的 Codex」，汉化失败；
 *     回滚（卸载）走同一套分类，报**同一句**，客户端于是拼出
 *     「恢复汉化前状态失败…已保留事务记录」——用户看到的是"回滚也坏了"。
 *
 * 正确判据（两条，缺一不可）：
 *   1) **受管便携标记**（`.codex-managed`）优先 —— 有它就是这个客户端装的便携版，
 *      哪怕清单在、也得走原地写入。它比「清单在不在」更接近事实，因为这标记
 *      只有「客户端解包」这一条路径会写；
 *   2) 剩下的必须有**真的注册在系统里**的包身份才算商店版。光是目录里有清单
 *      不算（手工解包副本、旧版本残留、临时目录里的一份都能有清单），
 *      对它们走「复制商店包」是在找一个不存在的源 —— 照样报上面那句话。
 *
 * ⚠️ 也就是说：**「没有已注册的包身份」要按原地写入处理，而不是报错**。
 * 便携版就是这种情况，它是完全正常、受支持的安装形态；只有"既不是受管便携、
 * 又认不出已注册包身份"时错误信息才有意义，而那种情况本来也不该猜。
 */
export function decideLocalizationTargetKind({
  managedPortable = false,
  registeredAsStorePackage = false,
} = {}) {
  if (managedPortable) return "in-place";
  return registeredAsStorePackage ? "store-register" : "in-place";
}

/** 原地汉化标记的 `mode` 值 —— 客户端 `in_place_localized()` 只认这个。 */
export const IN_PLACE_MARKER_MODE = "in-place";

/**
 * 原地汉化标记该写什么（`~/.codex/zh-cn-inplace.json`）。
 *
 * 🔴 **写这个标记是「原地汉化」的收尾动作本身，与安装形态无关** ——
 * 老实现只在 `isWindowsAppsInstall(app)` 为真（即商店版）时才写，于是：
 * 客户端 0.1.96 修好形态判定后，便携版**第一次**真正走完「原地汉化 + 后置校验」，
 * 补丁打进去了、exe 完整性也同步了，可**标记没写** ⇒ 客户端 `in_place_localized()`
 * 判「未汉化」⇒ `apply()` 后置校验失败 ⇒ **自动回滚、把刚打好的补丁拆掉** ⇒
 * 用户看到「Codex 汉化失败：汉化后置校验未通过；已执行回滚」
 * （2026-09-22 客户机实测）。
 */
export function buildInPlaceMarker({
  app,
  version,
  patchedAt = new Date().toISOString(),
} = {}) {
  return {
    schema: 1,
    mode: IN_PLACE_MARKER_MODE,
    sourceApp: app ?? null,
    version: version || null,
    patchedAt,
  };
}

/**
 * 标记里的 `version` 该取哪个值 —— 必须与客户端 `installed_version()` **同口径**。
 *
 * 客户端 `in_place_localized()` 的第 ② 条是 `marker.version == installed_version()`；
 * 对不上就整条判否（同样会被回滚）。而客户端两形态取值不同
 * （`codex_update.rs::installed_version()`）：
 *   · 受管便携 ⇒ `.codex-managed` 里的 `version`；
 *   · 注册包   ⇒ 包清单 `AppxManifest.xml` 的 `Identity/@Version`。
 * 所以这里也按「先受管元数据、后包清单」的顺序取，两边才会得到同一个字符串。
 */
export function resolveInPlaceMarkerVersion({
  managedVersion,
  manifestVersion,
} = {}) {
  return managedVersion || manifestVersion || null;
}
