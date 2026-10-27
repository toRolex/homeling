# #19 idle-lock 收口记录

权威决策与前阶段因果记录：`/Users/rolex/.agents/homeling-notes/19-lock-decision-20261009.md`、`19-idle-lock-implementation-notes.md`。本文只记本次恢复后的收口。

## 原现场及权限
- 完整读交接、#19研究/决策/notes/spec快照，加载jj/tdd/pre-implement。原workspace @为785cb9a0fb4faac4b9c184fa71b34b59802f574c，忽略与Git/jj身份核对一致；未reset、cleanup、共享rewrite、处理全局divergence。
- 最新真实用户明确允许仅原workspace以新child合最新integration、验证冻结；不能写主integration，生产凭据/部署与被拒v4 Crypto QA fixture仍不授权。
- 已以 `jj new @ integrate-v1` 新merge child保全785。实际第二父为43a6135b22d1909f2071e527359d7f97b8d94343；随后主正式通知此#16已合且推送的完整tip。785及其祖先未重写。

## 合并处理及验证
- index冲突只在imports：兼保isLoopbackAddress与PaneWire及activity导入。
- ConversationPage四块冲突：兼保#19父控draft/sessionSnapshot与最新occurrenceKey。任务occurrence各自保存草稿，避免相同pane不同历史发生次串草稿；继续按mainPaneId或pane+occurrence remount执行状态，不复用旧unknown/partial许可。
- 合并新增web-push依赖未安装导致首次typecheck缺模块；仅在本workspace `bun install --frozen-lockfile`，不改lockfile。随后typecheck与build绿。
- 最初因临时凭据门禁，仅执行无初始化白名单。随后本会话真实user消息明确确认现有自动化测试可在隔离临时目录生成/轮换/清理测试凭据与push测试keys，主也确认继续；恢复full bun test。新工具无deny。没有运行旧v4 Crypto QA fixture、生产init或部署。
- 全量首轮RED为469pass/1fail：最新push-api HTTP positive fixture只带cookie，未跟进#19 epoch/generation双头。仅修公共测试fixture：从实际unlock响应取两头；缺头与stale boot仍423、pref不变/0sent，有效双头才200。生产守卫未改。
- 定点push-api 4pass/0fail；随后完整470 tests（84 files）/0fail、2062assert，typecheck/build均绿。测试有既有React act warning及预期fake activity故障日志，不是test failure。
- 经传递import/setup审查，公开mock verifier、内存session、web fetch/media/DOM fake不调用持久凭据初始化。白名单为daemon session-controller/session-lock与web session-state/api/send-queue/SessionBoundary/ReplyComposer.voice/voice-input/persona-memory-root：本轮53 tests（9 files）/0 fail、214 assertions，含实际AppRoot在锁中mainPane替换后保持草稿且businessAttempt=0。此不是全量tests，不沿用旧396/465数量。
- 独立Opus安全顾问窄复核返回0高置信必须fix阻塞，确认仅daemon会话写保护的有限保证；不等于全量/真机认证。独立Opus code-reviewer完成相对43a6135b完整19 delta静态审查，Standards/Spec均0高置信阻塞，末修（双头、malformed423、Voice、mainPane草稿、无重放）及冲突解决无遗漏。两者只读、不运行tests；仍不替代本轮全量三绿或真机验收。

## 限制
- 写锁仅保护Homeling daemon，不覆盖Collie根API、同origin XSS/root SW、同UID；不撤回已派发操作、不自动重放未知/partial。
- 真机HTTPS/Tailscale身份、多设备/PWA/Voice/锁后滚动及通知仍人工；没有初始化真实默认state、生成部署凭据、运行被拒Crypto QA fixture或真实部署。

## Deviations
- 无产品决策偏离；临时测试许可恢复后已实际完成全量三绿。原785祖先、WIP与备份/stale全保留，不做全局divergence修复。最终冻结前实际integration仍43a6135b22d1909f2071e527359d7f97b8d94343，已在父链；独立原reviewer对push-api.test.ts49–62窄delta静态复核0阻塞，主收到实际报告并转达。冻结ticket-19-idle-lock到已审三绿revision，再jj new离开；后续不改共享green。
