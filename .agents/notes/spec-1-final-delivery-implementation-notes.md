# Spec #1 最终交付续接

## 上下文与授权
- 交接：`/tmp/homeling-handoff-KTHfCJ/HANDOFF.md`；任务快照：`/Users/rolex/.agents/homeling-notes/issues-20261008-resume.json`。
- 2026-10-09 用户直接确认三项操作：#16 固定 f5089592 合入 integration；#19 原 workspace 接入最新 integration、验证冻结后合入；#20 核验并使用全新临时输出路径继续 scan。
- 只读核验主 HEAD / integrate-v1 / origin tracking 同为 6e7ed8f0b0976adced275d85b7d84ae242fbde9d，主目录干净；原代理当前不可联系。
- 保留全部冻结成果、WIP、stale 目录及恢复备份；禁止全局 divergence 修复、GC、覆盖私人 ignored 文件。
- 不开 PR、不合 main、不正式发布；凭据初始化、实际部署未纳入此次明确授权，不执行。

## 决策与因果
- 原代理不可联系，由 Opus 实施者续接原 workspace，先只读核现场，不重做已完成票。
- 主目录写入与 integration 合入仅一位 owner；旧 merger 已明确交还 ownership，后续由主执行器串行合入。#19 与 #20 独立 workspace 实施，避免共享 change 重写。
- 用户在临时测试凭据与替代 QA space 两项专项请求后，直接明确授权继续所有完成任务所需操作；恢复现有隔离测试初始化/轮换/清理及临时 push 测试 keys，替代浏览器 space 为 1/p1。生产初始化与部署不作为本次代码交付动作；新的真实工具拒绝仍须停止，不能代理绕过。
- 分享 green revision 后先离开到新 child；引用完整 SHA。
- 最终统一 Standards / Spec 审查基线 main 2f245143；由单个 Opus fixer 收敛全部问题。

## Deviations
- 无。
