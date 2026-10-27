# Homeling M0 — Implementation Notes

> 任务：仓库初始化 + monorepo 骨架 + Collie checkout 内新前端 `/lite` 挂载跑通（PRD §11 M0）。
> 上游 spec：`PRD.md`（决策 D1-D15 已定稿）· `GLOSSARY.md` · `docs/adr/0001-0003`。

## Grilling 结论（2026-10-03，开工前最后一轮）

- **Q1 代码归属**：homeling repo 是唯一源码真相。bridge 改动 = `patches/` 可插拔 additive patch + deploy 脚本；`collie update` 冲掉后重跑 apply。尽量上游 PR。硬约束：与原版 Collie 不冲突、旧 UI 零破坏。ADR-0002。
- **Q2 daemon 运行时**：Bun + TS，与 bridge 同栈。
- **Q3 repo 结构**：Bun workspaces monorepo：`apps/web` · `apps/daemon` · `packages/contracts` · `patches/` · `scripts/`。
- **Q4 persona 主对话**：每 persona 恰一个长期常驻主 pane（thread）；task 是额外短期 pane。ADR 落点：GLOSSARY thread 条目。
- **Q5 旧 space**：daemon registry 是 persona 唯一真相；旧 space 新 UI 不显示，v1 不做收编迁移。
- **ADR**：0001 daemon=独立 launchd 服务；0002 bridge 只做 additive patch；0003 轮询快照而非 WS。

## 关键事实（来自 collie-deploy-facts subagent，2026-10-03）

- Collie checkout：`~/.local/share/collie/`，detached @ v1.14.2，**self-update 会 `git checkout --force` 冲掉 git-tracked 本地改动**（`cli/update.ts:784`）。`web/dist`、`bin/` 被 gitignore。
- 静态托管单出口 `server.ts:2179`，单一 `WEB_DIR`（`server.ts:150`）。`COLLIE_BASE_PATH` 是整应用单挂载，**没有**第二 SPA 的现有钩子。
- **前端更新免重启**（dist 请求时读盘）；bridge 改动需 `collie build` + restart。
- 新 UI 挂 `/lite` 最省路径：构建产物放 `web/dist/lite/`（Vite `base: '/lite/'`），旧 UI 占根；`/lite/*` 深链接 fallback 需几行 additive 代码。
- launchd 先例：`~/Library/LaunchAgents/herdr.collie.plist`（RunAtLoad+KeepAlive，日志 `<configDir>/collie.log`）。daemon 走同模式（ADR-0001）。
- push 摘要单点：`bridge/notifications.ts` `summarize()`（:224）。

## Decisions（随实现追加）

- **assistant-ui 留到 M1。** M0 验收只要手机 `/lite` 能看见现有 pane。snapshot 没有消息正文，`ExternalStoreRuntime` 现在喂不进真实对话，只是多一个依赖。映射放在 `packages/contracts` 的 `snapshotToGroups`（稳定 id = paneId），M1 直接接 runtime。
- **contracts 只收映射需要的子集**，不镜像 `bridge/types.ts` 全量。多出来的 wire 字段结构上忽略。
- **`/lite` fallback 是 `serveStatic` 里 4 行**：无扩展名且磁盘上不存在时，`lite` / `lite/*` 回落到 `web/dist/lite/index.html`，其余路径仍回落根 `index.html`。已存在的文件、带扩展名的 404、根 SPA，行为不变。patch：`patches/0001-lite-spa-fallback.patch`。
- **bridge 用 bun 跑源码，不跑编译后的二进制。** `collie build` 编出的 `bin/collie` 没有 ad-hoc 签名，本机一启动就被杀（`OS_REASON_EXEC`，`codesign -s -` 报 unsupported format）。官方 release 的二进制是 ad-hoc 签过的。所以 `~/Library/LaunchAgents/herdr.collie.plist` 的 ProgramArguments 改成 `bun run bridge/index.ts`（备份在 `/tmp/herdr.collie.plist.bak`），源码改动免编译即生效。`bin/collie` 已用官方 v1.14.2 macos-arm64 包还原，给 `collie` CLI 用。
- **`collie build` 会清空 `web/dist`**（staging 整目录 rename 过来）。deploy-web 必须在 build 之后再跑一次，否则 `/lite` 被清掉。

## Follow-ups（M1 处理）

- **plist 脆弱性**：官方 `collie restart` / `collie update` 会把 plist 改回 `bin/collie _exec-bridge`，补丁失效。M1 在 `scripts/` 加自有 restart（launchctl kickstart，不写回 plist），并在 apply-patches 后自动检查 plist 是否仍指向 bun。
- **二进制签名**：重编 `bin/collie` 被 OS_REASON_EXEC 杀，`codesign -s -` 报 unsupported format。后续试 `codesign -f -s - --deep` 或 bundle 格式排查；能修则回到官方编译路径，废弃 plist hack。适合给上游提 PR/issue（官方构建产物显然有签名步骤）。

## Deviations

- **launchd plist 被改了，超出「只动 bridge 源码」的原计划。** 原因见上：重编的二进制在这台机器上起不来，而编译进二进制是补丁生效的唯一官方路径。改为 bun 跑源码后，`/lite` 与 `/lite/*` 深链接都验证过返回 Homeling shell，根路径仍是旧 UI。副作用：`collie restart` / herdr plugin action `restart` 仍按 plist 里原来的 `bin/collie _exec-bridge` 语义写的；现在 plist 已不是那条命令，下次走官方 restart 会把 ProgramArguments 改回去，补丁随之失效，需要重新指回 bun。
- **apply-patches 二次执行不是干净 no-op。** `patch --forward` 对已应用的 hunk 会写 `*.rej`。脚本改成先 `--dry-run`，已应用则跳过，不再落 reject 文件。
