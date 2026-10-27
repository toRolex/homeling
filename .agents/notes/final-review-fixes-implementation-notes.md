# 最终 review 修复

## 范围与决策
- 基图 59ccc9882d773e1d1700db0cc7bc3b37f757a808；统一收敛 Standards / Spec / runtime 专审及一次 UI 批量问题，只写独立 fixer workspace。
- 错误采用固定响应/事件与允许的机器 code，不输出上游 message/cause，不改变 unknown/partial 语义。
- history 显示仅使用持久、精确的 session/entry/attempt 绑定，绝不按用户文本前缀裁剪。
- 手动 unknown retry 为额外加固：刷新 history、重复风险确认、排队执行复查；不宣称 exactly-once 或额外 spec 违规。
- 生产初始化/部署、浏览器、旧 fixture 与恢复材料不操作；新的真实工具拒绝立即停止。
- modern-web-guidance 已加载；旧 npx 拒绝不重试。继任实施者通过 Context7 React 官方文档核对异步事件错误需显式状态反馈。UI 保持现有视觉，仅修确认语义与触控尺寸。
- 2026-10-09 继任实施者接管：七个磁盘 WIP 与原私有备份逐文件一致，archive SHA256 89355f28cca22af10d9f2ca2fbc3b260fb2d56eece8a2081cbb9b64e5e3719f0；身份/ignore 门通过，未 reset/restore/重建或清理原材料。
- runtime 将 HTTP 失败、orphan、Activity 订阅者与观察日志收敛为固定事件/白名单 code；保留 delivery evidence，不记录 raw Error/message/cause。独立复核发现明确 executed:false+deliveryUnknown:false 被误升 unknown，已用实际 proxy 回归修复。
- 手动锁先本地 fail-closed，服务器 locked 响应才确认；POST 失败与 GET unlocked 持续提示服务器锁未确认，其他会话仍可能修改。六语言文案与实际 AppRoot 交互回归覆盖。
- unknown 全文 Retry：公共 guard 在初次刷新后确认重复风险、出队后再刷新；保留原始 lease，绑定组件生命周期取消，双击在初次检查期间去重。独立复核发现跨卸载可继续旧 pane 写，已用两条真实页面路径回归修复。明确未输入仍全文重试，已输入 partial 仍仅空文本提交，persona durable unknown 不绕过。
- SW 测试执行真实 public/sw.js，删除未被生产引用的镜像 strategy.ts；覆盖 API/navigation 次序、当前缓存生命周期、静态 cache-first/deep-link network-first/offline，以及失败 HTTP 不污染 shell。实际 canary shell 调共享 parser，覆盖正常/dirty/不可读 Git、多 root/缺 root、binary 变化；不改旧 baseline/pin，不执行部署。
- Quick replies 增至至少 44px；document scroll-padding 与 focus scroll-margin 给 fixed nav 预留空间。README 删除语义与实现一致；公开 note 私人授权引述改因果摘要。最终真实浏览器确认由主串行进行，不能把 CSS/DOM 当物理焦点验收。

## 验证
- 接管后 RED 复现 23 pass / 3 fail；runtime 首切片 26/0。
- 手动锁先 RED 后 GREEN；确认/语言/AppRoot 窄测 13/0，typecheck 绿。
- canary/SW/触控/保守元数据窄测 25/0；实际 SW 发现失败 HTTP 污染 offline shell并修复。
- 首次全量 520/2：unbound 语义旧断言与白名单误丢 stt.unconfigured；后者修生产白名单，没有弱化 STT 断言。其后两项 review 阻塞 TDD 与日志回归均收敛，局部 55/0。
- 第一轮修后全量：526 tests / 0 fail、92 files、6634 assertions；typecheck/build 均绿。
- simplifier 补充实际 SW cache.put 拒绝会把成功网络响应降失败：两条实际入口 RED 后，对 cache.open/put 的写入失败局部隔离，成功网络响应保留；新增两回归，SW9/0，typecheck 绿。safeUpstreamFailure 加显式返回类型，不增加 factory。
- 最新 04f4846c4550af9728d656f1d5e4b37df4ee284d 全量实跑：528 tests / 0 fail、92 files、6638 assertions；typecheck/build 均绿。已有 React act warnings 与固定故障注入日志仍存在，不称零 warnings。
- 原独立 reviewer 对 57841a4 两阻塞已消除、无新增高置信阻塞；两原审查者对 57841a4→04f4846 精确末 delta 实际复核，SW cache.open/put 隔离与显式类型通过、无新增阻塞。均只读、未代跑 tests。cache.open 拒绝的独立注入测试属非阻塞补充，不扩大本轮 polish。
- 交付边界顾问实际返回：认可有限修复代码交付，#6/#9/#12/#16 与真实设备 AC 仍 OPEN；只读 notes、未独立核测试/历史，不当作旧 history 顾问返回或用户豁免。
- 已核最新 integrate-v1 为 59ccc9882d773e1d1700db0cc7bc3b37f757a808，确在 fixer 祖先；无需构造无意义重复 merge。最终冻结后 jj new 离开，再由主串行合入与复验/单批 UI/CI。

## Linux CI canary follow-up
- 基线改为主已合入/推送的 85ee3af1bd79fa74ac295d6fb16a8af5798f621c；从原空 child 新建 own revision，未修改分享 green 0e5c113e 或 integration/bookmarks。
- Linux run 37934872845 实际 527/1，唯一 normal canary save→check 失败；读取主提供的合成 fixture CI 日志，不读取代理 .output。旧 macOS 三绿不覆盖本次子修订。
- 根因实证：GNU stat 的 `-f %m` 失败前向 stdout 输出 filesystem 数据；原命令替换把失败 stdout 与 `-c %Y` 的 mtime 拼接成 fingerprint，filesystem 变化被误判为 binary 变化。入口回归先用兼容 GNU 的失败 stdout stub 确定性 RED，诊断打印 was probe1/now probe3；不凭猜测改 pin。
- 修复仅单独捕获 BSD probe，失败后由 GNU probe 覆盖值；SHA256/mtime 双检查、dirty/不可读 Git/multi-root/缺 root/binary 变化拒绝均保留。入口测试增加 native/GNU-fallback 两模式，并在 normal save/check 拒绝时显示 stdout+stderr；断言未放宽。
- 窄测 deployment-docs/canary 11/0；另用本机真实 /opt/homebrew/bin/gstat 对隔离合成 fixture 实跑 save/check、dirty、unreadable Git、multi-root、binary 变化矩阵全部通过，baseline 字节不变。该 GNU-on-macOS 证据不是 Linux CI 成功声明；新 Linux CI 仍须主推送后读取。
- 3c485d475822b792a014b93fd569438d5e2c4069 新 child 实际全量 529/0、92 files、6646 assertions，typecheck/build 绿；既有 act warnings/固定故障注入日志保留。旧 528/0 不作为本次证据。
- 原独立 reviewer 与 simplifier 对 85ee3af1→3c485d47 精确只读复核均无新增高置信阻塞、无需继续简化；顾问亦认可有限最小修复。审查者未实跑，GNU 隔离矩阵/全量三绿以执行器实跑单列；Linux CI 仍待主推送读取。
- Context7 GNU Coreutils 查询网络 fetch failed，未宣称官方文档查询成功；本机真实 GNU 行为与公开入口回归是根因证据。
- 本轮不改 UI、不重跑浏览器、不部署、不操作真实 Collie；notes 收尾后再次核最终完整 SHA 三绿，jj new 离开再 READY。

## Deviations / 未闭环
- #12 上游 wire 无可信 session/entry/attempt 绑定；daemon attempt 元数据明确 historyBinding=unbound，保留 history 原文及用户自输前缀，不用唯一同文/时间/frontier/本地 UUID 猜隐藏。未实现可信持久显示绑定，不能称该 finding 全修。旧 history 顾问未收到，不引用虚构结论。
- #6 上游 timeout 无安全确认清理全部残留能力；#9 Enter/Cmd/任意 Ctrl 组合仍禁用；#16 不可观察同文新 generation 仍保守可能漏推。真实手机/HTTPS/PWA/STT/pi/push/双通道 AC 未由本轮自动化证明，不自行豁免或 close。
- 外部首装 helper 旧草稿漏 tsconfig.base.json digest，本轮只写 fixer workspace、不覆盖旧草稿/证据；不能用于生产部署。未 init/apply/deploy。
- 主工作区/integration/bookmarks/远端/tracker/PR 均由主独占，本实施者不写；原冻结、WIP、stale、备份全部保留。
