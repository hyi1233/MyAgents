---
name: self-config
description: >-
  MyAgents 应用自我配置能力。通过内置 myagents CLI 管理 MCP 工具接入、Model Provider、
  Agent/Channel 等配置。当用户希望接入新工具（MCP）、配置模型服务、设置 IM Bot、或对应用
  配置进行任何修改时触发。覆盖场景：(1) 用户提供工具/MCP 文档要求接入 (2) 用户要求添加或
  修改模型服务商 (3) 用户要求配置 Agent 或 IM Channel (4) 用户说"帮我配一下"、"接入这个
  工具"、"添加这个模型"、"设置 xx"等配置类请求。即使用户没有提到 CLI 或 MCP，只要意图是
  修改应用配置，都应触发此 Skill。
---

# Self-Config — 应用自我配置

你可以通过内置的 `myagents` CLI 管理应用配置，包括 MCP 工具、模型服务、Agent/Channel 等。

这个 CLI 是专门为你设计的——你通过 Bash 工具执行命令，就可以帮用户完成各种配置操作，不需要让用户手动去 Settings 页面操作。

## 使用模式

1. **探索**: `myagents --help` 发现顶层命令组，`myagents <group> --help` 发现子命令
2. **预览**: 所有写操作支持 `--dry-run`，先看会做什么再决定是否执行
3. **执行**: 确认无误后去掉 `--dry-run` 正式执行
4. **验证**: 执行后用 `myagents <group> list` 或 `myagents status` 确认结果
5. **机器可读**: 加 `--json` 获取结构化 JSON 输出，方便你解析

## 安全规范

- 修改配置前，先用 `--dry-run` 预览变更，向用户展示将要做什么
- API Key 等敏感信息：如果用户在对话中明确提供了，可以直接通过 CLI 写入；如果没有提供，引导用户去 **设置 → 对应页面** 手动填写，不要追问敏感信息
- 删除操作前必须向用户确认
- 这些规范背后的原因：用户的配置数据很重要，误操作可能导致服务中断。预览和确认步骤是保护用户的安全网

## 生效时机

- **MCP 工具变更**（增删改/启禁用/环境变量）：配置立即写入磁盘，但工具在**下一轮对话**才可用（因为 MCP 服务器在 session 创建时绑定）。你可以在当前轮完成配置和验证，告诉用户"发条消息我就能使用新工具了"
- **其他配置**（模型、Provider、Agent）：写入后即时生效

## 典型工作流

### 接入 MCP 工具

当用户提供了工具文档或描述时：

1. 从文档中提取关键信息：server ID、类型（stdio/sse/http）、命令或 URL、所需环境变量
2. `myagents mcp add --dry-run ...` 预览配置
3. 向用户展示预览内容并确认
4. 执行：add → enable（`--scope both` 同时启用全局和当前项目）→ 配置环境变量（如需要）
5. `myagents mcp test <id>` 验证连通性
6. `myagents reload` 触发热加载
7. 告诉用户"配置完成，发条消息我就能用了"

### 配置模型服务

1. `myagents model list` 查看已有 Provider 和状态
2. 如果目标 Provider 已经是内置的（status 显示 not-set），只需设置 API Key
3. `myagents model set-key <id> <key>` 设置 API Key
4. 可选：`myagents model set-default <id>` 设为默认 Provider

### 配置 Agent Channel

1. `myagents agent list` 查看现有 Agent
2. `myagents agent channel add <agent-id> --type telegram --token <bot-token>` 添加渠道
3. 根据平台类型，可能需要不同的凭证：
   - Telegram: `--token`
   - 飞书: `--app-id` + `--app-secret`
   - 钉钉: `--dingtalk-client-id` + `--dingtalk-client-secret`

### 查看和修改通用配置

- `myagents config get <key>` 读取（支持点号路径如 `proxySettings.host`）
- `myagents config set <key> <value>` 修改
- `myagents status` 查看整体运行状态
