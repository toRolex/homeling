# Ticket #15 implementation notes

## Scope / authorized seams
- 用户已授权 public API、持久化、协调器、前端 seam。TDD 按 store / transport / output+clock / HTTP / SW handler 公共边界逐切片。
- 独立 workspace：homeling.ticket-15-push，base ca826f0528dc7760f631bddb63efa67f2cc24a61。仅 ticket-15-push bookmark；不动 integration、不发布、不启服务、不外发真实 push、不读既存秘密。
- #13 owns trusted events / task ownership / occurrenceKey；等待 frozen interface 后接线，不用 snapshot 推历史。
- #19 owns actual lock actor/commit/dispatch；业务 push 写受锁，系统已配置通知窄 actor、不续租。#11 owns settings shell。
- #16 owns debounce/coalesce/reliability；这里只交最小立即输出与持久去重/取消未发送。

## Decisions
- 独立 VAPID 存 external data-dir，0600/0700；只返回 public key。web-push per-request vapidDetails，绝不用共享全局 setVapidDetails，不碰 Collie。
- retract 取消未派发；SW 可按 tag 尝试本机关闭；不保证已发送跨设备撤回。
- secret 安全门仅枚举文件名，无实际秘密路径；.env/.env.* ignore 生效；身份 rolex / torolex@163.com 一致。

## Actual delivery seams
- `PushPersistence.load/mutate(change, admission)`：0700/0600、祖先 symlink / O_NOFOLLOW / owner / nlink / size 验证，实际 rename 注册前 admission；旧 v1 无 retractTags 时只在内存兼容，不 GET 补写。
- `PushOutput.send(PushPayload) -> {sent,invalid,failed,suppressed}` / `retract(tag)`；clock.now 注入；发送前持久 claim（occurrence+endpoint），unknown 不重放。debounce/coalesce 归 #16。
- `PendingPushLedger` 的 occurrence UUID 独立于审批 nonce ID。registry 主资源 / #13 durable task lifecycle 为 binding；unknown / failed / truncated / missing 不 settle。已解决后新请求或已证资源替换可 new UUID；同 pane 未知进程重启不猜新实例。
- PendingRequest.personaId 为 optional 真 registry ID（legacy absent）；taskOccurrenceKey 仅真实 ledger。task lifecycle 改变使旧审批卡过期，审批 id/fullscreen signature / expected_prompt 原安全语义保留。
- 本机 retract：resolve / replace / retain 同次持久 commit 保存 notification-only tombstone tags；公开 status 只读；所有 `/lite/` 前台路由通过 PushRetractions 向 exact 同 origin `/lite/` worker postMessage。未发送取消为硬保证，显示通知仅本机 best effort，不 silent push / 不强跨设备撤回。
- Task approval deep-link `/lite/p/:pane?occurrence=:key` 通过真实 ActivityTaskBoundary；history/pagination/requests/reply/control scoped，原请求 ID+option+真实 key 提交前 ledger.dispatchCurrent 与用户 admission 复核。任务完成/失败 `/lite/t/:pane?occurrence=:key` 只消费真实 ActivityEvent，不猜 unknown exit 为 failed。
- Public bodyTemplate 保留 raw question/taskTitle/detail 供 #20 per-sub render；模板仅 daemon hint，wire 只显示字段且 3500-byte 上限，避免长 transcript metadata 重复外发及 Web Push 4KiB 限制。
- Push business POST 使用 sessionMutationFetch；permission/getSubscription/native subscribe across await 保留入口旧 epoch ticket，不被解锁后的新会话收编。仅已经派发的新 native allocation 可补偿取消。客户端正常发送 epoch/generation 合约双头，不自行修改 #19 全局实现。
- Production root保留 LocaleProvider / SessionBoundary / homeSummary triage / memory / customize / activity / PushSettings；仅自有 SW push/notificationclick 热点，root Collie worker/client 不触碰。

## Review / verification
- TDD red-green：持久化、真实 web-push 加密/VAPID（注入 sender 不外发）、canonical colon-pane审批、midflight gap keys0、旧 epoch enroll0/native compensation、8KiB流式预算、preview redraw不重推、删除/claim/failedread撤销persona归属、本机 sender→实际SWclose、2条 overwrite/resolve→restart 的持久墓碑序列。
- 六项定向简化：去未使用 retract wire 类型、判别 union/source-owned URL、fresh ownership 单次投影、已 claim 快速跳过、共享完整 screen 读取、窄 private-file helper。未做 screen 并发池/通用 store/可靠性整票。
- 独立 standards/spec 2个 P2 已修；普通 reviewer 的两个本机 retract 缺口已公开序列证明并补线，最后仅 delta 复核。
- 全套测试 / typecheck / build 曾在 latest 4ea5 基础 443 三绿；墓碑与 client 双头 additive 后 final 数量以最终报告为准，不据中间绿称整票 ready。
- 手工遗留：手机主屏权限允许/拒绝、锁屏收具体问题、点击真实 persona/task、Collie 双通知共存；未启真实服务/外发 push/读取真实秘密/PR/发布。

## Dependencies
- Actual #13 `961dcc06d514766298e0fb09fc05a7dea23bb48d`，通过 integration `ea200...` / `4ea5f2330d2d4670a02244dcc718a3f6ec457e7c` 消费其可信事件、scope与 shared control-busy 门；memory/customize/triage 均保留。
- 合法已消费 #19：2bd32251 / d1c283cb / c988192157535a7c2c02b2fa057c2022757c095a。更新 #19 `785396...` 的 jj merge 权限被拒（主会话用户待许可）：本票不代合、不 tree-copy 整票、不绕权限；最终更强服务端双头协议由用户许可后的 merger 收口，不能据本票 client 合约声称新 #19 server 已接。
- #20 per-sub locale/render 接线可复用 raw templates；本票不导入未存在 locale server 模块，后续 locale-pref-only 不 new occurrence / 不重放通知。

## Deviations
- JJ 并发事故：共享 green `3c19b55a07ea826a4a791131a8ca353667107a66` 后继续修改同 change przpkpnv，snapshot op `8820e2cfedf2` 自动生成 `55761011b46724ff86848e575435c353bd61fe66` 并 rebase #17 的 e5aca6a5→cc028beb、bbc0bb22→53d61ce3。已明确告知用户及 owner，不擅 undo/GC/旧 shared change 修改；#17 owner 已独立恢复 fixed old SHA 谱系。后续只 own new leaf；最终分享完整 hash 前先 jj new 冻结。557 作为本票 P2 修改谱系保留，不能隐瞒或称从未影响他人。
- jj workspace add --ignore-working-copy 实际建空 root workspace 后拒绝更新；只在独立新 workspace 新建指定 base change 并移动自有 bookmark，主 checkout untouched。
- modern-web-guidance 已调用；版本过期，查询无 push 专属指南（不擅改用户 skill）。库API由 Context7 官方 web-push 文档补齐。
