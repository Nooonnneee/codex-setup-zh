import assert from "node:assert/strict";
import { test } from "node:test";

import {
  countExtensionTags,
  isFirewallRegistrationFailure,
  stripFirewallRulesExtensions,
} from "../scripts/localization-patches.mjs";

// 一份缩到最小的真实形态清单：4 个 Extension，其中 2 个是防火墙声明
// （一个多行带 <FirewallRules> 子元素、一个自闭合），另外 2 个是**无关扩展**
// —— appExecutionAlias（`codex.exe` 别名）与 appService（沙箱服务）。
// 注册前必须去掉那 2 个防火墙声明，且**一个无关扩展都不能少**。
const SAMPLE = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"',
  '         xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"',
  '         xmlns:desktop="http://schemas.microsoft.com/appx/manifest/desktop/windows10"',
  '         IgnorableNamespaces="uap desktop">',
  '  <Identity Name="OpenAI.Codex" Publisher="CN=OpenAI" Version="26.915.4065.0" ProcessorArchitecture="x64" />',
  "  <Properties>",
  "    <DisplayName>ChatGPT</DisplayName>",
  "  </Properties>",
  "  <Applications>",
  '    <Application Id="ChatGPT" Executable="app/ChatGPT.exe" EntryPoint="Windows.FullTrustApplication">',
  '      <uap:VisualElements DisplayName="ChatGPT" Description="ChatGPT" BackgroundColor="transparent" Square150x150Logo="Assets\\Square150x150Logo.png" Square44x44Logo="Assets\\Square44x44Logo.png" />',
  "      <Extensions>",
  '        <desktop:Extension Category="windows.appExecutionAlias" Executable="app/ChatGPT.exe" EntryPoint="Windows.FullTrustApplication">',
  "          <desktop:AppExecutionAlias>",
  '            <desktop:ExecutionAlias Alias="codex.exe" />',
  "          </desktop:AppExecutionAlias>",
  "        </desktop:Extension>",
  '        <Extension Category="windows.firewallRules">',
  "          <FirewallRules>",
  '            <Rule Direction="in" IPProtocol="TCP" LocalPortMin="1455" LocalPortMax="1457" />',
  '            <Rule Direction="in" IPProtocol="TCP" LocalPortMin="3128" LocalPortMax="3159" />',
  "          </FirewallRules>",
  "        </Extension>",
  '        <Extension Category="windows.firewallRules" Executable="app/ChatGPT.exe" EntryPoint="Windows.FullTrustApplication" />',
  '        <Extension Category="windows.appService" EntryPoint="CodexSandboxService.OpenAI.Codex" Executable="app/ChatGPT.exe">',
  '          <AppService Name="CodexSandboxService.OpenAI.Codex" />',
  "        </Extension>",
  "      </Extensions>",
  "    </Application>",
  "  </Applications>",
  "</Package>",
].join("\n");

test("removes both firewall declarations and keeps every unrelated extension", () => {
  const before = countExtensionTags(SAMPLE);

  const { manifest, removed } = stripFirewallRulesExtensions(SAMPLE);

  assert.equal(removed, 2);
  assert.equal(before, 4);
  assert.equal(countExtensionTags(manifest), 2);
  assert.ok(!/windows\.firewallRules/i.test(manifest));

  // 无关扩展一个都不能少 —— 尤其 appService 紧跟在**自闭合**的防火墙声明后面，
  // 是当初正则贪婪匹配时被误删的那一个（2026-09-21 实测踩到）。
  assert.ok(manifest.includes('Category="windows.appExecutionAlias"'));
  assert.ok(manifest.includes("<desktop:ExecutionAlias"));
  assert.ok(manifest.includes('Category="windows.appService"'));
  assert.ok(manifest.includes('Name="CodexSandboxService.OpenAI.Codex"'));
  // 清单骨架与其余内容原样保留。
  assert.ok(manifest.includes('<Identity Name="OpenAI.Codex"'));
  assert.ok(manifest.includes("<DisplayName>ChatGPT</DisplayName>"));
  assert.ok(manifest.includes('<Application Id="ChatGPT"'));
});

test("is idempotent — a second pass finds nothing to remove", () => {
  const first = stripFirewallRulesExtensions(SAMPLE);
  const second = stripFirewallRulesExtensions(first.manifest);

  assert.equal(second.removed, 0);
  assert.equal(second.manifest, first.manifest);
});

test("leaves a manifest without firewall rules completely untouched", () => {
  // 显式写一份**本来就没有**防火墙声明的清单（而不是从 SAMPLE 上做正则裁剪 ——
  // 那种构造方式本身就可能顺手删错东西，会让这条断言变得不可信）。
  const clean = [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<Package>",
    '  <Identity Name="OpenAI.Codex" Version="26.915.4065.0" />',
    "  <Applications>",
    '    <Application Id="ChatGPT" Executable="app/ChatGPT.exe">',
    "      <Extensions>",
    '        <desktop:Extension Category="windows.appExecutionAlias">',
    '          <desktop:ExecutionAlias Alias="codex.exe" />',
    "        </desktop:Extension>",
    '        <Extension Category="windows.appService">',
    '          <AppService Name="CodexSandboxService.OpenAI.Codex" />',
    "        </Extension>",
    "      </Extensions>",
    "    </Application>",
    "  </Applications>",
    "</Package>",
  ].join("\n");
  assert.ok(!/windows\.firewallRules/i.test(clean));

  const { manifest, removed } = stripFirewallRulesExtensions(clean);

  assert.equal(removed, 0);
  assert.equal(manifest, clean);
  assert.equal(countExtensionTags(manifest), 2);
});

test("matches namespace-prefixed firewall extensions too", () => {
  const prefixed = [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<Package>",
    "  <Extensions>",
    '    <uap:Extension Category="windows.firewallRules">',
    "      <uap:FirewallRules />",
    "    </uap:Extension>",
    '    <uap:Extension Category="windows.appService">',
    '      <uap:AppService Name="CodexSandboxService.OpenAI.Codex" />',
    "    </uap:Extension>",
    "  </Extensions>",
    "</Package>",
  ].join("\n");

  const { manifest, removed } = stripFirewallRulesExtensions(prefixed);

  assert.equal(removed, 1);
  assert.equal(countExtensionTags(manifest), 1);
  assert.ok(!/windows\.firewallRules/i.test(manifest));
  assert.ok(manifest.includes('Name="CodexSandboxService.OpenAI.Codex"'));
});

test("flags only firewall-service registration rejections", () => {
  // 条件删的判据：只有「注册时登记 windows.firewallRules 被防火墙服务拒了」
  // 才值得删声明重注册（代价是丢掉入站预授权）。
  const customerReport =
    "Add-AppxPackage : 部署失败，原因是 HRESULT: 0x80073CF6, 无法注册包。" +
    "AppxManifest.xml(36,6): 错误 0x800706D9: 无法注册 OpenAI.Codex 程序包，" +
    "因为在注册 windows.firewallRules 扩展时遇到以下错误: 终结点映射器中没有更多的终结点可用。";
  assert.ok(isFirewallRegistrationFailure(customerReport));
  assert.ok(isFirewallRegistrationFailure("0x800706D9"));
  assert.ok(
    isFirewallRegistrationFailure(
      "windows.firewallRules: no more endpoints available from the endpoint mapper",
    ),
  );

  // 删声明也救不回来的失败：权限、开发者模式、应用占用、信任、空值。
  for (const detail of [
    "错误 0x80073D28: 无法注册程序包。需要管理员权限才能安装打包服务",
    "0x80073CFF: developer mode is not enabled",
    "0x80073D02 because OpenAI.Codex must be closed",
    "0x800B0109: certificate chain is not trusted",
    "",
    null,
    undefined,
  ]) {
    assert.ok(!isFirewallRegistrationFailure(detail), `unexpected match: ${detail}`);
  }
});
