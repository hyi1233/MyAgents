# 飞书官方 OpenClaw 插件接入 — 替代原生实现 + CardKit Streaming + 工具桥接

> **Version**: 0.1.42
> **Date**: 2026-03-15
> **Status**: Draft
> **Author**: Ethan + Claude
> **前置研究**: [feishu_integration_research.md](../research/feishu_integration_research.md), [feishu_bot_doc.md](../research/feishu_bot_doc.md), [research_openclaw_channel_plugin.md](../research/research_openclaw_channel_plugin.md)
> **官方插件仓库**: https://github.com/larksuite/openclaw-lark
> **官方插件 npm**: `@larksuite/openclaw-lark` (v2026.3.15)

---

## 1. 背景

### 1.1 现状

MyAgents 当前有两套飞书 Bot 方案：

| 方案 | 状态 | 优势 | 劣势 |
|------|------|------|------|
| **原生 Rust 实现** (`feishu.rs` 2296 行) | 生产可用 | 深度集成 MyAgents 权限体系、流式 draft、去重持久化 | 仅消息收发，无飞书业务能力（文档/表格/日历），维护成本高 |
| **OpenClaw Plugin Bridge** | QQBot 已跑通 | 生态扩展、插件隔离、社区维护 | 当前不支持 CardKit Streaming、不桥接插件工具 |

飞书官方已发布 OpenClaw 插件 `@larksuite/openclaw-lark`（MIT 许可，904 stars），提供：
- 消息收发（WebSocket 长连接，全消息类型）
- **CardKit Streaming**（流式卡片 + thinking panel + 状态展示）
- **9 个 Skills + 50 个 OAPI Tools**（文档/多维表格/电子表格/日历/任务/Wiki/Drive）
- OAuth Device Flow（以用户身份操作飞书资源）
- 多账号、话题会话、诊断命令

### 1.2 目标

用官方插件**逐步替代**原生 Rust 实现，一次性交付完整版本：

1. **Plugin Bridge 接入** — 官方插件作为 promoted plugin，消息流复用 QQBot 路径
2. **CardKit Streaming** — 扩展 Bridge 协议，支持插件控制流式输出（卡片流式 + thinking panel）
3. **工具桥接** — 将插件的 50 个飞书工具注入 AI Sidecar，按组可选
4. **双入口过渡** — 新入口标"官方"，旧入口标"即将下线"
5. **权限体系** — 飞书 Bot 使用插件自带的 dmPolicy/groupPolicy，不叠加 MyAgents 审批卡片

### 1.3 不做的

- 原生飞书实现的移除（本版本仅标记 deprecated，后续版本删除）
- 飞书 OAuth 授权的完整 UI 管理（本版本依赖插件内置的 `/feishu auth` 命令）
- 插件的 Skills 映射到 MyAgents Skill 体系（仅桥接 Tools）
- 插件的 CLI 命令（`feishu-diagnose` 等）在 MyAgents 中的 UI 封装

---

## 2. Bun 兼容性验证（已完成）

| 测试项 | 结果 |
|--------|------|
| `bun add @larksuite/openclaw-lark` | ✅ 安装成功，56 packages / 76MB |
| `@larksuiteoapi/node-sdk` Client 实例化 | ✅ 9 个 API 命名空间可用 |
| `WSClient` WebSocket 客户端 | ✅ 加载正常 |
| protobufjs encode/decode roundtrip | ✅ 二进制帧解析正确 |
| node:crypto (HMAC-SHA256, AES-256-CBC) | ✅ 兼容 |
| node:fs/path/os/url/stream/net/dns | ✅ 全部兼容 |
| `image-size` (Buffer 模式) | ✅ 兼容（文件路径模式有 Bun bug 但插件不使用） |
| 无原生 addon (.node / binding.gyp) | ✅ 纯 JS |

**结论**：`@larksuite/openclaw-lark` 在 Bun 1.3.6 下完全兼容，无阻塞问题。

---

## 3. 需求规格

### 3.1 UI：双入口 + Badge

**BotPlatformRegistry** 展示两个飞书入口：

```
┌─────────────────────────────────────────────────────┐
│ [feishu.jpeg]  飞书 Bot（官方插件）        [官方]    │
│                飞书开放平台官方 OpenClaw 插件         │
│                支持文档/表格/日历等深度集成           │
│                                    [点击安装] / [配置] │
├─────────────────────────────────────────────────────┤
│ [feishu.jpeg]  飞书 Bot（内置）        [即将下线]    │
│                通过飞书自建应用 Bot 远程使用 AI Agent │
│                ⚠️ 推荐迁移到官方插件版本              │
│                                             [配置]   │
└─────────────────────────────────────────────────────┘
```

**Badge 样式**：
- `[官方]`：飞书品牌蓝 `#3370FF`，实心圆角标签
- `[即将下线]`：灰色 `var(--ink-faint)`，虚线边框

**交互**：
- 官方插件放在内置之前（视觉优先级更高）
- 已配置内置飞书的用户，在内置卡片上显示迁移提示

### 3.2 配置引导

复用现有飞书配置步骤图（`feishu_step1~4.png`），**promotedPlugins** 新增条目：

| 字段 | 值 |
|------|-----|
| `pluginId` | `'openclaw-lark'` |
| `npmSpec` | `'@larksuite/openclaw-lark'` |
| `name` | `'飞书 Bot（官方插件）'` |
| `description` | `'飞书开放平台官方 OpenClaw 插件，支持文档/表格/日历等深度集成'` |
| `badge` | `'official'` |
| `platformColor` | `'#3370FF'` |
| `setupGuide.credentialTitle` | `'飞书应用凭证'` |
| `setupGuide.credentialHint` | `'前往飞书开放平台创建自建应用，获取 App ID 和 App Secret'` |
| `setupGuide.credentialHintLink` | `'https://open.feishu.cn/app'` |
| `setupGuide.steps` | 4 步引导图（复用现有 feishu_step1~4.png） |

**插件 Config 表单字段**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `appId` | string | ✅ | 飞书应用 App ID |
| `appSecret` | password | ✅ | 飞书应用 App Secret |
| `domain` | select | 否 | `feishu`（默认）/ `lark` / 自定义 URL |
| `connectionMode` | select | 否 | `websocket`（默认）/ `webhook` |
| `streaming` | toggle | 否 | 启用 CardKit 流式输出（默认 true） |
| `requireMention` | toggle | 否 | 群内需 @机器人才回复（默认 true） |
| `dmPolicy` | select | 否 | `open` / `pairing` / `allowlist` / `disabled` |
| `groupPolicy` | select | 否 | `open` / `allowlist` / `disabled` |

### 3.3 消息收发（基础通路）

复用 QQBot 的 Bridge 路径：

```
飞书用户发消息
    ↓ WebSocket (plugin gateway)
Plugin Bridge (Bun 进程)
    ↓ POST /api/im-bridge/message
Rust Management API
    ↓ mpsc channel
IM Processing Loop → AI Sidecar
    ↓ SSE stream
Rust stream_to_im()
    ↓ /start-stream, /stream-chunk, /finalize-stream (新协议)
Plugin Bridge
    ↓ StreamingCardController / sendText
飞书用户收到回复
```

**验收标准**：
- 私聊消息可正常收发
- 群聊消息（@机器人）可正常收发
- 图片/文件附件可下载并传给 AI
- AI 回复支持文本和 CardKit 流式卡片

### 3.4 CardKit Streaming（核心新能力）

#### 3.4.1 Bridge 协议扩展

新增三个端点 + 一个中止端点：

```
POST /start-stream
  Request:  { chatId: string, initialContent?: string, streamMode: "text"|"cardkit" }
  Response: { ok: boolean, streamId: string }

POST /stream-chunk
  Request:  { streamId: string, content: string, sequence: number, isThinking?: boolean }
  Response: { ok: boolean }

POST /finalize-stream
  Request:  { streamId: string, finalContent: string }
  Response: { ok: boolean }

POST /abort-stream
  Request:  { streamId: string }
  Response: { ok: boolean }
```

#### 3.4.2 `/capabilities` 扩展

```json
{
  "pluginId": "openclaw-lark",
  "textChunkLimit": 4096,
  "capabilities": {
    "streaming": true,
    "streamingCardKit": true,
    "edit": true,
    "delete": true,
    "sendMedia": true
  }
}
```

#### 3.4.3 Rust `ImStreamAdapter` trait 扩展

```rust
// 新增方法（带默认实现，不影响现有 adapter）
async fn start_stream(
    &self, chat_id: &str, initial: &str
) -> AdapterResult<String> {
    // 默认 fallback: send_message_returning_id
    self.send_message_returning_id(chat_id, initial).await
        .map(|id| id.unwrap_or_default())
}

async fn stream_chunk(
    &self, stream_id: &str, text: &str, seq: u32, is_thinking: bool
) -> AdapterResult<()> {
    // 默认 fallback: edit_message
    self.edit_message("", stream_id, text).await
}

async fn finalize_stream(
    &self, stream_id: &str, final_text: &str
) -> AdapterResult<()> {
    // 默认 fallback: edit_message
    self.edit_message("", stream_id, final_text).await
}

async fn abort_stream(&self, stream_id: &str) -> AdapterResult<()> {
    Ok(()) // 默认无操作
}

fn supports_streaming(&self) -> bool { false }
```

#### 3.4.4 `stream_to_im()` 分叉

```rust
// mod.rs
async fn stream_to_im(adapter: &dyn ImStreamAdapter, ...) {
    if adapter.supports_streaming() {
        stream_to_im_streaming(adapter, chat_id, sse_stream).await
    } else {
        stream_to_im_edit(adapter, chat_id, sse_stream).await  // 现有逻辑
    }
}
```

新 `stream_to_im_streaming()` 状态机：

```
[idle] ──first partial──→ [streaming]
                              │
                    ├─ partial → stream_chunk(seq++)
                    ├─ thinking → stream_chunk(is_thinking=true)
                    ├─ block-end → finalize_stream()
                    ├─ error → abort_stream()
                    └─ complete → (结束)
```

#### 3.4.5 Bridge 端实现

Plugin Bridge 内部管理 `FeishuStreamingSession` 生命周期：

```typescript
// plugin-bridge/index.ts 新增
const activeStreams = new Map<string, {
  session: FeishuStreamingSession,  // 插件的 streaming 控制器
  chatId: string,
  sequence: number,
}>();

server.post('/start-stream', async (req) => {
  const { chatId, initialContent, streamMode } = await req.json();
  const streamId = crypto.randomUUID();

  if (streamMode === 'cardkit' && pluginSupportsStreaming) {
    // 使用插件的 FeishuStreamingSession
    const session = new FeishuStreamingSession(larkClient, creds);
    await session.start(chatId, 'chat_id', { initialContent });
    activeStreams.set(streamId, { session, chatId, sequence: 0 });
  } else {
    // fallback: 普通消息
    const result = await capturedPlugin.sendText(chatId, initialContent || '');
    activeStreams.set(streamId, { msgId: result.messageId, chatId, sequence: 0 });
  }

  return Response.json({ ok: true, streamId });
});

server.post('/stream-chunk', async (req) => {
  const { streamId, content, sequence, isThinking } = await req.json();
  const stream = activeStreams.get(streamId);
  if (!stream?.session) return Response.json({ ok: false });

  await stream.session.update(content);
  stream.sequence = sequence;
  return Response.json({ ok: true });
});

server.post('/finalize-stream', async (req) => {
  const { streamId, finalContent } = await req.json();
  const stream = activeStreams.get(streamId);
  if (!stream?.session) return Response.json({ ok: false });

  await stream.session.close(finalContent);
  activeStreams.delete(streamId);
  return Response.json({ ok: true });
});
```

**关键实现**：`FeishuStreamingSession` 类（位于 `openclaw/extensions/feishu/src/streaming-card.ts`，375 行）是自包含的。唯一硬依赖 `fetchWithSsrFGuard`（SSRF 保护 wrapper）可替换为普通 `fetch`（Bridge 仅访问飞书公开 API）。复制该文件到 Bridge 并替换 import 即可使用，无需完整 OpenClaw runtime。

### 3.5 工具桥接（MCP Proxy）

#### 3.5.1 架构

```
                 register()
飞书插件 ──────────────────→ compat-api.ts
  │ registerTool() ×14           │ 捕获工具定义
  │ registerSkill() ×9           │ → capturedTools[]
  │ registerAgent() etc.         │
  └──────────────────────────────┘
                                 │
            Bridge HTTP 暴露     ▼
         ┌──────────────────────────┐
         │ GET  /mcp/tools          │ → 返回已注册工具 schema
         │ POST /mcp/call-tool      │ → 执行工具 → 返回结果
         └──────────────────────────┘
                    ↑
                    │ HTTP
                    ▼
         ┌──────────────────────────┐
         │ AI Sidecar               │
         │ buildSdkMcpServers()     │
         │  → HTTP-type MCP server  │
         │    pointing to Bridge    │
         │    /mcp/* endpoints      │
         └──────────────────────────┘
```

#### 3.5.2 compat-api.ts 扩展

```typescript
// 从 no-op 改为捕获
const capturedTools: CapturedTool[] = [];

registerTool(tool, opts) {
  const toolDef = typeof tool === 'function' ? tool : () => tool;
  capturedTools.push({
    factory: toolDef,
    pluginId: opts?.pluginId || capturedPlugin?.id,
    optional: opts?.optional ?? false,
    group: opts?.group,  // 工具分组（如 'bitable', 'calendar', 'docs'）
  });
}
```

#### 3.5.3 Bridge MCP 端点

```
GET /mcp/tools
  Response: {
    tools: [{
      name: "feishu_create_doc",
      description: "创建飞书云文档",
      group: "docs",
      groupLabel: "文档",
      parameters: { type: "object", properties: {...}, required: [...] }
    }, ...]
  }

POST /mcp/call-tool
  Request:  { toolName: string, args: Record<string, unknown>, userId?: string }
  Response: { ok: boolean, result: unknown, error?: string }
```

#### 3.5.4 工具清单与分组

**实际工具数：14 个**（每个工具内含多个 actions，如 `feishu_doc` 含 18 个 actions）。全部使用 **app-level token**（appId/appSecret），无需用户 OAuth 授权。

| 工具名 | 组 | 说明 | 默认启用 |
|--------|-----|------|---------|
| `feishu_doc` | 文档 | 云文档 CRUD（18 个 action：read/write/append/create/insert/list_blocks 等） | ✅ |
| `feishu_app_scopes` | 文档 | 查看当前应用权限 | ✅ |
| `feishu_chat` | 消息 | 群聊信息/成员查询 | ✅ |
| `feishu_wiki` | 知识库 | 知识库空间/节点 CRUD（6 个 action） | ✅ |
| `feishu_drive` | 云盘 | 云盘文件 CRUD（5 个 action） | ✅ |
| `feishu_perm` | 权限 | 文档权限管理（list/add/remove） | ❌（敏感操作） |
| `feishu_bitable_get_meta` | 多维表格 | 解析 Bitable URL 获取 app_token/table_id | ✅ |
| `feishu_bitable_list_fields` | 多维表格 | 列出表格字段（列） | ✅ |
| `feishu_bitable_list_records` | 多维表格 | 列出表格记录（行），支持分页 | ✅ |
| `feishu_bitable_get_record` | 多维表格 | 获取单条记录 | ✅ |
| `feishu_bitable_create_record` | 多维表格 | 创建记录 | ✅ |
| `feishu_bitable_update_record` | 多维表格 | 更新记录 | ✅ |
| `feishu_bitable_create_app` | 多维表格 | 创建多维表格 | ✅ |
| `feishu_bitable_create_field` | 多维表格 | 创建字段（列） | ✅ |

**UI 分组**（5 个可选组）：

| 组 ID | 组名 | 工具数 | 默认 |
|-------|------|--------|------|
| `doc` | 文档 | 2 | ✅ |
| `chat` | 消息 | 1 | ✅ |
| `wiki_drive` | 知识库 & 云盘 | 3 | ✅ |
| `bitable` | 多维表格 | 8 | ✅ |
| `perm` | 权限管理 | 1 | ❌ |

#### 3.5.5 UI：工具组选择

在 **ChannelDetailView** 的插件设置区域，新增"飞书工具"卡片（复用 `McpToolsCard` 的 checkbox 模式）：

```
┌──────────────────────────────────────────────┐
│ 飞书工具                                      │
│ 选择 AI 可使用的飞书能力                       │
│                                               │
│ ☑ 文档 — 云文档创建/读取/更新            (2)  │
│ ☑ 消息 — 群聊信息/成员查询               (1)  │
│ ☑ 知识库 & 云盘 — 知识库/云盘文件管理    (3)  │
│ ☑ 多维表格 — 表格/记录/字段 CRUD         (8)  │
│ ☐ 权限管理 — 文档权限设置（敏感操作）    (1)  │
│                                               │
│ 共 14 个工具 · 已启用 14 个                    │
└──────────────────────────────────────────────┘
```

**默认启用**：doc + chat + wiki_drive + bitable（共 14 个工具，全部使用 app-level token）
**默认关闭**：perm（权限管理，敏感操作）
**数据存储**：`ChannelConfig.openclawEnabledToolGroups?: string[]`

#### 3.5.6 Sidecar 工具注入

在 `buildSdkMcpServers()` 中新增条件分支：

```typescript
// agent-session.ts
if (imBridgeContext?.pluginId && imBridgeContext?.bridgePort) {
  // 从 Bridge 获取已启用的工具组
  const enabledGroups = imBridgeContext.enabledToolGroups || ['im', 'docs'];
  const toolsUrl = `http://127.0.0.1:${imBridgeContext.bridgePort}/mcp/tools?groups=${enabledGroups.join(',')}`;

  result['feishu-tools'] = {
    type: 'http',
    url: `http://127.0.0.1:${imBridgeContext.bridgePort}/mcp`,
    // 或者用 in-process wrapper:
    command: '__bridge_mcp__',
    bridgePort: imBridgeContext.bridgePort,
    enabledGroups,
  };
}
```

#### 3.5.7 认证模型

**关键发现**：所有 14 个工具均使用 **app-level token**（tenant_access_token，由 appId + appSecret 获取），**不需要**用户级 OAuth/UAT 授权。这大幅简化了实现：

- 无需 OAuth Device Flow
- 无需用户单独授权
- 无需管理 per-user token 刷新
- 工具调用时只需 `agentAccountId` 路由到正确的飞书应用

**工具调用上下文传递**：
- `agentAccountId`：通过 Bridge 环境变量传入，标识使用哪个飞书应用账号
- `requesterSenderId`：从 `dispatchReply` 拦截的 `senderId`（飞书 open_id），用于 `feishu_doc` 创建时自动授权编辑权限
- `messageChannel`：固定为 `"feishu"`

> **注意**：官方文档提到的 `/feishu auth` 是 OpenClaw 完整版中用于以用户身份操作的 OAuth 流程。在 MyAgents Bridge 模式下，工具以应用身份执行，暂不需要此流程。若未来需要以用户身份操作（如代发消息），可在后续版本扩展。

### 3.6 权限系统

飞书 Bot（官方插件）使用插件自带的权限体系：

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `dmPolicy` | 私聊策略：open/pairing/allowlist/disabled | `open` |
| `groupPolicy` | 群聊策略：open/allowlist/disabled | `open` |
| `allowFrom` | 允许的用户列表（open_id） | `[]`（空=不限制） |
| `requireMention` | 群内需 @机器人 | `true` |

**与原生实现的区别**：
- 不使用 MyAgents 的 `permissionMode`（plan/auto/fullAgency）
- 不发送审批卡片
- 权限控制完全由插件处理

---

## 4. 数据模型变更

### 4.1 ChannelConfig 扩展

```typescript
// src/shared/types/agent.ts
interface ChannelConfig {
  // ... 现有字段 ...

  // 新增：OpenClaw 插件工具组
  openclawEnabledToolGroups?: string[];  // ['im', 'docs', 'calendar', ...]
}
```

### 4.2 promotedPlugins 类型扩展

```typescript
// src/renderer/components/ImSettings/promotedPlugins.ts
interface PromotedPlugin {
  // ... 现有字段 ...
  badge?: 'official' | 'community';  // 新增 badge 类型
}
```

### 4.3 BotPlatformRegistry Badge 支持

```typescript
// 新增 badge 类型到平台卡片
interface PlatformEntry {
  // ... 现有字段 ...
  badge?: 'builtin' | 'official' | 'deprecated' | 'plugin';
  deprecationNotice?: string;  // 展示迁移提示
}
```

### 4.4 ImStreamAdapter Capability

```rust
// src-tauri/src/im/adapter.rs
// BridgeAdapter 新增字段
pub struct BridgeAdapter {
    // ... 现有字段 ...
    supports_streaming: bool,     // 来自 /capabilities
    supports_cardkit: bool,       // 来自 /capabilities
}
```

### 4.5 Bridge 工具上下文

```typescript
// 传给 Sidecar 的 IM Bridge 上下文（扩展）
interface ImBridgeContext {
  botId: string;
  pluginId: string;
  bridgePort: number;
  enabledToolGroups?: string[];   // 新增
  hasPluginTools?: boolean;        // 新增：插件是否注册了工具
}
```

---

## 5. 详细改动范围

### 5.1 前端

| 文件 | 变更 |
|------|------|
| `src/renderer/components/ImSettings/promotedPlugins.ts` | 新增飞书官方插件条目，新增 `badge` 字段 |
| `src/renderer/components/ImSettings/BotPlatformRegistry.tsx` | 双入口展示，Badge 组件（官方/即将下线），内置飞书标记 deprecated |
| `src/renderer/components/AgentSettings/channels/ChannelDetailView.tsx` | 新增"飞书工具"卡片区域（OpenClaw 插件专属） |
| `src/renderer/components/AgentSettings/channels/ChannelWizard.tsx` | 飞书官方插件的配置表单增加 domain/streaming/policy 字段 |
| `src/renderer/components/AgentSettings/channels/OpenClawToolGroupsSelector.tsx` | **新建**：工具组选择器组件（checkbox 列表） |
| `src/shared/types/agent.ts` | `ChannelConfig` 新增 `openclawEnabledToolGroups` |

### 5.2 Plugin Bridge (Bun)

| 文件 | 变更 |
|------|------|
| `src/server/plugin-bridge/index.ts` | 新增 4 个 streaming 端点 + 2 个 MCP 端点，streaming session 管理 |
| `src/server/plugin-bridge/compat-api.ts` | `registerTool()` 从 no-op 改为捕获工具定义 |
| `src/server/plugin-bridge/compat-runtime.ts` | 传递 `senderId` 到 Bridge message payload（工具调用需要） |
| `src/server/plugin-bridge/sdk-shim/` | 补充飞书插件需要的 SDK 类型/方法 |
| `src/server/plugin-bridge/streaming-adapter.ts` | **新建**：封装 FeishuStreamingSession 的 Bridge 适配层 |
| `src/server/plugin-bridge/mcp-handler.ts` | **新建**：MCP 工具代理（list + call-tool） |

### 5.3 Rust

| 文件 | 变更 |
|------|------|
| `src-tauri/src/im/adapter.rs` | `ImStreamAdapter` 新增 streaming 方法（带默认实现） |
| `src-tauri/src/im/bridge.rs` | `BridgeAdapter` 实现 streaming 方法，`sync_capabilities()` 解析新字段 |
| `src-tauri/src/im/mod.rs` | `stream_to_im()` 分叉逻辑，新增 `stream_to_im_streaming()` |
| `src-tauri/src/im/bridge.rs` | 启动时传递 `enabledToolGroups` 到 Bridge 环境变量 |
| `src-tauri/src/management_api.rs` | `handle_bridge_message` 确保 `senderId` 传递 |

### 5.4 Sidecar

| 文件 | 变更 |
|------|------|
| `src/server/agent-session.ts` | `buildSdkMcpServers()` 新增 Bridge MCP proxy 注入 |

---

## 6. SDK Shim 补充清单

飞书插件在 `register()` 时会调用 SDK shim 中的更多接口。需要确认并补充：

| 接口 | 当前状态 | 需要 |
|------|---------|------|
| `api.registerChannel()` | ✅ 已实现 | — |
| `api.registerTool()` | ❌ no-op | 改为捕获 |
| `api.registerSkill()` | ❌ no-op | 保持 no-op（本版本不桥接 Skills） |
| `api.registerAgent()` | ❌ no-op | 保持 no-op |
| `api.registerHook()` | ❌ no-op | 保持 no-op |
| `api.registerCli()` | ❌ no-op | 保持 no-op |
| `api.registerAction()` | ❌ no-op | 保持 no-op |
| `api.registerProvider()` | ❌ no-op | 保持 no-op |
| `api.config.get/set` | 需确认 | 可能需要补充 config 读写 |
| `api.events.*` | 需确认 | `before_tool_call`/`after_tool_call` hook |

**验证方法**：安装插件后运行 Bridge，观察 console 输出，逐个补充缺失的 shim。

---

## 7. 飞书应用权限清单

用户需在飞书开放平台为应用配置以下权限（直接引导用户批量导入）：

### 7.1 应用身份权限（tenant scope）

基础消息收发：
- `im:message:send_as_bot`、`im:message:readonly`、`im:message:recall`、`im:message:update`
- `im:chat:read`、`im:chat:update`、`im:resource`
- `contact:contact.base:readonly`
- `cardkit:card:write`、`cardkit:card:read`

### 7.2 应用身份权限（用于工具调用）

所有工具使用 app-level token。需在飞书开放平台为应用添加以下权限：

| 工具组 | 需要的 tenant scope |
|--------|-------------------|
| 文档 | `docx:document:readonly`、`docx:document:write_only`、`docx:document:create`、`docs:document.media:upload`、`docs:document.media:download` |
| 多维表格 | `base:app:*`、`base:field:*`、`base:record:*`、`base:table:*`、`base:view:*` |
| 知识库 | `wiki:node:*`、`wiki:space:*` |
| 云盘 | `drive:drive.metadata:readonly`、`drive:file:*` |
| 权限 | `drive:permission:read`、`drive:permission:write` |

> 注：user scope 权限仅在后续扩展"以用户身份操作"功能时需要，本版本不需要。

**UI 提示**：在配置引导中提供"一键复制权限 JSON"按钮，用户粘贴到飞书开放平台的批量导入页面。

---

## 8. 实施顺序

### Step 1: UI + Promoted Plugin 注册
1. `promotedPlugins.ts` 新增飞书官方插件条目
2. `BotPlatformRegistry.tsx` 双入口 + Badge 组件
3. 内置飞书标记 `[即将下线]`

### Step 2: Plugin Bridge 基础适配
1. SDK shim 补充（逐个验证 register() 不崩溃）
2. `compat-api.ts` 捕获 registerTool() 调用
3. 安装 → 启动 → 验证 gateway.startAccount() 连接飞书

### Step 3: 消息收发打通
1. 验证 dispatchReply → Rust → Sidecar → 回复 → Bridge → sendText 全链路
2. 附件（图片/文件）下载传递
3. 群聊 @mention 识别

### Step 4: CardKit Streaming
1. `ImStreamAdapter` trait 扩展（带默认实现）
2. Bridge 新增 4 个 streaming 端点
3. `BridgeAdapter` 实现 streaming 方法
4. `/capabilities` 返回 streaming 标志
5. `stream_to_im()` 分叉 + `stream_to_im_streaming()` 实现
6. Bridge 端对接 `FeishuStreamingSession`

### Step 5: 工具桥接
1. Bridge 新增 `/mcp/tools`、`/mcp/call-tool` 端点
2. `mcp-handler.ts` 工具代理实现
3. Sidecar `buildSdkMcpServers()` 注入 Bridge MCP
4. `OpenClawToolGroupsSelector.tsx` 组件
5. `ChannelDetailView.tsx` 集成工具组选择
6. 端到端验证：AI 调用飞书工具

### Step 6: 集成测试 + 收尾
1. 私聊全流程测试
2. 群聊全流程测试
3. 流式卡片效果验证
4. 工具调用验证（至少测试文档创建、消息搜索）
5. 配置引导 UX 走查
6. 迁移提示验证

---

## 9. 验收标准

| 场景 | 预期结果 |
|------|---------|
| **安装插件** | 点击"点击安装"后 npm 安装成功，卡片变为"已安装" |
| **配置凭证** | 输入 appId/appSecret 后验证通过，显示 Bot 名称 |
| **启动 Bot** | Bot 状态变为 Online，飞书端可发消息 |
| **私聊文本** | 用户发文本 → AI 回复显示为 CardKit 流式卡片（有 thinking/streaming 动画） |
| **私聊图片** | 用户发图片 → AI 能识别并回复 |
| **群聊 @机器人** | 群内 @bot 发消息 → AI 回复到群 |
| **群聊不 @ 不回复** | requireMention=true 时，普通群消息不触发 AI |
| **CardKit Streaming** | 回复过程中飞书端看到实时流式文字更新，结束后卡片变为完成状态 |
| **工具调用：文档** | "帮我创建一个飞书文档" → AI 调用 feishu_create_doc → 返回文档链接 |
| **工具调用：消息** | "搜索最近关于XXX的消息" → AI 调用 feishu_search_messages → 返回结果 |
| **工具组开关** | 关闭"日历"组后，AI 不再尝试调用日历相关工具 |
| **双入口展示** | 平台选择页同时显示"官方"和"即将下线"两个飞书入口 |
| **内置飞书仍可用** | 已配置内置飞书的用户不受影响，仍可正常使用 |
| **迁移提示** | 内置飞书卡片显示"推荐迁移到官方插件版本"提示 |

---

## 10. 风险与缓解

| 风险 | 级别 | 缓解措施 |
|------|------|---------|
| 插件快速迭代导致 breaking change | 中 | pin 版本 `@larksuite/openclaw-lark@2026.3.15` |
| `FeishuStreamingSession` 依赖 `fetchWithSsrFGuard` | 低 | **已验证**：复制 375 行源码 + 替换为普通 `fetch` shim 即可 |
| SDK shim 不够完整导致 register() 崩溃 | 中 | 逐个 try-catch 包裹 + console 报告 |
| 14 个工具 schema 占用 token | 低 | 14 个工具的 schema 总量可控（每个 <500 token），全部启用无压力 |
| protobufjs postinstall 被 Bun 跳过 | 低 | 已验证不影响运行时 |
| 插件对 group 的 policy 配置较复杂 | 低 | 提供合理默认值，高级配置折叠展示 |

---

## 附录 A：飞书应用权限批量导入 JSON

（完整 JSON 见 `specs/research/feishu_bot_doc.md` 第 168-269 行）

用户在飞书开放平台 → 权限管理 → 批量导入/导出权限 → 粘贴此 JSON → 确认导入。

## 附录 B：参考实现文件

| 参考 | 路径 |
|------|------|
| 插件 StreamingCardController | `openclaw/extensions/feishu/src/streaming-card.ts` |
| 插件 Reply Dispatcher | `openclaw/extensions/feishu/src/reply-dispatcher.ts` |
| 插件 Outbound Adapter | `openclaw/extensions/feishu/src/feishu-outbound.ts` |
| 插件工具注册 | `openclaw/extensions/feishu/src/tools/` |
| OpenClaw 工具策略 | `openclaw/src/agents/tool-policy-pipeline.ts` |
| QQBot Bridge 参考 | `src/server/plugin-bridge/` (现有实现) |
| 原生飞书 Card Kit | `src-tauri/src/im/feishu.rs:1800-1900` |
| DingTalk AI Card Streaming | `src-tauri/src/im/dingtalk.rs:65-634` |
