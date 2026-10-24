# 部署与使用

> 开发预览版。本文描述现有 legacy Collie / Herdr 路径，自持 runtime/history 尚未实现。不要为了尝试预览修改或影响现装 Collie。部署操作须由操作者另行确认，不能把以下命令当作已验收证明。

## 自部署（macOS 用户登录会话）

### 1. 前置条件

- macOS、已登录的图形用户会话；launchd user agent 不是开机未登录服务。机器须保持在线/唤醒，睡眠时手机不可用。
- Bun（支持本仓库 lockfile；CI 使用 latest）、Git、`curl`、`shasum`，以及 PATH 中可用的 `tailscale` CLI。
- herdr / Collie **已独立安装并正常运行**，bridge 默认监听 `127.0.0.1:8787`；Collie checkout 默认 `~/.local/share/collie`，`bin/collie` 存在且工作区干净。
- Mac 和手机加入同一 tailnet，MagicDNS / HTTPS 证书可用，tailnet 策略允许手机访问 Mac HTTPS。只用 Serve，**不启用 Funnel**。
- `tailscale serve status --json` 中原有 HTTPS `:443` 的 `/` handler 指向 `http://127.0.0.1:8787`。不满足时先修复原有 Collie 部署，不让 Homeling 重设根 handler。
- 需要派任务时，先在 Collie 既有配置入口配置 `launchers.toml` allowlist 和 agent 凭据；Homeling 仅选择现有 launcher 行，不替你改 Collie 文件。

```bash
tailscale serve status --json
curl -fsS http://127.0.0.1:8787/api/snapshot
```

本地 snapshot 检查仍受 Collie 自己的鉴权配置约束。原版 Collie 的安装、配对和 provider 凭据不是本仓库管理范围。

### 2. 获取源码并检查

```bash
git clone https://github.com/toRolex/homeling.git
cd homeling
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
```

必须选择包含所需实现的 revision；未正式发布前不要假定默认分支等于 integration 开发进度。构建结果只在 `apps/web/dist`，不复制进 Collie。以下命令都在仓库根目录执行。

### 3. 初始化本机解锁状态、配置身份并安装 daemon

首次部署前，由**本机操作者**在仓库根目录执行以下显式初始化命令；这是文档示例，不代表本项目已经替你初始化或部署：

```bash
HOMELING_DATA_DIR="$HOME/Library/Application Support/Homeling" \
  bun apps/daemon/src/unlock-credentials-cli.ts init
```

解锁目录必须在所有版本控制工作区与 Collie 目录之外，归当前用户所有、无 symlink、权限 `0700`；`unlock-secret` 与 `unlock-verifier.json` 权限 `0600`。仅在本机私下读取 `unlock-secret` 并通过受信任的 Tailscale HTTPS 解锁界面输入；不要打印到共享终端、日志、聊天、仓库或浏览器持久化存储。daemon 不会自动生成、恢复或轮换解锁凭据。已有状态、部分初始化、损坏文件或 `.unlock-rotation-pending` 均应先由本机操作者检查，**不删除状态后重跑 init，不把 rotate 当修复命令**。

需要主动轮换且现有状态完整时，可由本机操作者使用同一 CLI 的 `rotate`，并使用与 daemon 完全一致的 `HOMELING_DATA_DIR`；旧会话在后续 admission / commit 检查时失效。自定义目录时，必须在实际 daemon/plist 环境中同步该路径；安装脚本不持久化 `HOMELING_DATA_DIR`，仅在 shell export 不会改变 launchd 的配置。使用上述默认目录则不需额外 plist 路径设置。

将示例替换为**实际 Tailscale 登录名**与本机完整 MagicDNS 域名（无 scheme、端口或尾斜线）。登录名不是机器昵称，也不是显示姓名；应与 Serve 注入的 `Tailscale-User-Login` 完全一致。多个用户用逗号分隔，且这些用户访问 bridge 时也须满足 Collie 自己的权限。

```bash
export HOMELING_TRUSTED_USERS='you@example.com'
export HOMELING_TAILSCALE_HOST='your-mac.tailxxxx.ts.net'
export HOMELING_PORT=8790
export HOMELING_PUBLIC_ORIGIN="https://${HOMELING_TAILSCALE_HOST}:8443"
bash scripts/install-launchd.sh
launchctl print "gui/$(id -u)/com.homeling.daemon"
curl -fsS http://127.0.0.1:8790/lite/api/health
```

正确安装入口是 `bash scripts/install-launchd.sh`，不是不存在的 workspace `install:launchd` script。脚本写入 `~/Library/LaunchAgents/com.homeling.daemon.plist`，记录 Bun 与 daemon entry 的绝对路径，配置 `RunAtLoad` / `KeepAlive`，日志位于 `~/.local/share/homeling/log/daemon.{out,err}.log`。不要用 `sudo` 安装此用户 agent。

**环境持久化边界**：安装脚本将 `HOMELING_PORT`、非空 `HOMELING_TRUSTED_USERS` 、`HOMELING_TAILSCALE_HOST` 和非空 `HOMELING_PUBLIC_ORIGIN` 写入 plist 的 `EnvironmentVariables`；后续 shell export 不会改变已运行的 agent。重装会覆盖整个 plist，不合并现有环境项，漏传身份配置会使远程访问 fail-closed。已有生产配置不得直接重跑 installer。获准部署时，只定向添加或更新既有 plist 的非秘密 `HOMELING_PUBLIC_ORIGIN` 项，保留 PUSH_SUBJECT、PUSH_DIR、DATA_DIR 等所有原项，再按批准流程重新加载。无法保证保留时停止部署。备份不要输出凭据。脚本不设置 WorkingDirectory，不依赖根目录 `.env`，也不自动持久化全部 shell 环境。

| 变量 | 默认 / 用途 | 安装脚本持久化 |
| --- | --- | --- |
| `HOMELING_PORT` | `8790`，daemon 始终绑定 loopback | 是 |
| `HOMELING_TRUSTED_USERS` | 空，拒绝远程用户；逗号分隔登录名 | 非空时 |
| `HOMELING_TAILSCALE_HOST` | 空，只允许本地 Host；填完整 DNS 名 | 非空时 |
| `HOMELING_PUBLIC_ORIGIN` | 未设置时由 Tailscale host 派生 HTTPS 443；本部署显式设置 `https://your-mac.tailxxxx.ts.net:8443` | 非空时 |
| `HOMELING_REPO` | 安装脚本所在仓库；可指定绝对路径 | 通过 daemon entry 路径体现 |
| `HOMELING_WEB_DIST` | 本仓库 `apps/web/dist` | 否，仅 daemon 环境支持 |
| `HOMELING_BRIDGE_ORIGIN` | `http://127.0.0.1:8787`，仅支持 loopback HTTP origin | 否，仅 daemon 环境支持 |
| `HOMELING_ALLOW_ANY_HOST` | 关闭；不要在部署时打开 | 否 |
| `HOMELING_PUSH_SUBJECT` | 独立 VAPID 联系地址，如 `mailto:you@example.com`；未设则关闭 Homeling push | 否，需明确配置 daemon/plist |
| `HOMELING_PUSH_DIR` | `~/Library/Application Support/Homeling/push`；独立 VAPID / 订阅 / 去重 / cursor，目录 0700、文件 0600 | 否，需明确配置 daemon/plist |
| `HOMELING_MEMORY_DIR` | `~/Library/Application Support/Homeling/memory`（或 `HOMELING_DATA_DIR/memory`），persona Markdown 与冻结会话文件；须为绝对路径、无 symlink、owner-only | 否，仅 daemon 环境支持 |
| `HOMELING_DATA_DIR` | `~/Library/Application Support/Homeling`；本机 unlock 状态目录，CLI 与 daemon 必须使用同一路径；不统一改动 registry / Activity / push 的默认路径 | 否，需明确配置 daemon/plist |
| `HOMELING_REGISTRY_PATH` | `~/.config/homeling/registry.json`；persona 持久 registry | 否，仅 daemon 环境支持 |
| `HOMELING_ACTIVITY_PATH` | registry 文件同目录的 `activity.json`；任务归属与可信 Activity 账本 | 否，仅 daemon 环境支持 |
| `HERDR_SOCKET_PATH` | `~/.config/herdr/herdr.sock`；已运行 herdr 的 Unix socket | 否，仅 daemon 环境支持 |
| `HOMELING_SESSION_DEV_HTTP` | 默认关闭；`1` 仅启用明确的 localhost HTTP 开发会话，不用于 Tailscale/生产 | 否，生产不要设置 |

推荐保持默认端口/产物/bridge 地址。非默认 `WEB_DIST` / `BRIDGE_ORIGIN` 需自行在 plist 中明确配置并重新加载，单纯 export 后运行安装脚本不生效。不要关闭 Host 检查来解决 403。

### 4. 添加独立 HTTPS 8443 入口

先确认 8443 未占用、tailnet 策略允许受控客户端访问该端口。保存固定 DNS:443 金丝雀基线，再仅新增 8443 listener。8443 的 `/` 代理到 `http://127.0.0.1:8790`，不设置 `/lite/` mount，也不在 target 附加 `/lite/`。完整请求路径必须透传。

```bash
export HOMELING_CANARY_STATE="$HOME/.local/share/homeling/canary-state.env"
export HOMELING_CANARY_SERVE_AUTHORITY="${HOMELING_TAILSCALE_HOST}:443"
bash scripts/canary.sh save
tailscale serve --bg --https=8443 http://127.0.0.1:8790
tailscale serve status --json
HOMELING_CANARY_DAEMON_URL=http://127.0.0.1:8790 bash scripts/canary.sh check
```

分别检查 `Web["DNS:443"].Handlers["/"].Proxy` 仍为 `http://127.0.0.1:8787`，以及 `Web["DNS:8443"].Handlers["/"].Proxy` 为 `http://127.0.0.1:8790`。canary 只保护保存的精确 443 key 与 proxy，不验证 8443 映射。443 key 缺失、切换或不可读均拒绝，不能用其他 listener 替代。旧基线缺 key 时须在确认受保护配置后重新 save。不要删除既有 443 `/lite/` handler。不要执行全局 Serve reset、覆写 `/` 或修改 `herdr.collie.plist`。如有自定义 Collie checkout，给 save/check 同时设置 `COLLIE_DIR`。保存基线前就须确认 Collie 干净、二进制存在、根 handler 正确：`save` 记录状态，**并不验证这些前置条件**。

入口为 `https://your-mac.tailxxxx.ts.net:8443/lite/`。先用自有受控浏览器 profile 保留 443 根 SW，复现旧入口后直达新入口。验证 Homeling UI、最终 URL、8443 `/lite/sw.js` controller 与 `/lite/` scope、深链和离线 shell，再回到 443 确认仍为 Collie。不得清除 Collie SW、缓存、订阅或数据。旧 443 主屏图标不会自动迁移。真实设备和通知验收另行安排，不把同机浏览器验证称作 iPhone 验证。缺失/非 trusted 身份应被拒绝；**本地 curl 成功不能代替通过真实 Tailscale 入口的身份验收**。daemon health 仅证明 daemon 活着，不代表 bridge / agent 可用。

显式 origin 只接受匹配 Tailscale hostname 的 HTTPS origin，无 userinfo、query、fragment 或非根 path。根尾斜线和默认 443 会规范化。session transport 要求 loopback peer、可信 login 与精确 authority；写 Origin 必须匹配 canonical origin。一般读取仍沿用既有 Host 策略，不宣称所有 reads 只接受 8443。同主机 cookie 跨端口共享，端口只隔离 origin 与 SW，不隔离 cookie。

验收前单独检查 8443 的 TLS、实际 Host 端口、Serve 身份和路径透传。对 SW、manifest、icons、bundle 核对状态、MIME 与构建内容，health 不得返回 SPA。受控客户端须验证 tailnet 可达性。同机 health 成功不能替代这些证据，不打开 Funnel 或放宽 ACL。

### 5. 重启与设备验收

```bash
launchctl kickstart -k "gui/$(id -u)/com.homeling.daemon"
HOMELING_CANARY_DAEMON_URL=http://127.0.0.1:8790 bash scripts/canary.sh check
```

daemon 启动可能需要片刻，若立即检查失败，先查 launchd / 日志，再重试。重启后手机再次打开 `/lite/`，刷新对话深链接，并检查根 UI。**canary 不会触发或证明重启**：它比较 Collie 工作区、二进制 mtime+SHA256、根 handler；设定可选 URL 后只多做一次 health 请求。它记录 Collie HEAD 但当前 `check` 不比较 HEAD。不要把它称作完整设备/通知回归。

手机走一轮“派活 → 审批 → 收结果”；确认发送正文进入 history 后才显示“已送达”（HTTP 2xx 不等于 agent 已消费）。中断按钮仅请求 Ctrl+C，不关闭 pane，不保证进程已终止，后续状态才是依据；launch 超时也不证明上游已回滚，残留需查看原始 pane / 旧 UI 排查。

PWA 可在手机浏览器添加到主屏；Service Worker 范围应仅为 `/lite/`。当前更新检测仅写 console，并提供调试入口 `window.__homelingApplyUpdate()`，**没有用户可见的更新提示或刷新按钮**。图标/安装/离线表现与根路径 SW 共存仍需实际设备验收；不宣称离线 agent 工作或真机锁屏 push / idle-lock 已验收。

### 6. 独立 Web Push（需人工锁屏验收）

在 daemon 的实际环境中设置 `HOMELING_PUSH_SUBJECT=mailto:you@example.com`（可选 `HOMELING_PUSH_DIR` 指向仓库外的 owner-only 目录），再重启。**安装脚本不会自动把这两个 shell export 写进 plist**，需自行补入 plist 的 `EnvironmentVariables` 并重新加载；重装覆盖 plist 时须保留该配置。首次启动自动生成独立 VAPID key pair，只向客户端公开公钥；勿打印/提交 `vapid.json` 或订阅 auth keys，也勿复用 Collie 私钥。备份时同时保存该目录的全部状态；丢失/替换 VAPID 后原订阅不能视为仍有效，应重新订阅。

手机打开 `/lite/settings`，解锁 Homeling 后点“允许并订阅”；iPhone/iPad 需先添加到主屏并从主屏打开。浏览器权限拒绝、SW 尚未就绪、daemon 未配置和业务锁 423 都有明确提示。测试通知也是用户业务写，锁定时不能发送；后台既定通知只使用 daemon 的窄 `push.deliver` capability，不续用户租约。仅支持已验证的 Apple / FCM / Mozilla push service endpoints，任意 URL 不可作为发送目的地。

通知先等待 debounce 窗口，快速自愈的阻塞不推；窗口内多个 persona 合并为一条，人数按 persona 去重而不是问题数。只有可观察的 resolved → pending 或完整身份替换才证明新请求代际；相同 pane、同内容审批若其间转换未被观察到，保守不推，可能漏通知，不宣称所有上游请求都能可靠识别。

人工验收：锁屏后让 **daemon 注册的 persona 主 pane / 持久归属 task** 出现真实审批，正文须含具体操作；点击应进入正确 persona 主聊或 task；重复轮询、daemon 重启不重复同一 occurrence；明确解决后同内容新请求、新的 task occurrence / registry 主 pane replacement 可再通知。任务完成/失败只消费 #13 持久可信 Activity，unknown / 断连不猜结果。上游未提供可验证的同 pane 进程 incarnation：断连期间的同 pane 重启保持保守 unknown，不保证识别成新实例，不使用 session 名或 history UUID 猜测。

发送前持久 claim 提供保守 at-most-once：claim 后崩溃/发送结果未知可能漏发，不是 exactly-once。`retract` 保证取消尚未派发的通知；resolve/replace 同次持久 commit 保存通知 tag 墓碑；`/lite/` 前台所有路由只读轮询墓碑并实际向 exact 同 origin `/lite/` SW 发送 `HOMELING_RETRACT`，按 tag 尝试本机关闭（离线/旧 worker 仅 best effort），不发送违反 `userVisibleOnly` 的静默撤回 push，不保证跨设备移除已显示通知。原 Collie 根 UI、SW、订阅、VAPID 与通知偏好完全不改。真机锁屏、点击、权限拒绝及新旧通知双通道仍为人工遗留。

## 已接线的交互与边界

- **Persona / 导航 / 定制**：只列 daemon registry 管理的伙伴，不收编旧 Collie space。可创建、打开主聊、改名与选择颜色/脸/宠物；删除会关闭该 persona 的主 pane（其中的 agent 随 pane 关闭），移除 registry 关系；关联 space 归档、task panes 保留，不会批量终止 task agent。动效依赖可观察运行状态，支持减弱动效，断连/未知不伪装 thinking。
- **对话 / 任务 / 审批**：显式发送，history 对账后确认送达；HTTP 成功不证明 agent 消费。任务使用既有 launcher allowlist，可看详情、工具 trace、只读终端镜像并发送后续指令。过期、归属不明或历史任务不能借详情入口执行当前 pane 控制；发送结果未知不自动重试。普通 pane/task 显式重发全文前先刷新 history、确认重复风险，排队执行前再核对；已明确输入的 partial 仅重试空文本提交。persona 的持久 unknown 仍由 daemon 拒绝重放，不能用二次确认绕过。
- **STT / 特殊键**：转写仅进入可编辑草稿，需显式发送。控制键仅提供实际协议支持的 Ctrl+C / Esc；Enter / Cmd 禁用。控制 accepted 不证明 TUI 已消费，预期 prompt 校验与上游派发也非原子操作。
- **Triage / Activity**：首页按需处理的 registry persona 计数，同一伙伴多个请求只计一次； scoped 链接保留请求/任务身份，锁定期间暂停读取后需重新核对。Activity 持久记录可信事件与明确 launch 边界，不把临时快照拼成历史；缺失退出码、断连或不可证实的进程实例保持 unknown，历史任务提供只读降级。
- **写锁**：空闲 15 分钟或会话绝对时长 8 小时后锁定；当前客户端使用服务端会话 admission，业务写携带从当前会话观察到的 epoch / generation 双头，缺失或旧代际拒绝写入，不能只凭新共享 cookie 恢复旧 tab 请求。读请求和后台通知不续用户租约，已运行 agent 不因锁定终止。手动锁定先在本地阻止操作，只有服务器返回 locked 才显示已确认；断网或服务器未锁时明确提示其他会话仍可能修改，保留本地 fail-closed，重新检查不会自动解锁。锁定保留本地界面/草稿，但旧请求、录音或未知写结果不在解锁后自动重放。仅保护 Homeling daemon 写入口，不保护 Collie 根 API、同 origin XSS 或同 UID 进程，也不撤回已派发操作；手机后台/焦点恢复与真实 HTTPS 解锁仍须人工验收。

## 语言设置

在 `/lite/` 底部「设置 → 语言」选择 English / Deutsch / Español / 한국어 / 日本語 / 简体中文。界面即时更新；选择保存在本浏览器的 Homeling 偏好中，刷新后保留，**不需要环境变量或重启 daemon**。禁用浏览器存储时，本页仍可切换，但刷新后无法保留。语言设置仅影响产品界面；伙伴名、用户草稿、agent 回复/问题、终端输出不自动翻译。缺失翻译先回退英语；所有语言都缺失的 key 原样显示，便于发现遗漏。本票交付上述六种语言；不包含上游后来增加的 `zh-TW` 完整资源。

已配置独立 push 且此浏览器已有登记订阅时，显式切换语言只同步该订阅的语言元数据：不申请通知权限、不重新订阅、不启用通知、不生成或重发旧通知。锁定或请求结果不明时，本地界面仍切换并保留选择，显示“通知语言未同步”；**解锁不自动重放，须点「同步通知语言」显式重试**。后续新通知的系统前缀按设备语言生成，原伙伴名/问题/任务摘要保持原文；已显示通知不因语言切换重写。

## Persona 记忆（#12）

- 每个 persona 持久化 `facts.md`、`preferences.md`、`project.md`；纯 UTF-8 Markdown，单文件最多 24,000 字节。编辑器显式保存，使用 revision 防止不同页面互相覆盖；冲突须手动重新加载，锁拒绝保留草稿，不会解锁后自动重放。保存结果未知时先重新加载核对。
- **只在下一次会话启动 / 首条消息时生效**。当前运行 pane 不会热吸收编辑内容；daemon 重启但仍使用同一个 pane 也不是新会话。不要为了生效直接结束正在执行的任务。
- 支持明确的全新交互式 `pi` launcher（可含 `--model`、`--provider` 的简单参数）；daemon 在 Homeling 数据目录生成冻结的 `session-*.md`，追加官方 `--append-system-prompt '<绝对文件路径>'`。不改 pi 配置、项目 AGENTS 文件或 Collie 文件。launcher 必须先在既有 allowlist 中配置；Homeling 只扩展已选行的记忆启动参数，不接受任意新命令。
- 其余 kind、复杂 shell wrapper 或 resume launcher 明示 **unsupported native injection**，将冻结记忆作为首条用户消息前缀降级；不是等价的 system prompt。精确注入全文仍用于 history 送达对账，不以 HTTP 成功宣称 agent 已消费。上游未提供可信 session/entry/attempt 绑定：展示证据保持 unbound，history 原文（含注入前缀）保守保留；不按前缀、同文唯一性、时间或本地 UUID 猜测隐藏，也不宣称已完成持久注入展示闭环。
- 原始文档与冻结文件可能含个人信息，请勿放入仓库或日志；目录 0700、文件 0600。文件损坏/非法 UTF-8/symlink/过宽权限拒绝读写，不静默替换为空。遗留 `.write-lock` 不自动抢占；确认 daemon 全部停止且没有在途写操作后由本机操作者处理。冻结文件保留供仍运行的 pi 使用，只有确认对应会话退出后才可人工清理。
- **人工遗留**：手机进入 persona 的 Memory，编辑并保存；在已配置的真实 pi 新会话询问记忆中的事实，确认可引用；再修改并证明旧 pane 不变、新会话读取新内容；其他 kind 检查降级提示。自动测试仅用 fake Herdr/bridge 和临时文件，未运行真实 pi、未操作 Collie/秘密/服务。

## 更新与卸载

更新源码应使用你自己的版本控制流程，保留本地修改；此票不执行 push / 合入 / 正式发布。源码路径不变时，按下列流程构建并重启。Bun 安装位置或仓库路径改变时，先审查并保留既有 plist 全部环境项，定向更新绝对路径，不直接重跑覆盖式 installer。

```bash
bash scripts/canary.sh save
bash scripts/build-web.sh
launchctl kickstart -k "gui/$(id -u)/com.homeling.daemon"
HOMELING_CANARY_DAEMON_URL=http://127.0.0.1:8790 bash scripts/canary.sh check
```

`build-web.sh` 冻结安装依赖并构建 web，只写本仓库。更新后手动刷新并核对版本；若新 SW 仍处于 waiting，普通刷新未必切换版本，当前需通过浏览器调试入口调用 `window.__homelingApplyUpdate()`，再验证页面更新。排障时可仅清理 `/lite/` 的缓存/SW，不注销 Collie 根 SW。更新前后金丝雀命令使用同一 `HOMELING_CANARY_STATE`。

回退只撤新增 8443 listener，并恢复 Homeling 原配置和版本。原基线的错误 UI 是已知缺陷，回退不代表恢复可用。卸载只删自己的 listener 与 user agent，不动 Collie，也不终止已有 herdr panes：

```bash
bash scripts/canary.sh save
tailscale serve --https=8443 off
launchctl bootout "gui/$(id -u)/com.homeling.daemon"
rm "$HOME/Library/LaunchAgents/com.homeling.daemon.plist"
bash scripts/canary.sh check
```

agent 若已停止，bootout 可能提示找不到服务，先确认状态。日志与 canary 基线在 `~/.local/share/homeling`，默认保留；备份后可自行删除。源码与 `apps/web/dist` 可自行移除，不需要恢复 Collie 文件。

## 开发与 CI

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
```

[CI](../.github/workflows/ci.yml) 在 Linux 上执行这四项，覆盖仓库现有各票测试，包括部署 README 命令一致性与隔离的 installer smoke。CI 不会访问真实 Collie、修改 Tailscale、运行 macOS launchd 或验证手机通知，因此“CI 全绿”不替代真机验收，也不证明待实现票已完成。

本地调试入口：

```bash
bun run dev:daemon
# 另一个终端
bun run dev:web
```

Vite 当前开发代理直连 bridge，是开发便利入口，**不是 daemon 鉴权/部署的等价验收路径**。要验证真实部署边界，请构建后使用 daemon `/lite/`，经 Tailscale 访问，不要把 Vite 端口暴露给手机当正式部署。

## Zero-touch 与安全

- 不写 `~/.local/share/collie/`，不改 bridge，不重编译 `bin/collie`；无 patch / rsync 部署路线。安装只写 Homeling plist 与日志目录，构建只写本仓库产物。
- Tailscale 共享配置仅增删独立 8443 listener；443 所有 handler、旧 UI、旧通知配置保持原样。历史 ADR 的同 origin 路径假设不用于本部署，不在此改写 ADR。未来 Homeling push 也须独立于 Collie 通道，不能代用户静音旧通知。
- daemon 仅监听 loopback；远程请求必须有可信登录身份和配置的 Host。直连 loopback 的健康检查允许本机访问，是有意的本地信任边界，不是未鉴权远程入口。
- 写请求受 Origin / JSON body 门禁和窄路由限制；不要扩大反代到任意 `/api/*`，不要以公网反代或 Funnel 替代 tailnet。
- `.env` / `.env.*`（示例除外）、日志、产物被忽略；不要提交 provider token、tailnet 密钥、真实 transcript 或 push 私钥。忽略规则不能清除已提交秘密；检查差异与历史，发现泄漏应先轮换凭据再处理历史。
- 本项目安装脚本与 canary 不收集/上传凭据。业务流复用 Collie / agent API，模型请求与内容处理仍遵循所选 provider 的政策。

## 常见问题

| 表现 | 优先检查 |
| --- | --- |
| `/lite/` 401 | trusted-user 是否为真实登录名；Tailscale 是否注入身份；重装时是否漏传配置 |
| `/lite/` 403 | plist 中 DNS 名是否正确；请求 Host / Origin 是否匹配；不要打开 allow-any-host |
| 静态页面 404 / 空白 | `bun run build` 是否成功，`apps/web/dist/index.html` 是否存在 |
| 页面可用但对话 502 | bridge 是否在线，loopback 8787 是否可访问，Collie 自身鉴权是否允许该用户 |
| launch 被拒绝 | launcher command 是否与 allowlist 精确一致，agent 及其凭据是否已配置 |
| launchd 起不来 | `launchctl print`、daemon.err.log；plist 的绝对 Bun / repo 路径是否仍有效 |
| canary 失败 | 停止继续部署；查清 Collie 工作区/二进制/根 handler 变化，不自动 reset 或清理 Collie |

## 许可证

[MIT](../LICENSE)
