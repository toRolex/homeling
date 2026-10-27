# Ticket 17 implementation notes

## Scope / approved seams
- 用户已批准公开前端/事件 seams；测试 HomeTriage 渲染、导航、GET 轮询生命周期，使用 DOM + fake transport，不访问真实服务/浏览器。
- 基线 integrate-v1 96bd5b2123bfd9d9e712c210a0b06495b9b053cc；独立 jj workspace ticket-17-triage-home，禁止修改 integration bookmark/主 checkout。

## Decisions
- 独立 HomeTriage，唯一主接线是 App slots.homeSummary；不改 App 结构及其他 slots/providers。
- requests 与 registry 同轮 GET；仅 pending 且真实 registry personaId 可匹配时计数，同 persona 多请求只计一次，但展示每个请求的上下文链接。
- 主 pane 导航 /persona/:id；task pane 导航 /p/:paneId?occurrence=<trusted ledger UUID>，不依赖 task 内存 store。actual /persona/:id/p/:paneId 会重定向主聊，/t 暂无审批卡，故不可用于直达处理。
- task occurrence 使用 #13 durable ActivityResponse.occurrences append 顺序的最后同 pane 记录（不是时间戳，不倒退找旧 active）；再 GET activity/task/:key 全局权威确认 current/liveAvailable/live 及 UUID/pane/persona/space/active，未确认时保留计数并展示明确不可处理降级，不 fallback unscoped 写页。
- 已显式 merge #13 scoped API green 5a5c50895c473c5ee0ccb2e233b5a4ad1db398dc（非整票 ready）；复用共享 fetchActivity/fetchTaskOccurrence/ActivityTaskResponse，删去临时同义 API helper。
- #13/#19 合并冲突保留 scoped task 路径 + sessionMutationFetch、upstreamFetch/原 admission 派发门禁；保留 main Activity slot + AppRoot/SessionBoundary，不丢其他槽位。#13 Activity.interaction live 测试最小补 session ready fixture，非生产解锁。
- 已仅在本票 workspace merge 最新 integration 61f909d49367ae4d68df5792905afb8aa82cbf57（#12）。保留 LocaleProvider/SessionBoundary/AppRoot 与 memory/activity/homeSummary 槽；daemon config 联合 memory/activity/push 字段、index memory+scoped Activity路由，control-key fixture 采用 integration 更严格缺 identity/origin 分支。
- 普通独立 code-reviewer 首轮增量审查融合冲突及组件：无新增高置信阻塞/非阻塞问题；当时 #15 /p guard 和 #13 scopedreply busy/controlgate 为剩余依赖，已按后述固定 green 消费，不自行偷补 daemon。
- 复用串行轮询，隐藏页面停止并废弃在途响应；显式 suspended seam 供 #19 接线。所有请求仅 GET，不发送 activity/续 lease。
- 已显式 merge #15 green 0a579bf8ff4b65b578569de81305d56b0467a2db（含 #13/#19 契约依赖，非 #15 整票 ready），消费 optional 真实 personaId registry resolver；未改审批 id/signature。
- 显式 merge #19 actual root green d1c283cbe37ce2caa5a495ac72bb8525d3831266（非整票 ready）。main 保留 AppRoot/SessionBoundary 所有 Routes，只传 homeSummary SessionAwareHomeTriage。wrapper 消费 useSessionSnapshot，locked 或 !ready 时真实暂停，不仅 overlay。
- #19 合并冲突：daemon index 保留 #13 的只读 Activity routes，runtime 使用 #19 upstreamFetch；未把用户操作洗成 system。main 采用 AppRoot 真 root，不恢复旧 Routes。
- root fake-server DOM 证明初锁无 triage GET，unlock 只读 catch-up 未 ready 时 triage 不启动，ready 后启动，relock 隐藏并停止。suspended 清空旧数据，解锁等待本组件新读不闪回旧计数（红→绿）。
- 四轴 simplify-code 独立只读审查及 code-simplifier 复核：均无高置信简化问题，fix list 为空。
- TDD 首个测试红（缺组件），distinct + deep link 实现绿；task 实际入口纠正测试红→绿；trusted occurrence URL 测试红→绿；global current/liveAvailable 拒绝测试红→绿。
- 取消 fence：活动读取 await 后/每个 task lookup 前及 await 后检查 signal.aborted。忽略 abort 的 transport 旧响应曾触发额外 GET（红），修后活动回调 GET0、多请求中途锁定不启动第二 GET（绿）。
- #13 首个 green 仅 /t 使用 ActivityTaskBoundary，/p 尚未消费 occurrence；实际 daemon ActivityLedger/handleRequest+fake bridge 联测及 historical/wrong-pane/unknown 路由最初确为红。现已消费 #15 固定原 green 3c19b55a07ea826a4a791131a8ca353667107a66，/p ActivityTaskBoundary、scoped history/requests/reply/control、原审批 id/option + taskKey 服务端提交点复核全部接线；24 HomeTriage DOM/API 回归已绿，包含真实 ledger/handleRequest 与旧任务链接无 history/card/textarea（非仅 fake metadata）。
- 最终消费 #13 READY 961dcc06d514766298e0fb09fc05a7dea23bb48d 的 scoped cancellation busy/unknown 共享门、ledger loaded ownership invariants，已在最新 integration ea200aca43c4ab9d1250d3b575d6648bfe85077d 中真实合入；不自行修其 daemon 合同。
- 最终融合保留 LocaleProvider/AppRoot/SessionBoundary、memory/customize/activity/settings/homeSummary，Conversation 的 occurrenceKey 与 #18 personaStale/deadline 同时保留；API 保 Avatar types、尾部 scope 参数及 sessionMutationFetch。
- 合并既有 STT 测试从旧无锁入口改用已批准的 public session-test-fixture（5 tests 绿），仅测试 admission 初始化，未解除生产锁。
- 消费新增 PendingRequest.taskOccurrenceKey 真值：若显式 request key 与已确认 latest ledger key 不同，保真实人数但不换绑链接（红→绿）。matching key 正常导航；不改审批 id/signature。

## Verification
- HomeTriage 25 DOM/API 回归：真实 registry distinct、settled/zero、main 重建与实际 task 审批、历史/wrong/unknown route、真实 daemon ledger/scoped API、session root catch-up、ignored abort、多请求中途锁与 task key mismatch。
- 最终固定父 e5 + ea200：`bun test` 431 pass / 0 fail，`bun run typecheck`、`bun run build` 均退出 0。
- 人工遗留：手机真实 2 persona / 同 persona 多请求计数与主聊/task 点入审批后消除、后台/锁/解锁后的显示；不执行真实服务、部署、PR/推送、tracker。

## Guidance
- 已加载 jj/tdd/browser-tools/modern-web-guidance/pre-implement；现代前端指导提示 skill 版本过期，未改配置；已读取 accessibility，React 官方文档确认 effect cleanup 丢弃旧响应。

## Deviations
- 无浏览器验收（用户禁止）；真机手机验收留人工。
- #15 分享 green 后继续改同一 shared change，jj 自动改写了本票两后继；停止原 workspace snapshot，完整源 WIP 备份 /tmp/homeling-ticket17-before-stale-reconcile.tgz（0600，SHA256 879c932c8ca5d4df863950fd048d6ed5262c99ce74bb47459b15df6fca935bf9），原 stale 目录不改、不 update-stale、不 undo/rebase/GC 他人。
- 为隔离未经 green 的 55761011，新独立 workspace /Users/rolex/Documents/Codes/githubProject/MyProject/homeling.ticket-17-triage-home-recovered，从固定原 e5aca6a5713c45bb69d381abe60adee8cbe426ef + ea200aca43c4ab9d1250d3b575d6648bfe85077d fresh child 合并；原 bbc0bb224087a664c7054d637c7a2e6ea686045c 的全部父已包含，无缺依赖、无 557 祖先。仅精确融合公共冲突，没有旧文件整包覆盖新 integration。
- 只读对照归档与原目录 apps/packages/notes，无内容差异，无归档 symlink；原 WIP 现场保留。jj workspace add 在 --ignore-working-copy 下拒更新但生成了空 root workspace，已在新目录显式 new 固定两父纠正；无权限拒绝或绕过，无改他人 bookmark/history。最终分享前 jj new 离开 green revision，按完整 raw hash 交付。
