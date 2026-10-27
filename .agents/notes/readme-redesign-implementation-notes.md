# README 首页改版

## 状态
- README 重写与部署文档拆分：done；README.md、docs/deployment.md，保留命令索引；本地链接与文档测试通过。
- 产品截图：done；assets/screenshots/ 三张来自既有隔离 UI QA 的截图，已逐张检查，仅模拟伙伴和审批，无私人路径/身份/对话。
- 成熟项目参考：done；scout 返回 LobeHub 和 Open WebUI 的首屏定位、截图、短开发入口与文档分流结构，已用于新版首页。
- 链接与部署文档测试：done；两个 Markdown 文件本地链接无缺失，bun test scripts/deployment-docs.test.ts 为 5 pass / 0 fail、64 assertions。

## 决策与因果
- 用户要求美观、清晰、有截图，并使用 unslop；采用居中简介、两个实用 badge、三列截图、功能表与精简开发入口，详细原说明迁移到 docs/deployment.md。
- 用户进一步要求去除防御性语言：许可证仅保留 MIT 链接，预览状态与未完成能力集中说明，删除重复免责补充；实际部署的凭据和数据安全操作规则仍保留。
- 不使用 assets/dots-* 的外部参考界面冒充产品。截图来自 Homeling 自身 UI，明确标注模拟数据。
- 独立 workspace 基于已合并 main dc22b8f6，原工作区 WIP 不动。本次未获推送/发布请求，仅本地改版。

## 参考
- https://github.com/lobehub/lobehub/blob/main/README.md
- https://github.com/open-webui/open-webui/blob/main/README.md

## Deviations
- 无。
