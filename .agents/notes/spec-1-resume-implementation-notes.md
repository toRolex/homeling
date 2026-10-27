# Spec #1 续接实现记录

## 上下文
- 2026-10-08 从 `~/.agents/homeling-notes/HANDOFF.md` 续接；integration 为 `integrate-v1`，基线 a3500fa。
- 任务快照：`~/.agents/homeling-notes/issues-20261008-resume.json`；审查沉淀：`00-context.md`。

## 决策与因果
- 保留 #10 原 worktree 的未提交实现，不 reset、不覆盖；当前没有可续接子代理，由 opus 接手收尾。
- 已解锁 #8/#9/#21 并行推进，implementer 使用 fable/opus。
- 沿用 handoff 的 issue 交付流程：合入、验证、推送后评论并标记 ready-for-human；真机验收未完成不冒称通过、不自动关闭。
- 版本控制先完成 jj 接入核对：已有 colocated .jj，身份匹配 Git，.env 忽略生效且未发现被跟踪密钥。
- 不使用 dynamic workflow；不新建 PR。
- 根据已确认的测试边界与交付授权继续四票，选择 MIT（无既有冲突时）；概括授权不覆盖后续具体工具拒绝，受限动作须另行确认。
- 顾问建议 #10 后先冻结 #19 服务端写守卫契约，再并行 #11/#12/#13/#15；公共接线随合入串行，最终检查所有 PATCH/PUT/DELETE/POST 受锁保护。#17 首页接线等 #11，#16 等 #15，#18/#20 等 #11。
- #9 上游输入检查与按键写入非原子，不能宣称屏幕绑定消除所有竞态；危险可授权键优先禁用并明确解释，守住审批专属通道，不为交付冒称完整 AC。

## Ticket #8：STT
- 沿用已建 `homeling.ticket-8-stt` jj workspace/bookmark，现场干净；合入 integration 9fce9756 的续接记录，不吸收 #9 未完成实现。
- 公共测试边界：daemon STT HTTP、安全门；录音/授权/取消/资源释放；ReplyComposer 可编辑草稿与显式发送。新增 happy-dom 仅用于真实 React DOM 交互测试。
- Collie 真实协议为原始音频而非 multipart，pane-agnostic；daemon 仅为精确 STT 路由开放容器 allowlist 和 8 MiB 限额，其他写操作仍 JSON-only。
- 浏览器支持探测 MIME（Safari MP4 / WebM / Ogg），最多 60 秒录音；转写只追加原草稿，取消世代隔离迟到流/文本，草稿或 pane 改变不得污染；主对话和任务详情共用回复框。
- MDN Context7 核对 getUserMedia/MediaRecorder/track.stop 生命周期。modern-web-guidance 已加载，但 npx 执行被权限系统拒绝，不绕过或重复；不触碰 Collie 文件、服务或 provider。
- 真机遗留：手机/PWA 麦克风授权、Safari 编码、已配置 Collie STT provider 的真实转写、Tailscale 全链；自动化 fake 不宣称替代这些验收。

## Deviations
- handoff 的 `wt`/原生 Git 修改命令与当前 jj 规则不一致，采用 jj 历史/bookmark 操作；工作目录必须隔离，已有 #10 worktree 保留。
