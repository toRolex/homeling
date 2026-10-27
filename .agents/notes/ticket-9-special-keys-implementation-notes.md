# Ticket #9 special keys

## Boundaries

执行器确认的公共测试边界：daemon HTTP 写入口、前端 API、特殊键条交互。未称用户已确认；继承协调器安全收敛决定。

## Decisions

- 保留浏览器 raw `/keys` 禁令。新增固定语义 `/control-key` 入口，仅 `interrupt`→`ctrl+c`、`escape`→`Escape`。
- 上游 `expected_prompt` 是尾部连续区域匹配，并非原子条件输入。取消键也只用于已连接、非 blocked 的已知 pane；snapshot identity→screen→snapshot identity/status→带完整 expected_prompt 的 keys，已缓存 pending 也拒写。
- 前端确认取消操作、同步防双击，不走文本 send queue，不自动重试；HTTP 成功仅表示上游接受，不表示 TUI 消费。

## Deviations

- Enter、Cmd、任意 Ctrl 组合不开放：审批竞态不能原子防住，zero-touch 不修改 Collie。明确禁用及说明，不以假文本键代替。
- modern-web-guidance 已加载；其 npx 外部来源命令遭权限拒绝，未绕过。React 官方 useRef/useState 文档已通过 Context7 查证。

## Checks

- red→green：首个 daemon 入口返回 405（红）→绑定 Ctrl-C 真载荷（绿）；API 缺少导出（红）→单次语义写入（绿）；UI 缺组件（红）→确认/取消状态模型（绿）。
- 全套 217 tests 绿，类型检查与构建绿；其后补并发互斥/畸形响应回归，待最终复跑。
- 顾问复核：修复 identity key 重挂载丢失在途状态；SpecialKeyBar 保持 pane 生命周期，身份变化只取消确认，保留 busy/unknown。submitDraft 同步检查 controlBusyRef 后才清草稿。
- 简化审查无必须修项，保留安全校验与明确写前/写后错误分支，不为减少行数合并 unknown 逻辑。
- 真机遗留：手机经 Tailscale 点按 Ctrl+C/Escape，观察目标 TUI 行为；不在用户现有 pane 上自动执行取消键。Cmd/Enter 禁用是明确范围偏离，不宣称全部按键已验收。
- 审查追加 P1：unknown 后仅 busy=false 会放开 composer，迟到取消键可能影响新文本。修复为 busy||unknown 持续前端隔离，daemon 同 pane reply 在控制 busy/unknown 时返回 409 + textDelivered:false，无上游写入（浏览器刷新亦不能绕过）。公共fixture暂停在上游 expected_prompt 校验通过、实际写键之前，验证快 reply 与迟到键后的 reply 均零写。不是声称 reply 先改变屏幕的顺序必定复现。
- ReplyComposer 支持独立 disabledReason，控制键 unknown 时不得显示旧消息的“先重试”提示，草稿保留。控制键与未知封锁仅当前 daemon 进程内有效，重启不是未生效证明。
- 合并 integration 1ea5775e 后曾 222 tests/typecheck/build 全绿；未知文本隔离修复后 224 tests/typecheck/build 绿。
- integration 前进至 #10 b487ab05，再次 merge；保留 personaId taskStorageKey 与特殊键身份 imports 两边语义。发现新 persona/:id/message 不经过 reply proxy，补 sendPersonaMessage 锁内、实际 mainPaneId 提交点 controlKeyBlocksText。同一 HTTP 公共测试先红（200且写入）→绿（409+textDelivered:false，零 bridge reply）。这是跨票同一输入门接线，不扩展 persona 功能。
- 本票 code-reviewer 终审 0 must-fix；主协调器另三只读复核确认原 unknown 隔离 P1 已撤销。
- 最终又合并 integration ca826f05（#8 voice input）；保留 STT 音频例外、scopeId、voice 生命周期与特殊键 disabledReason/unknown 隔离。以冻结锁文件安装新增 happy-dom（沿用 #8 依赖），增加真实 React 挂载回归：在途 snapshot 身份消失/恢复不解锁，unknown 后仍不发文本且草稿保留。
- 最终检查（ca826f05 已是祖先）：`bun test` 269 pass / 0 fail / 37 files；`bun run typecheck` 三包绿；`bun run build` 绿。无 push、无合入 integration、无 issue 改动。

## Acceptance status

- AC1 部分：固定 Ctrl+C、Escape 真实协议链已实现并 fixture 验证；手机/目标 TUI 真机接收尚待人工。Enter/Cmd 明确禁用，不称全键可用。
- AC2 自动验证完成：上游 accepted / 明确未提交 / unknown 三态反馈，非 JSON/鉴权/读取错误可见；accepted 不冒充 TUI 消费。
- AC3 自动验证完成：两种取消键均二次确认，前后端防并发及750ms冷却；unknown禁重试，同 pane 文本两条路径共用门。上游非原子窗口已明确披露。

