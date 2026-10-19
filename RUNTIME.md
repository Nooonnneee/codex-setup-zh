# Runtime localization package

This directory is the auditable source of the runtime localization layer that gets loaded
into Codex Desktop's main process. The release ZIP additionally carries a pinned Windows
Node runtime (`runtime/node.exe`) — it is intentionally kept out of Git history and shipped
as a Release asset.

`runtime/main.cjs` is loaded before the official Codex main process and registers
`runtime/preload-localization.cjs` on every Electron session. The preload translates visible
UI nodes and observes later React-rendered nodes without replacing element identity.

## How it gets loaded

The installer patches the Codex main bundle with a small bootstrap that `require`s
`runtime/main.cjs` from **this tool's own directory**. The path is inlined at inject time
(see `scripts/localization-runtime.mjs`), so there is no version-number lookup and no
dependency on an external client's private folder.

If you move the extracted tool folder, the bootstrap falls back to the path recorded in
`~/.codex/zh-cn-runtime-path.txt`, which the installer rewrites on every install.

## Status reporting

The runtime writes `~/.codex/zh-cn-runtime-status.json` with the number of translated nodes
and visible Chinese characters. The installer reads it for verification.

## Rules

Never add account configuration, chat content, credentials, cookies, authorization headers,
or arbitrary file collection to this runtime. It runs inside the user's application process
and must stay strictly a UI translation layer.
