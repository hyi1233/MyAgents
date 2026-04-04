# PRD: 群聊 Prompt 优化与 Bridge 群组支持

> Version: 0.1.59
> Date: 2026-04-03
> Status: Approved

## 背景

### 用户反馈

1. **飞书群聊收不到消息**：用户通过 OpenClaw 飞书插件接入群聊，设置"全部消息"模式后，Bot 在群里仍然收不到消息。群聊管理页面显示"暂无群聊"。
2. **@触发后无历史上下文**：通过 @mention 触发 Bot 后，AI 看不到群聊历史记录，开始疯狂调用工具尝试手动获取 chat_id 和消息历史。
3. **多 Bot 群聊误回复**：群内同时有 bot1 和 bot2，两个都开了"全部消息"。用户发 `@bot1 听得到我的声音不`，bot2 也回复了。

### 根因分析

**问题 1 & 2**（已修复，commit `4b2e247` + `ed755aa`）：

Bridge 适配器缺少群组生命周期事件。原生适配器（Telegram/飞书/钉钉）通过平台事件（`my_chat_member` 等）自动发现群组 → 写入 `groupPermissions`。但 Bridge/OpenClaw 插件无等价事件 → `groupPermissions` 永远为空 → 群消息在权限检查静默丢弃 → 历史缓冲从未填充。此外 `groupActivation` 的 UI 切换未热更新到运行实例。

**问题 3**（本 PRD 范围）：

群聊 prompt 设计不足。在"全部消息"模式下：
- AI 不知道消息是否 @了自己（`isMention` 未传给 Sidecar）
- AI 不知道自己的名字叫什么（系统 prompt 中有，但群聊上下文中缺乏对照）
- 没有明确的"不回复其他 bot @mention"规则
- `<NO_REPLY>` 机制的指导不够强（只说"自行判断"，没有列出具体的沉默场景）

## 需求目标

### 目标 1：群聊 Prompt 模板重构

重写群聊消息的 prompt 拼装逻辑，区分 Mention 模式和 Always 模式，提供清晰的回复规则。

### 目标 2：传递 isMention 字段

将 Rust 的 `msg.is_mention` 传给 Sidecar，使 prompt 模板能标注"本条消息是否 @了你"。

### 目标 3：群聊历史带时间戳

`GroupHistoryEntry` 的时间戳从 `std::time::Instant`（单调时钟）改为 wall-clock time，格式化输出带完整时间（年月日时分秒）。

---

## 详细设计

### 1. Prompt 模板结构

每条群聊消息发给 AI 时的拼装结构：

```
[规则注入]  <system-reminder> 群聊信息 + 回复规则 </system-reminder>    ← 见注入策略
[每轮注入]  群聊历史（pendingHistory，如有）                             ← Mention 模式特有
[每轮注入]  引用回复（replyToBody，如有）
[每轮注入]  消息上下文标记（isMention 状态）+ 发送者 + 正文
```

#### 规则注入策略（防上下文压缩遗忘）

群聊会话可能跑几百轮，SDK 的 context compaction 会将早期消息压缩为摘要，第一轮注入的规则可能丢失。采用两层注入策略：

| 层级 | 触发条件 | 内容 | Token 成本 |
|------|---------|------|-----------|
| **完整版** | 首轮（`isFirstGroupTurn`）+ 每 10 轮（`messageCount % 10 === 0`） | 完整 `<system-reminder>` 含群聊信息 + 回复规则 | ~200 tokens |
| **简版提醒** | **每轮**（仅 Always 模式，非完整版轮次） | 1-2 行核心规则 | ~30 tokens |

Always 模式的**每轮简版**：
```
<system-reminder>
你是「{{botName}}」，当前处于群聊的全部消息模式 — 你会收到群聊内的全部信息，你需要自主判断是否需要回复消息，与自己无关的消息不要回复，@其他人的消息不要回复。当你判断不需要回复消息时，只输出字符<NO_REPLY>
</system-reminder>
```

Mention 模式不需要每轮提醒 — 能收到消息就一定是被 @ 了，必须回复。

完整版每 10 轮重新注入一次，确保在 compaction 触发后规则细节仍可恢复。

### 2. 首轮注入模板

#### 2.1 Mention 模式

```
<system-reminder>
[群聊信息]
你正在「{{groupName}}」{{platformLabel}}群聊中。你的名字是「{{botName}}」。
激活模式：仅 @提及（只有被 @、被回复或使用 /ask 时才会收到消息）。
你的回复会自动发送到群里，直接回复即可。
群内不同人的消息会以 [from: 名字 时间] 标注发送者。
{{#if groupSystemPrompt}}
[群聊指令]
{{groupSystemPrompt}}
{{/if}}
</system-reminder>
```

#### 2.2 全部消息模式（Always）

```
<system-reminder>
[群聊信息]
你正在「{{groupName}}」{{platformLabel}}群聊中。你的名字是「{{botName}}」。
激活模式：全部消息（你会收到群里所有消息，包括不是发给你的）。
你的回复会自动发送到群里，直接回复即可。
群内不同人的消息会以 [from: 名字 时间] 标注发送者。

[回复规则]
你必须非常克制，大多数消息不需要你回复。仅在以下情况回复：
1. 消息明确 @你（即 @{{botName}}）
2. 消息回复了你之前的消息
3. 有人直接向你提问或请求帮助
4. 你确信能提供明确价值的信息

以下情况必须保持沉默：
- 消息 @的是其他人或其他机器人
- 普通闲聊、与你无关的讨论
- 你不确定是否该回复时

不需要回复时，只回复 <NO_REPLY>，不要添加任何其他内容。
{{#if groupSystemPrompt}}
[群聊指令]
{{groupSystemPrompt}}
{{/if}}
</system-reminder>
```

### 3. 每条消息的上下文标记

根据激活模式和 `isMention` 状态，在消息正文前注入标记：

| 激活模式 | isMention | 标记 |
|---------|-----------|------|
| Always | true | `[本条消息 @了你]` |
| Always | false | `[本条消息未 @你]` |
| Mention | — | 无标记（能收到 = 一定是 @了） |

### 4. pendingHistory 格式（带时间戳）

```
[以下是上次回复后的群聊记录，仅供参考]
[from: 张三 2026-04-03 14:02:15] 今天下午开会吗
[from: 李四 2026-04-03 14:05:30] @bot1 帮我查下会议室
[from: 王五 2026-04-03 16:30:00] 3点的会结束了
[以下是当前消息，请回复]
```

当前消息同样带时间戳：

```
[from: 罗伟 2026-04-03 16:35:22]
@秘书长(MA) 帮我总结下今天群里聊了什么
```

**pendingHistory 语义**：

| 模式 | pendingHistory 内容 |
|------|-------------------|
| Mention | 上次 bot 回复后积累的所有未触发消息（drain 后清空） |
| Always | 始终为空（每条消息独立发送到 AI，会话历史本身就是完整记录） |

### 5. 完整示例

#### 示例 1：Always 模式，首轮，用户 @了另一个 bot

```
<system-reminder>
[群聊信息]
你正在「运营群」飞书群聊中。你的名字是「秘书长(MA)」。
激活模式：全部消息（你会收到群里所有消息，包括不是发给你的）。
你的回复会自动发送到群里，直接回复即可。
群内不同人的消息会以 [from: 名字 时间] 标注发送者。

[回复规则]
你必须非常克制，大多数消息不需要你回复。仅在以下情况回复：
1. 消息明确 @你（即 @秘书长(MA)）
2. 消息回复了你之前的消息
3. 有人直接向你提问或请求帮助
4. 你确信能提供明确价值的信息

以下情况必须保持沉默：
- 消息 @的是其他人或其他机器人
- 普通闲聊、与你无关的讨论
- 你不确定是否该回复时

不需要回复时，只回复 <NO_REPLY>，不要添加任何其他内容。
</system-reminder>

[本条消息未 @你]
[from: 罗伟 2026-04-03 16:35:22]
@bot1 听得到我的声音不
```

**预期 AI 回复**：`<NO_REPLY>`

#### 示例 2：Always 模式，非首轮，有历史，用户 @了本 bot

```
[以下是上次回复后的群聊记录，仅供参考]
[from: 张三 2026-04-03 14:02:15] 今天下午开会吗
[from: 李四 2026-04-03 14:05:30] 3点开始
[以下是当前消息，请回复]

[本条消息 @了你]
[from: 罗伟 2026-04-03 16:35:22]
@秘书长(MA) 帮我总结下今天群里聊了什么
```

**预期 AI 回复**：正常总结群聊内容

#### 示例 3：Mention 模式，首轮，有历史

```
<system-reminder>
[群聊信息]
你正在「技术群」Telegram 群聊中。你的名字是「CodeBot」。
激活模式：仅 @提及（只有被 @、被回复或使用 /ask 时才会收到消息）。
你的回复会自动发送到群里，直接回复即可。
群内不同人的消息会以 [from: 名字 时间] 标注发送者。
</system-reminder>

[以下是上次回复后的群聊记录，仅供参考]
[from: Alice 2026-04-03 10:15:00] 这个 bug 怎么修
[from: Bob 2026-04-03 10:16:30] 试试重启
[以下是当前消息，请回复]

[from: Charlie 2026-04-03 10:20:00]
@CodeBot 能帮我看下这段代码吗
```

**预期 AI 回复**：正常回复

#### 示例 4：Always 模式，普通闲聊（无 @mention）

```
[本条消息未 @你]
[from: 张三 2026-04-03 09:00:05]
今天天气真好啊
```

**预期 AI 回复**：`<NO_REPLY>`

---

## 改动范围

### Rust 层

| 文件 | 改动 |
|------|------|
| `src-tauri/src/im/mod.rs` (`stream_to_im`) | 补传 `isMention` + `messageCount` 字段到 Sidecar JSON payload |
| `src-tauri/src/im/group_history.rs` | `GroupHistoryEntry.timestamp` 从 `Instant` 改为 `chrono::DateTime<Local>`；`format_as_context` 输出带时间戳 |

### Bun 层

| 文件 | 改动 |
|------|------|
| `src/server/index.ts` (`/api/im/chat` handler) | 重写群聊消息拼装逻辑：`<system-reminder>` 包裹规则、mention 上下文标记、时间戳格式 |

### 字段可用性

| 字段 | 当前状态 | 需要改动 |
|------|---------|---------|
| `groupName` | ✅ 已有 | 无 |
| `platformLabel` (groupPlatform) | ✅ 已有 | 无 |
| `botName` | ✅ 已有 | 无 |
| `groupActivation` | ✅ 已有 | 无 |
| `isFirstGroupTurn` | ✅ 已有 | 无 |
| `pendingHistory` | ✅ 已有 | 格式改为带时间戳 |
| `senderName` | ✅ 已有 | 无 |
| `groupSystemPrompt` | ✅ 已有 | 无 |
| `replyToBody` | ✅ 已有 | 无 |
| **`isMention`** | ❌ 未传 | **Rust 补传** |
| **`messageCount`** | ❌ 未传 | **Rust 补传**（用于每 10 轮重注入完整规则） |

---

## 已完成的前置修复

以下问题已在本版本早期修复，是本 PRD 的前置依赖：

| 问题 | 修复 | Commit |
|------|------|--------|
| Bridge 群组无法自动发现 | 群消息到达时自动发送 `GroupEvent::BotAdded` | `4b2e247` |
| 未授权群消息不缓冲历史 | 权限拒绝前写入 `GroupHistoryBuffer` | `4b2e247` |
| `groupActivation` 切换不热更新 | `cmd_update_agent_config` 增加 channels 级热更新 | `4b2e247` |
| 自死锁风险 | `try_send` 替代 `send().await` | `ed755aa` |
| 重复欢迎消息 | BotAdded handler 增加 Pending 去重 | `ed755aa` |

## 参考

- OpenClaw 群聊 prompt 设计：`/openclaw/src/auto-reply/reply/groups.ts`（`buildGroupIntro()` + `buildGroupChatContext()`）
- OpenClaw 的 `NO_REPLY` token：`/openclaw/src/auto-reply/tokens.ts`
- OpenClaw mention 检测：`/openclaw/src/channels/mention-gating.ts`（`resolveMentionGating()`）
