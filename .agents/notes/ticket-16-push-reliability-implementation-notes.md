# Ticket 16 implementation notes

## Scope and seams
- 用户已授权 public coordinator / persistence / clock / output seams；用内存事件序列与真实 PushOutput/PushStore，不接真实服务。
- 基于 integrate-v1 6e7ed8f0，#15 fixed dependency b6440f03；沿用已合入 system-admission，禁止合入被拒绝的 #19 新版。
- 协调器在 #15 持久 occurrence 之后 debounce/coalesce；按 personaId 计数，不按名字或 request.id。
- 发送前持久 claim 原 occurrence；聚合 membership 改变、重启、locale 切换均不能令历史成员再发送。未知外发结果不重试。
- 默认首次未知 pending fail-closed。明确 resolved 或完整 prompt identity 更替后才允许新实例推送；观察缺口不解决、不造 Activity。task.created 只证明 task 生命周期，不能授权其所有后续审批。不存在可信 live request-generation producer，因此删去布尔 provenance 的伪证明分支；approval event 显式给出 kind/resourceId/occurrenceKey，与 task Activity 种类区分。

## Decisions
- 保留 #15 transport/SW/VAPID；retract 仅取消未发与持久 tag 墓碑、本机有限关闭，不发送 silent retract，不保证跨设备删除。
- 时钟通过 PushClock.now，公开 flush seam 用于内存序列；生产 createPushPolling 真实 source→consumer→PushStore/output 接线测试，不用真实计时器/网络。挂起发送不持观察队列，stop 清除未发送本地队列。
- 独立 review 发现并 RED→GREEN 修复：错峰 A0/B500 分裂通知；固定 admission cohort 窗口，每成员完整 debounce 后聚合，cohort 最大成熟时间不超过首成员 2×debounce，后续窗口不会无限延期。
- resolved/supersede/ownership retire 的同一 durable commit 通过 withRetractTags 同时展开 aggregate 墓碑；下一 baseline mutation 即使失败，已失活成员不会半撤。保留永久 handled 和 perEndpoint claim，cleanup/重新登记不重放旧成员。
- 额外竞态回归：claim 已提交后 resolved 墓碑先于外发登记，旧 send 必须抑制。输出在 store 的同步 no-op admitted callback 内复核当前状态并 dispatch；返回包裹网络 promise 的对象，不能持 store 队列等待网络，原 claim 先持久化不变。
- invalid cleanup 放在所有健康 endpoint 派发之后，cleanup 错误仍显式向调用者传播；全部投递失败通过公开 report 与生产日志可观测，unknown 不自动重试。
- 已按 code-simplifier 建议减少单成员 SHA/count 运算、展开协调状态 mutation、合并测试 import；不删除读/claim/取消时点保护。
- titleTemplate/summaryTemplate count=distinct personaId；原名字/问题保留，locale 不进入 tag 或 occurrence。transport 白名单仍仅发送实际显示字段。
- 顾问要求补生产接线及 cursor 证据：新增 createPushPolling 的 source→实际 store/output 跨 2500ms polls 测试，3000ms debounce、hung send 可继续 resolved、stop 不再外发；实际 ActivityLedger/PushStore 双重重启后旧 cursor 不重发，新用户 trusted launch 的 working→done 可推。尊重 #13 epoch：不会从旧已完成 pane 的重启快照补造新 work cycle。

## Verification
- 显式 merge 本票 feature 与最新 integrate-v1 6e7ed8f0（#15 dependency b6440f03），作者 rolex <torolex@163.com>；未修改 integration bookmark。
- 本机 Bun 1.3.12：bun test 465 pass / 0 fail（84 files）；bun run typecheck / bun run build 均通过。既有 React act 警告和 activity 故障注入日志不代表失败。
- 普通独立 review 与简化均使用只读 agent；a51466a41600955e0 最终增量 review 在可观察 v1 边界下 0 高置信阻塞，确认原子墓碑/错峰合并/claim-dispatch 与真实 ledger/cursor 回归。审查不背书执行器的全量三绿或最终 freeze，二者由执行器独立验证。

## OPEN / partial requirement
- 完整的“同内容新审批 incarnation 均可推”仍 partial：不可观察 generation 没有可信事件生产者，不在本票伪造实现。上文 fail-closed 限制、人工确认及后续可信 request-generation 契约仍 OPEN；本票交付可观察边界内的 debounce/coalesce/取消/持久去重/清理，不宣称整项无限覆盖。

## Deviations
- 暂停期间未实现。workspace add 配合 ignore-working-copy 部分失败，早期空 workspace 已仅在自身新 child 修正；恢复后从实际 integration 6e7e 新 child，未重写他人历史。
- v1 明确限制（父协调冻结裁决）：同 pane 同内容新 incarnation，若没有可信 resolved 边界/完整 identity 变化，上游无可观察的 request-generation 契约，无法证明是新审批。保持 fail-closed（可能漏通知），不凭 snapshot/request.id/process nonce/workspace/task.created 猜 generation。首次历史 pending 和重启前未发送队列不补发；人工验收需检查此限制，不宣称每种新 incarnation 均可识别。
- Context7 Bun resolve 两次 fetch failed；没有假称查到当前官方 API。实际本机 Bun 1.3.12 和仓库类型/测试为执行证据，无新的外部库 API 实现。
- 没有真实 push、VAPID/凭据服务配置、Collie 文件/根 handler 修改、PR/发布；手机锁屏显示、跨设备撤回效果仍留人工。
