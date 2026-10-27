<div align="center">

# Homeling

住在自己电脑上的 AI 伙伴。

在手机上对话、派任务、处理审批，查看伙伴正在做什么。

[![CI](https://github.com/toRolex/homeling/actions/workflows/ci.yml/badge.svg)](https://github.com/toRolex/homeling/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[界面预览](#界面预览) · [开始开发](#开始开发) · [部署文档](docs/deployment.md) · [开发进度](https://github.com/toRolex/homeling/issues/1)

</div>

> 当前为开发预览版。真实 agent 工作流程与手机通知仍在完善，进度见 [Spec #1](https://github.com/toRolex/homeling/issues/1)。

## 界面预览

伙伴首页、对话与任务审批。截图使用模拟数据。

<table>
  <tr>
    <th>你的伙伴</th>
    <th>对话与快捷回复</th>
    <th>处理审批</th>
  </tr>
  <tr>
    <td><img src="assets/screenshots/companions.png" alt="伙伴首页显示待处理请求与伙伴状态，使用模拟数据" width="260"></td>
    <td><img src="assets/screenshots/conversation.png" alt="伙伴对话页包含消息、快捷回复与输入框，使用模拟数据" width="260"></td>
    <td><img src="assets/screenshots/approval.png" alt="任务页显示模拟审批卡片及允许和拒绝按钮" width="260"></td>
  </tr>
</table>

## Homeling 做什么

Homeling 是 Dots / Grok Bot / Muse 这类 persona agent 的开源实现。每个伙伴有自己的对话、记忆和任务。移动界面把消息、审批和运行状态放在一起，方便离开电脑时查看。

| 界面与功能 | 已有实现 |
| --- | --- |
| 伙伴 | 创建与导航、头像定制、运行状态、待处理请求汇总 |
| 对话 | 消息流、快捷回复、送达对账、权限请求卡片 |
| 任务 | 派任务入口、任务详情、工具 trace、只读终端镜像 |
| 记忆 | Markdown 编辑、版本冲突检查、会话启动时注入 |
| 日常使用 | Activity、六语言界面、服务端 idle-lock |
| 手机访问 | PWA、独立 Web Push、通知去重与合并 |

各功能的使用说明见[部署文档](docs/deployment.md)。

### 仍在开发

- 任务启动结果的持久记录与超时后的清理确认。
- 控制键接收端的原子校验及 Cmd 语义。
- 记忆注入与真实 pi history 的精确对应。
- 通知请求代际与断连后的事件恢复。
- Homeling 自持 runtime/history 路径。

真实 pi、STT、手机 HTTPS、PWA 安装与锁屏通知待验收。剩余工作在 [Issues](https://github.com/toRolex/homeling/issues) 中跟踪。

## 开始开发

安装 Bun 后，在仓库根目录执行：

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
```

本地开发使用两个终端：

```bash
bun run dev:daemon
```

```bash
bun run dev:web
```

开发界面需要配置后端，Vite 的开发代理直连 bridge。手机部署使用 daemon 的 `/lite/` 入口。

### 自部署前先阅读

现有部署使用 macOS、Bun、Collie / Herdr 和 Tailscale HTTPS。Homeling 自持 runtime 正在开发。

[部署文档](docs/deployment.md)包含前置检查、身份配置、安装、更新与排障。下面列出常用命令，按文档中的步骤使用。

<details>
<summary>部署命令索引</summary>

安装与构建：

```bash
bash scripts/install-launchd.sh
bash scripts/build-web.sh
```

检查安装不变量：

```bash
bash scripts/canary.sh save
bash scripts/canary.sh check
```

仅添加或移除 Homeling 的路径，保留现有根 handler：

```bash
tailscale serve --bg --https=443 --set-path=/lite/ 8790
tailscale serve --https=443 --set-path=/lite/ off
```

</details>

## 架构

现有实现使用 Bun + TypeScript daemon 托管 React / Vite 前端。daemon 自持 registry、记忆、Activity、鉴权和通知，并通过窄路由访问本机 legacy Collie bridge。Herdr 管理运行中的 agent panes。

```text
手机浏览器
  │ Tailscale HTTPS
  ├─ /       → 现有 Collie bridge :8787
  └─ /lite/  → Homeling daemon :8790
                 ├─ React 前端
                 ├─ registry / memory / Activity / push
                 └─ legacy bridge → Herdr agent panes
```

Homeling 独立安装，保留现有 Collie。daemon 只监听 loopback，通过 Tailscale 身份与 Host / Origin 检查控制远程访问。对话内容会发送给所选模型 provider。

## 文档与贡献

- [部署与使用](docs/deployment.md)：环境配置、功能限制和排障。
- [产品需求](PRD.md)：v1 的功能与验收要求。
- [领域术语](GLOSSARY.md)与[架构决策](docs/adr/)：实体和设计约束。
- [Issues](https://github.com/toRolex/homeling/issues)：剩余实现、验收与问题反馈。

开发前先读对应工单，修改后运行类型检查、测试和构建。截图请使用模拟数据，不提交真实对话、凭据、tailnet 信息或 push 私钥。

## 许可证

[MIT](LICENSE)

## 人机协作方法与代码位置

本部分属于**中山大学高级人工智能课程项目 Homeling**。第三章提出的算法融入现有 daemon、Activity 任务记录、请求接口和移动端卡片，代码按框架职责组织。

| 方法部分 | 框架中的实现位置 | 实际用途 |
| --- | --- | --- |
| 3.1 总体框架 | [task-plan.ts](apps/daemon/src/task-plan.ts)、[activity-ledger.ts](apps/daemon/src/activity-ledger.ts) | 阶段 DAG、依赖校验和影响传播；协作计划与任务运行实例一起持久化，复用 Activity 的串行提交与原子写入 |
| 3.2 等待成本 | [clarification-value.ts](apps/daemon/src/clarification-value.ts)、[task-cooperation.ts](apps/daemon/src/task-cooperation.ts) | 计算最小预期损失、回答信息价值及有效停顿成本；根据当前可执行序列估计 W，再更新问题分数 |
| 3.3 介入请求 / 算法1 | [task-cooperation.ts](apps/daemon/src/task-cooperation.ts)、[task-cooperation-routes.ts](apps/daemon/src/task-cooperation-routes.ts)、[index.ts](apps/daemon/src/index.ts) | 问题去重与可回答性检查、预算控制、必需信息兜底；将澄清/审批合并到已有请求列表，并通过现有 pane reply 通道派发独立阶段 |
| 移动端请求展示 | [PendingRequestCard.tsx](apps/web/src/PendingRequestCard.tsx)、[ConversationPage.tsx](apps/web/src/ConversationPage.tsx)、[requests.ts](packages/contracts/src/requests.ts) | 复用请求卡片展示进展、选项后果与审批范围，支持澄清自由文本和折叠详情 |
| 3.4 反馈与恢复 | [task-feedback.ts](apps/daemon/src/task-feedback.ts)、[task-cooperation.ts](apps/daemon/src/task-cooperation.ts)、[requests.ts](apps/daemon/src/requests.ts) | 校验任务/请求标识与相关要求版本；审批绑定具体操作；纠错使受影响步骤、许可及旧检查失效；未知结果先核查再恢复 |
| 3.5 完成判定 | [task-validation.ts](apps/daemon/src/task-validation.ts)、[activity-ledger.ts](apps/daemon/src/activity-ledger.ts) | 检查绑定要求版本、证据位置和产物版本；阶段检查通过后才能推进；协作任务需必需项目全部通过，且观察到 agent 完成，才登记 `task.completed` |

### 任务流程

结构化协作任务使用现有 `occurrenceKey` 作为 `runId`。在活动任务上提交阶段、问题模型、执行指令及验收项目后，daemon 计算待问问题并尝试派发一个满足条件的阶段。需要用户决定的步骤等待，独立且已获授权的阶段继续执行。用户从原有手机请求卡片回答后，daemon 保存回答、重新调度并尝试推进下一步。

阶段指令通过现有 bridge 的文本回复接口交给底层智能体，不直接执行 shell 字符串。每次派发都检查当前任务绑定、会话许可、取消屏障和 agent 空闲状态，并先持久登记阶段正在执行；发送结果不明时保留待核查状态。不会把整份旧计划一次性执行。

### 协作接口

以下路径均位于现有 daemon 的鉴权与会话控制之后；写请求使用 JSON，要求有效的解锁会话与 Origin。

| 接口 | 用途 |
| --- | --- |
| `GET /lite/api/activity/task/:occurrenceKey/cooperation` | 读取计划、版本、评分、可执行步骤与验收结果；历史任务只读 |
| `POST /lite/api/activity/task/:occurrenceKey/cooperation` | 为当前任务配置协作计划，并尝试派发独立步骤 |
| `PATCH /lite/api/activity/task/:occurrenceKey/cooperation` | 上报阶段结果/检查证据、用户纠错、更新操作范围或核查未知结果，然后重新规划 |
| `POST /lite/api/activity/task/:occurrenceKey/cooperation/advance` | 使用 `{}` 触发一次当前可执行阶段的派发；agent 忙碌时返回等待原因 |
| `GET /lite/api/requests` | 原生请求与协作请求共用的手机待办列表 |
| `POST /lite/api/requests/:requestId/approve` | 原有选项回答接口；协作澄清可额外提交 `freeText`，`occurrenceKey` 用于核对任务运行实例 |

配置体对应 `CooperationState` 的输入字段：`task`、`instructions`、`questions`、`checkItems`、`budget`、`delayPenaltyPerMs`。`revision`、请求、评分和检查记录由服务端生成。`task.steps` 的初始状态为 `pending`；每步声明阶段依赖、要求、待决问题、资源、预计耗时及已有授权，`instructions` 用步骤 ID 映射执行指令。

问题模型采用可序列化的损失表 `losses[action][theta]`，以及先验 `belief`、回答概率/后验 `answers`、用户成本 `humanCost` 和回复时延分布 `delay`。回答的 `consequence` 直接显示为选项，`progress` 显示进展，`details` 放入折叠区域。每个未决要求只对应一个合并后的问题。审批另需 `operation`，明确 `target`、`modification`、`impact` 和 `artifactVersion`，并提供 `approve` / `deny` 选项。

PATCH 请求携带读取到的 `revision`，支持以下操作：

- `step-result`：提交 `stepId`、`status`（`done` / `unknown`）、`artifactVersion`、`evidenceLocation`。
- `check`：提交 `checkId`、`status`（`passed` / `failed` / `unknown`）、`evidenceLocation`；未知状态同时注明 `missingEvidence`。
- `correction`：通过 `changes` 提交要求 ID 到新内容的映射，传播重做范围并撤销旧请求。
- `revise-operation`：提交 `questionId`、新的 `operation` 和受影响步骤的 `instructions`，重新生成审批，旧许可不再沿用。
- `reconcile`：提交 `stepId`、`evidence`（`completed` / `not-executed` / `insufficient`）和 `evidenceLocation`；证据不足时保持待核查。
- `retry-step`：提交验收失败的 `stepId`，使其与下游步骤重新准备并撤销旧授权。
- `authorize`：显式更新普通阶段的 `stepId`、`authorized`；有待决审批的阶段必须通过对应审批请求。

### 模型与执行边界

损失尺度、概率及候选方案由任务模板或上层智能体提供；daemon 负责验证、计算与调度，不从终端文字臆造这些值。环境可查询的信息先由底层工具处理，协作问题要求 `environmentResolvable: false`；工具证据通过阶段结果和检查报告进入任务记录。检查器负责实际核对字段、文件可读性与要求覆盖，控制器据证据及版本决定能否推进和交付。

未配置阶段计划的普通任务继续使用已有原生请求和 Activity 流程。结构化计划通过上述接口进入实际运行链路；自然语言自动生成计划及概率估计属于上层智能体的职责。观察链路断开后沿用既有 Activity 的历史任务保护规则，不将旧运行实例的许可自动转移到新实例。
