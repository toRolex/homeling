# Ticket #11 implementation notes

## Decisions
- 用户授权 public API / 持久化 / 前端行为 seams；测试卡片真实状态与 transcript 最近一句、路由/插槽、删除 API 结果及资源保留语义，采用逐切片 red-green。
- 独立 workspace `/Users/rolex/Documents/Codes/githubProject/MyProject/homeling.ticket-11-persona-home`；base ca826f0528dc7760f631bddb63efa67f2cc24a61；bookmark ticket-11-persona-home。secret ignore、Git/jj 身份均核验。
- 显式依赖 #19 contract-only revision a4750d622dd6dc8ad8508d386b0b0a65b69f1644（session-lock.ts）；未声称全票完成，不自行生成 system actor/bypass。#11复用现有 daemon DELETE，不增加用户写旁路，完整业务门禁依赖 #19 集成。
- App slots（homeSummary、memory(personaId)、activity(personaId)、customize(personaId)、settings）隔离后续票；未接入能力明确提示不可用。主对话路由不变，详情 /persona/:id/details；底栏 /、/new、/settings。settings 可接 React fragment 容纳多设置。
- 首页只显示 daemon registry persona，不收编 Collie panes；最近一句只从主 pane transcript 的非 abandoned user/assistant text 获取，不把 terminal title/thinking/tool 当成说话。
- 状态用现有真实 runtime projection；读取失败明确数据过期，不继续宣称实时 Thinking。
- 删除沿 ADR-0006：主 pane关闭；space保留归档；task不关闭。HTTP成功但 archived:false 明示归档命名失败；网络失败不可断言未执行，提示核对。
- 原生 dialog showModal 提供焦点约束/Escape；路由可深链接。现代指南已查询（本机 skill过期，未自行更改配置）。

## Deviations
- workspace add带 --ignore-working-copy 部分创建后失败，新工作区最初在root；只重定位自己的空change到指定ca826f05，未修改主checkout/integration bookmark。

## Review / Verification
- 已逐切片 red→green：真实最近一句、底栏/设置组合、DELETE partial API、面板资源语义、延迟DELETE not-found轮询结果丢失、创建离页晚到导航、423明确当前attempt未派发、unknown A→B→A路由世代重读。
- 独立简化（a80b075c9febe2dfd）：PersonaDetail显式分支/单次persona查找/Props与返回类型，不改后继票。独立顾问（ac9ea50b0168e4de1）发现并修复删除轮询和创建晚到；Escape焦点阻塞经真实DOM测试撤回。deletionScope永久冻结问题以仅详情内层personaId:entry key修复，不重挂载主对话/lock boundary。
- 同详情世代删除开始后冻结读取，partial/unknown直到关闭保留；之后明确用户导航产生新世代才重读。unknown后的423仅代表当前attempt未派发，不清洗此前unknown风险。
- 自有工作区显式merge integration 3a322b2fc942b158e31ab97fbd02ea91315467cb，保留#9特殊键/输入门禁改动。主checkout与integration bookmark均未写。未吸收#12/#13/#15实现；exact slots已通知父协调器。
- Vite localhost+浏览器fetch mocks：desktop/mobile首页、详情、大avatar、本机Computers、partial删除提示、Escape、New/Settings检查通过。只有本地fixture浏览器证据；未连接真实Collie/Herdr、未变更服务、未声称真机验过。browser space4已finish；收到主space3独占后不再操作浏览器。
- UI机械detector唯一gray-on-color告警为误报（定位行合并了中性色说明与独立green按钮，按钮文本实际green-950）；不为误报改全局样式。
- 未新增env要求，不改README。#19尚非整票完成：仅actual contract依赖，不宣称业务完整写锁已生效；完整guard/boundary由其后续合入与交叉验收，父已明确允许完整#11先交付。
- 冻结feature revision ddd9d6bf88c5e74df627a34b4e297795b1f36675，作者rolex <torolex@163.com>；base integration 3a322b2f。最终 `bun test` 286 pass / 0 fail（1074 assertions、42 files），`bun run typecheck` 与 `bun run build` 全部成功。没有package.json `verify-seams`脚本，未声称该额外命令通过。
- 独立code-reviewer a5d64c87838234114首轮真实阻塞0；focused fake DOM/mock fetch 13 passed。顾问增量经主协调转达仅剩deleted:false洗掉此前unknown风险；已另一个red→green DOM切片修为“本次未确认删除”，保留此前unknown风险，未扩API/slots，未重写冻结ddd9d6bf。
- 最终增量后 `bun test` **287 pass / 0 fail**（1080 assertions、42 files），`bun run typecheck` 与 `bun run build` 全部成功；integration最新仍3a322b2fc942b158e31ab97fbd02ea91315467cb。主协调转达唯一merger两轴critical+e9d9ddb最小delta独立只读0阻塞，已ready排入串行合入复验。额外fake persona.integration+删除DOM/API26tests通过。feature冻结e9d9ddb17a4a31939ba362ebb1d17893654f9bc6（ddd9d6bf子代），不再重写；本notes最终记录为新child。普通code-reviewer若增量返回新增真实mustfix立即另报主协调。临时Vite验收进程已停止，browser taskspace已关闭。

## Consumer wiring
- `App({slots?: PersonaShellSlots})`，`shell-slots.ts`定义 `homeSummary?:ReactNode; memory/activity/customize?:(personaId:string)=>ReactNode; settings?:ReactNode`。
- `main.tsx`中catch-all `<App slots={{memory:(personaId)=><PersonaMemoryEditor personaId={personaId}/>,activity:(personaId)=><ActivityPanel personaId={personaId}/>,settings:<><SessionLockButton/><PushSettings/><LocaleSettings/></>}}/>`；仅actual绿色组件存在后由父窄接线。
- #19 `SessionBoundary`须包住整个BrowserRouter/Routes，不能只包App（主对话/任务也需保护），不能在锁变化时替换children或router key。
- 共享 `PersonaAvatar({avatar:PersonaAvatar,size?:'card'|'detail'})`用于首页、面板、主对话header；#18只需扩该seam并接customize slot。#17接homeSummary；#20可扫所有文案，settings fragment追加locale。
