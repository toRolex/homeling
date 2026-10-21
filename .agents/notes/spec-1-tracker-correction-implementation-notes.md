# Spec #1 标签纠错与验收续接

## 决策与因果
- 用户指出全部实现票应由 agent 完成，要求恢复 ready-for-agent、逐票核验并继续 implement-spec/PR 流程；本轮 PR 请求取代此前不开 PR 的限制，不授权合 main 或实际部署。
- 仓库 triage 定义 ready-for-human 为需要人工实现，不能将其当作等待验收。前序批量标记及本轮沿用该判断均错误；20/20 代码集成不等于全部 AC 满足。
- 读取远端全部 21 票正文、标签及开放 PR，确认 #2–#21 错标 ready-for-human，#1 已为 ready-for-agent。批量 mutation 返回 HTTP 504，先独立读回确认 #2–#16 已生效，仅补写 #17–#21；最终读回全部 21 票 ready-for-agent、OPEN。未关闭或分配任何票。
- 原 fixer SendMessage 返回 No transcript found，当前暴露接口无法恢复旧 agent；原记录、workspace 和私有备份保留，备份 SHA256 与交接一致。用户最新要求继续流程后，由唯一 Opus 继任 fixer 原地接管现有七文件 RED WIP；不重建、不 reset、不另建并行写者、不读取代理原始日志。
- 独立只读验收者按 fresh 工单正文与既有证据整理 AC 矩阵，不从提交数或标签推断完成。继任 fixer 只写原独立 workspace，主独占 integration/tracker/PR。
- 已创建并读回 draft PR https://github.com/toRolex/homeling/pull/22：integrate-v1 → main，head 59ccc9882d773e1d1700db0cc7bc3b37f757a808。关闭引用只在合并时生效；未验收通过不得 ready/merge。远端 main 63ba44e3 是 integration 祖先，不是未集成的新变更。

## 验证
- 已有 integration 59ccc988 的 522 tests / 0 fail、typecheck/build、CI 通过；不覆盖未合入 fixer WIP。
- 标签纠错与 PR 创建已独立读回。逐票 AC 核对已完成，矩阵 `/Users/rolex/.agents/homeling-notes/spec-1-ticket-acceptance-recheck-20261009.md` 区分自动化覆盖、真实环境待证和明确实现缺口；#13/#17/#20 仅为条件性关闭候选。
- 继任 fixer 实际回执：七文件 WIP 与备份 MATCH；runtime 从复现 23/3 修到窄测 26/0；手动锁确认新增实际 AppRoot 交互回归通过。尚无最终 fulltests/typecheck/build 或合入证据，不能据此宣称全部修复。
- 窄顾问实际结论：#6 缺 launch 操作持久结果/终态清理确认；#9 缺原子 prompt-generation 校验并写键及 Cmd 契约；#16 缺可信 request generation 与可恢复事件游标。现 zero-touch 上游公共接口不足以证明相关 AC；已传唯一 fixer 补守卫公共入口回归，不通过猜测或放宽安全伪造闭环。
- PR #22 已更新并读回上述验收矩阵摘要、runtime 26/0 和能力阻塞，保持 draft。修复后全量验证、最终 UI 确认和新 tip CI 仍待执行。
- 最终 fixer 冻结 0e5c113e42e9f1b81b0285e543d1c7ea80eb7f1d，并 jj new 离开到空 child；主核身份、祖先、审查末 delta（与04f4846仅notes差异）、备份hash后串行合入，保留主纠错记录。主实际复验 528 tests / 0 fail、92files、6638assert；typecheck/build exit0。不是沿用实施者结果。
- 浏览器复用 space1/p1、ownership=agent，最新 dist 一批最终确认：快捷回复44px、Save真实Tab聚焦自动滚动避fixed nav；锁POST公开模拟失败时server unlocked、UI持续未确认告警；原对话idle-lock解锁保留草稿/路径且零重放；德语设置/新建、triage两人→模拟审批后1人、任务详情/raw mirror、unknown Retry原生风险确认取消及history503都不重发。截图与详细边界 `/private/tmp/homeling-final-ui-confirm-WmdEZ4/CONFIRMATION.md`。
- UI-only契约check/三套verify通过；公开fake无真实auth/handler/provider/设备保证。机械detector仅跑一次，变更五个TSX/CSS目标结果[]。locator/原生dialog属性/stale ref造成的自动化错误均先观察，不报告为产品失败。不创建新space、不碰用户tabs，不继续polish。

## CI 与 tracker 后续
- 首次主冻结/push 为 85ee3af1bd79fa74ac295d6fb16a8af5798f621c；已 jj new 离开。HTTPS push 两次 LibreSSL SSL_ERROR_SYSCALL 后先读回远端未更新；curl 与两种本机 Git 的只读 ls-remote 均可连接，按安装版 jj help 文档仅当次命令显式 git.executable-path=/opt/homebrew/bin/git 后推送成功。未持久改配置或关闭 TLS 校验，未证明根因就是二进制差异。Context7 resolve 当时 fetch failed，不声称官方文档查询成功。
- 两个同 SHA 新 CI 均 failure，实际 527/1：scripts/deployment-docs.test.ts:75 的 canary shell 正常 save→check 在Linux失败。本机528/0不代替CI；唯一fixer以85新child继续跨平台TDD，不skip/改pin/放宽守卫，不修改共享0e绿色。失败证据 `/tmp/homeling-final-ci-failure-Tynbpb`，run37934872845。
- 随后唯一fixer实证 GNU stat -f 失败前输出 filesystem 文本，原命令替换将其拼入 mtime；独立捕获失败probe后用GNUmtime覆盖，确定性污染stub RED→GREEN，真实本机gstat隔离严格矩阵通过。两原窄review/simplify无新增阻塞，不代表LinuxCI成功。
- fixer新冻结12e81c284e1d84382d2f5d62ab60170ce7226d4b，已jj new离开；主核完整SHA、与已审3c485d仅notes差异、身份/祖先/空child后串行合入。主重新独立实跑529/0、92files、6648assert，typecheck/build exit0。仅canary/tests/notes变更，不重做已经完成的UI最终批；Linux新CI仍须推送后独立读取。
- Draft PR #22已更新失败与真实边界并readback。Spec #1、#12、#19新增评论并独立读回；所有21票仍 OPEN + ready-for-agent，不close、转人工或标PR ready。
- 原始freeze/WIP/stale/私有备份保留；space1已finish，自建QA监听18790已停止，最终UI不再重复polish。CI脚本局部修复不要求重做UI批。

## 2026-10-11 续接
- 按最新交接窄核本地 integrate-v1、origin tracking、远端 branch 与 PR #22 head，全部为 fdd212d13ec7d49889f307662035f197ec8d245a；主工作副本干净、空 child addc8715。现有身份一致、标准 .env 路径实际 ignore；不宣称所有 ignored 文件无秘密。
- 本次独立读取 run37938335737/run37938329819，均同一完整 fdd SHA、completed/success。Linux CI 故障闭环；已窄读前序主日志 /tmp/homeling-final-linux-fix-check-3GXlBV:61–82，确认529/0、92files、6648assert与typecheck/build exit0；本次不重跑已绿测试或UI。
- 已在仓库外验收矩阵追加最新时态，#21 纳入条件性逻辑关闭候选，保留有限敏感扫描边界；候选#11/#13/#17/#19/#20/#21不等于已经关闭或全AC完成。
- 远端只读回全部21票仍OPEN/ready-for-agent、PR仍draft。准备的正文保留于 /tmp/homeling-pr22-ci-sync-XXXXXXXX.md；更新PR的compound command被新的External System Writes权限明确拒绝，整个command未执行，未更新正文/评论/关闭票，也未替换工具或委派绕过。
- 剩余frontier由新的单个Opus只读核对者接手，报告 /Users/rolex/.agents/homeling-notes/spec-1-remaining-frontier-20261011.md；已按精确AC分清可补真实本地镜像/资源恢复关系、需设备/provider联验、四组已证上游能力缺口。随后仅做现有bridge launcher只读preflight，不恢复不存在的旧会话、不启动fixer、不改冻结历史、不删除任何WIP/备份。
- 完整scope与zero-touch冲突必须一次明确需求决策；有限交付需逐条延期真实AC和能力条款并调整closing references，不能将“认可代码”或PR请求当AC豁免。当前未改scope、未关闭票、未标ready、未部署。

## Goal 续接
- 用户设置会话目标 /implement-spec issue #1，继续原完整scope，不将目标设置当作AC豁免、PR写入拒绝解除、生产部署许可或允许改Collie。
- 对剩余真实协议验收的launcher 403继续做窄只读契约诊断，区分应用层未认证与工具权限拒绝；仅读代码已确认普通proxy仅转发请求身份、内部getLaunchers有已配置trusted-user fallback，二者不能混同。不能据此猜当前403根因或给其他业务路径补身份。
- 下一窄单元只核既有Tailscale Self/Serve前门与正常HTTPS读取，不输出私人配置/域名/login、不添加身份header、不关闭TLS、不修改Serve/allowlist、不控制用户资源。暂不启动临时daemon，dev HTTP不会自动解决上游认证。
- 本次实际核两关键WIP备份SHA256，final-fixer仍89355f28cca22af10d9f2ca2fbc3b260fb2d56eece8a2081cbb9b64e5e3719f0、ticket17仍879c932c8ca5d4df863950fd048d6ed5262c99ce74bb47459b15df6fca935bf9，与交接完全一致。
- 只读前门单元实际完成：核既有真实Tailscale HTTPS根handler指向Collie8787、正常GET /api/launchers返回200，当前真实身份下launchers数组长度0；无身份header伪造、TLS放宽、配置写入或私人配置输出。先前403访问条件已收窄，但不能反推其唯一原因。
- 新准确阻塞为缺合法已配置安全launcher/可信QA cwd，暂不能启动A/B/C真实协议单元；没有启动daemon/QA/create/send/stop。保持zero-touch不修改allowlist，不用任意shell/home/fake行替代。报告证据位于spec-1-remaining-frontier-20261011.md:137–149。

## 最新真人硬边界
- 最新用户约束要求已安装Collie保持不变且不受影响。因此不补改Collie launcher/allowlist或其他配置（即使安装目录外）、不重启/重载其生产服务、不改bridge/二进制/根handler；不以Stop hook或外置配置作为例外。
- 前一只读配置顾问区分了文档zero-touch与单元边界，但尚未执行任何配置动作；该候选方向现由真人最新指令关闭。当前真实前门零launcher维持阻塞，不能通过修改Collie补材料。
- 只允许继续评估Homeling自身与不影响现装Collie的隔离资源方案，无法闭环的AC如实保留，不能自行改scope、伪造通过或重复被拒外部写入。
- 读过canary脚本与原baseline三行静态赋值后，以GIT_OPTIONAL_LOCKS=0及取消可选daemon health环境变量运行check（没有save），实际全部通过：Collie checkout clean、bin mtime/SHA256 untouched、root handler仍127.0.0.1:8787。原baseline未覆盖；该证据仅证明所列安装不变量，不是部署前后/手机AC完成。
- #12可信替代来源窄咨询确认当前掌握的是冻结上下文Markdown路径而非pi transcript路径，不能凭路径/顺序猜attempt绑定。主已成功Context7查询官方 /earendil-works/pi：RPC id仅关联response、session事件一般无command id；get_entries有持久entry游标；custom_message可持久details但sendMessage返回void。继续窄判断新来源与现bridge普通user history的精确关联，不把API存在当现接线完成。

## 当前可执行边界收敛
- pi公开契约窄复核最终结论：custom entry中的上游持久details可为新专用history建立attempt→真实custom entry映射；这不是现bridge普通user entry映射，未证明新提交语义等价。当前wire维持unbound，不能替换bridge气泡或关闭finding。没有实施新扩展/提交协议、没有启动真实pi或改Collie。
- 真实launcher读取已合法成功但数组零行，且真人禁止修改或影响Collie；不继续配置探查/补配。所有只读子单元已完成，当前没有在写主/运行QA的worker。
- 原完整scope仍要求四组上游能力与真机/provider验收；只能由不修改现装Collie的独立兼容环境/公开能力提供，或真人明确修订需求范围。当前不自行选择任一路、不假完成、不转ready、不合main。PR更新工具拒绝仍未解除；本地草稿与全部原材料保留。

## 后续独立 frontier 核对
- 在不改Collie边界下，仅针对未验#14 AC3核对原票更新要求与Homeling注册/激活接线；没有重审已修SW缓存或重开旧UI批。不得因缺更新按钮自动新增AC，也不得为满足goal制造缺陷。
- 独立核对实际返回：#14 AC3原文仅“版本更新有可观察的刷新路径”；生产sw.js安装自动skipWaiting/激活clients.claim，注册模块有检测/reload路径。main.tsx虽仅console/global函数，无可见按钮，但票面未要求按钮，不能改判为已证代码缺陷。仍需手机已装旧版→新版→普通刷新/重开观察版本的真实证据，未额外修改UI或开启重复polish。
- 至此当前合法可执行的窄核查均已完成；不继续重复旧探索、制造新bug或用fake补真机证据。目标仍被公开能力/测试材料及PR具体写入权限阻塞，绝不为Stop hook把未满足AC标通过。

## Homeling-owned adapter 候选设计
- 按完成Homeling的目标，继续一次有界设计，两个并行只读单元分别核独立启动/控制与消息/请求事件producer。聚焦未闭环#6/#9/#12/#16，不重审完成票；采用deep module/interface/seam术语，要求真实production adapter而非仅新增抽象/合成generation。
- 设计须先对原票业务AC与PRD辨别：复用Collie哪些是硬要求、哪些仅现implementation选择。当前没有批准或实施新启动/提交/history协议、没有改变原spec或改Collie；不把候选方案及goal设置当范围变更授权。
- 可实施且保持原AC的部分才进入独立workspace/TDD；原子按键/Cmd语义/普通消息与custommessage语义等不能无契约保证，范围冲突集中记录一次，不靠guess/allowlist绕过凑完成。

## 独立 adapter 设计回收
- 两个Plan单元均实际完成但受只读约束未能落盘；主将摘要保存至 /Users/rolex/.agents/homeling-notes/spec-1-owned-runtime-launch-control-design-20261011.md 与 spec-1-owned-runtime-message-events-design-20261011.md。无代码/SDK安装/进程/生产配置/tracker动作。
- 新明确事实：原#6明文要求Collie launchers.toml allowlist与bridge /api/launch；#1/领域模型task=Herdr pane、snapshot/history复用bridge。自有catalog/PTY/SDK不能被视作原路径不变的implementation修补，更不能冒充Herdr pane或自动fallback。
- 可落地候选：固定版本真实pi SDK的custom-entry receipt、真正阻止工具执行的gate、持久generation/journal/cursor，继而接入owned API/UI/push。普通prompt有commands/templates预处理，custom message虽模型侧role:user但不等价；只对新owned分支保证，旧bridge条目继续unbound。
- 候选不能自行补外部TUI receiver CAS、Cmd契约或任意工具后代clean证明；PTY write/onExit不代表消费或整个进程树清理。消息事件候选不代替原控制/清理要求，真实手机/provider仍需验收。
- 下一真正依赖是集中架构范围决策：是否修订#1/#6启动来源、runtime/Herdr映射及history来源并明确owned支持范围；未决定不新增仅抽象seam/合成generation、不安装依赖或启动替代runner、不把计划当完成。

## 新真实 QA 路径与权限拒绝
- 找到另一项不改spec的子证据路径：开发者新建真实Herdr QA pane中的有限标记程序，经正常已认证HTTPS读取，与临时Homeling镜像路径对比；不把测试夹具创建冒充原#6 allowlist产品launch，不伪造task/approval/身份，也不用于任何已拒PR动作。
- 整个Agent委派在执行前被新的Modify Shared Resources工具拒绝，明确要求具体Herdr QA workspace/pane创建许可。该Agent未启动，没有资源创建、脚本、server、credential或输入/清理操作；不存在待恢复的QA worker或已创建pane IDs。
- 新拒绝不能由先前一般隔离测试授权覆盖，也不能主执行、换工具、代理、测试代执行绕过。待真人具体确认仅一个新QA workspace及一个自有pane、有限无模型程序、关闭该pane/保留明确空归档space后，才能再次经正常权限流程执行。
- owned架构范围修改仍是另一项独立决策；QA资源许可不默认修改#1/#6或解除PR正文deny，架构许可亦不自动允许生产部署/服务变更。

## Deviations
- 原同 ID fixer 无法通过当前会话接口恢复；按用户最新继续实施要求，唯一继任实施者保留现场续接，未覆盖或删除原成果。不能将其描述为原 agent 成功恢复。
