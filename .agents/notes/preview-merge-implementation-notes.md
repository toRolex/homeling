# 开发预览版合并

## 状态
- README 预览范围说明：done；README.md 明示可体验内容、模拟证据与真实闭环缺口。
- PR 正文及 closing references：进行中；保留历史证据，移除自动关闭 #1–#21 的引用。
- 推送、CI、合并及工单读回：未开始；须核对精确 head、绿 CI 和所有工单仍开放。

## 决策与因果
- 2026-10-12 用户明确确认以开发预览版合并 PR #22，不部署、不改 Collie，所有工单保持开放。这取代此前必须全部 AC 闭环才能合并该 PR 的交付门禁，但不降低原 v1 AC 或宣称它们完成。
- 本次仅文档变更，直接执行；独立 workspace 基于 fdd212d，避免将原工作区 notes 改动及 skill 链接删除混入预览提交。
- workspace add 使用 ignore-working-copy 导致建立目录后未完成 checkout，核实新 workspace 为空且 parent=root 后显式 new 精确 fdd SHA；原工作区未被覆盖。
- 不创建 release，不启动 demo/服务，不清理旧 WIP 或备份。

## Deviations
- 无范围偏离。预览合并与正式 v1 完成交付明确分开。
