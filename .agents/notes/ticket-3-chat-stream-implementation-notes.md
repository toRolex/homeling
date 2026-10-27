# Ticket #3 — Implementation Notes

> 任务：snapshot + history → pane 气泡流 · issue #3 · 分支 `ticket-3-chat-stream`

## Decisions

- daemon 接收 tailscale 转发的完整 `/lite/api/*` 路径（ticket #2 health route 已证明）；代理对外前缀固定 `/lite/api/`，只允许 snapshot 与 pane history 的 GET，拒绝 chat、写接口及其他端点。
- 浏览器同源访问 daemon，避免连接 `:8787` 的跨域/认证差异；daemon 只把白名单请求发往 loopback bridge。
- history 消息以 transcript uuid 为稳定 ID；轮询响应按 ID 合并，时间戳排序稳定，未带时间戳项目保留首次到达次序。旧请求不覆盖新结果，断连不清除已显示消息。

## Deviations

- Context7 文档服务在本环境请求失败；assistant-ui API 将以安装包类型声明核对，并由构建/typecheck 验证。
- 真机 Tailscale/手机验收不能在本环境证明，提交说明中保留人工验收项。

## Investigation notes

- `bridge-proxy.ts` 与关联测试已由前任开始，但此前仅是纯函数，尚未接入 daemon `handleRequest`。测试初始失败证实 `browserApiUrl("/api/snapshot")` 会产生重复 `/api/api/`；统一去掉 bridge path 的首个 `/api/` 后修复。
- Contracts 初稿已有 history wire types、fixtures 和 mapper；尚未按 uuid 去重/乱序稳定排序，merge helper 的重复逻辑也会将相同 uuid 多次加入 dated entries。以 UUID Map 合并，更新同 ID 内容时替换、保持列表不可变；TS 时间戳稳定排序，空时间戳排在后面。
- Polling 每次启动即记录 request sequence，而非只在成功回调时记录：较早请求即使在较新请求尚未成功时返回也会被丢弃，避免旧快照/旧错误回滚 UI。换 pane 重置单独的 reducer state，断连和不可用响应保留已收消息。
- History 页面明确尊重 `hasMore`/`fileTruncated`：用户可用 `before` cursor 加载旧页，轮询仍合并实时尾部；截断有提示，不伪装完整日志。
- npm 添加依赖时 Bun 重写了锁文件，但变更仅为 348 行新增，未升级已有锁定版本。Assistant UI + React Markdown 按路由动态加载，避免首页列表承担完整 chat 运行时 bundle。
- 复核确认 URL 解析会规范化路径，不能只对 `decodeURIComponent(pathname)` 做字符串前缀检查；现在先拒绝原始路径每段解码后的分隔符/点段，再解析 URL 并校验最终 pathname 与 allowlist 精确匹配，query 用 URL 的原始 `search` 字符串透传，避免 `%20` 被改写。
- 并发交接复现指出“最新发起请求”硬丢弃会让慢响应永久饥饿。前端轮询改为单请求串行、上次 settle 后再延迟调度；history reducer 对过期响应只接纳未见 UUID，拒绝重复旧内容覆盖。分页有独立 `beforeCursor`，older 页无 ts 时按页前插，tail refresh 不重开 exhausted cursor。
- 同 pane harness session 代际没有可信 wire 标识；`no-session` 或 UUID 全换不能证明换代，清空会误删断连恢复数据。因此保守保留旧 transcript；待和 bridge 实测后确认契约，不做 UUID disjoint 启发式。
- 前任 history fixtures 是本地真实对话快照，含思考内容、GitHub 票务语境与本机路径；发布前替换成合成的 wire-shaped 数据，保持 mapper 覆盖但不把私人 transcript 一起推到公开仓库。
- 最终 state reducer 移到 `apps/web`（不是 contracts）；assistant-ui 的运行时消息列表、bubble 和 Markdown part 均由同一 ExternalStoreRuntime 渲染，避免“runtime 只创建但 UI 另画一套”。

## Verification

- 最终工作树验证：`bun test`、`bun run typecheck`、`bun run build`、`git diff --check` 全绿。
- 真机手机/Tailscale 身份、页面深链与真实 bridge history 的端到端验收仍待人工；同 pane harness session 换代的权威身份待后续 bridge 契约/实测。
