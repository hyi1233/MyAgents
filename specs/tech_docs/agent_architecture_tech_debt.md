# v0.1.41 Agent 架构升级 — 技术债清单

> 记录时间: 2026-03-11 | 分支: dev/0.1.41
> 背景: 将 IM Bot 中心架构升级为 Agent 中心架构 (PRD: `specs/prd/prd_0.1.41_agent_architecture.md`)

## 总体状态

- **Phase 1 (数据模型 + 迁移)**: 已完成
- **Phase 2 (Rust 层重构)**: 主体完成，4 个子项仍未完成 (TD-5, TD-7, TD-8, TD-6 残留)
- **Phase 3 (UI 改造)**: 已完成
- **v0.1.41 commit `0ddb7b1`**: 一次性解决 TD-1 ~ TD-4 + TD-6 主体
- **剩余技术债**: 见 `specs/prd/prd_0.1.42_rust_agent_native.md`

---

## TD-1: `start_im_bot()` 中转模式 (Plan 2.4) ✅ RESOLVED

**优先级: 高 | 工作量: 中 | 完成于: v0.1.41 commit `0ddb7b1`**

### 现状

`cmd_start_agent_channel()` 和 `schedule_agent_auto_start()` 启动 Channel 时，先调旧的 `start_im_bot()` 在 `ManagedImBots` 中创建实例，再手动 `im_guard.remove()` 移入 `ManagedAgents`。

```rust
// cmd_start_agent_channel (mod.rs ~L4168)
let bot_status = start_im_bot(&app_handle, &im_state, ...).await?;
// ... 然后从 im_state 移到 agent_instance.channels
let mut im_guard = imState.lock().await;
if let Some(bot_instance) = im_guard.remove(&channelId) { ... }
```

### 问题

1. **瞬态不一致**: Channel 短暂存在于 `ManagedImBots`，此期间 `cmd_im_all_bots_status` 能看到它，移走后又消失。已引发 [session tag 闪烁 bug](../), 虽已从消费端修补，但根因未消除。
2. **两处重复**: `cmd_start_agent_channel` 和 `schedule_agent_auto_start` 都有相同的"启动→移动"模式。
3. **关注点混乱**: Agent Channel 的生命周期不应经过 IM Bot 的容器。

### 理想状态

提取独立的 `start_channel()` 函数，直接在 `ManagedAgents` 内创建 `ChannelInstance`。`start_im_bot()` 保留为旧版 IM Bot 的入口。

### 涉及文件

- `src-tauri/src/im/mod.rs` — `start_im_bot()` 拆分为 `start_channel()` + 旧版 wrapper
- 两个调用点: `cmd_start_agent_channel`, `schedule_agent_auto_start`

---

## TD-2: Session Key 新格式未激活 (Plan 2.3) ✅ RESOLVED

**优先级: 高 | 工作量: 中 | 完成于: v0.1.41 commit `0ddb7b1`**

### 现状

新格式 `agent:{agentId}:{channelType}:{private|group}:{chatId}` 的解析器已实现 (`router.rs:602`)，但 Agent Channel 实际仍使用旧格式 `im:{platform}:{type}:{id}` 生成 session key。

```rust
// router.rs — 已实现但标记 dead_code
#[allow(dead_code)]
pub fn new_for_agent(default_workspace: PathBuf, agent_id: String) -> Self { ... }
```

### 问题

1. 无法通过 session key 区分同一平台不同 Agent 的 session
2. Agent ID 信息不在 key 中，routing 依赖额外状态
3. `new_for_agent()` 一直是 dead code

### 理想状态

Agent Channel 启动时使用 `SessionRouter::new_for_agent()`，生成 `agent:` 前缀 key。解析端已兼容两种格式，无需改动。

### 涉及文件

- `src-tauri/src/im/router.rs` — 激活 `new_for_agent()`, 移除 `#[allow(dead_code)]`
- `src-tauri/src/im/mod.rs` — `cmd_start_agent_channel` / `schedule_agent_auto_start` 中用新构造器
- 前端 `useTaskCenterData.ts` — `extractPlatformDisplay()` 已处理两种格式 ✅

### 注意

需要同时确保:
- 旧 session 文件仍可读（不丢历史对话）
- `parse_session_key()` 已兼容 ✅

---

## TD-3: 健康状态文件路径未迁移 (Plan 2.10) ✅ RESOLVED

**优先级: 高 | 工作量: 中 | 完成于: v0.1.41 commit `0ddb7b1`**

### 现状

Agent Channel 的健康状态文件仍使用旧路径:
```
~/.myagents/im_bots/{channelId}/state.json
~/.myagents/im_bots/{channelId}/buffer.json
~/.myagents/im_bots/{channelId}/dedup.json
```

### 理想状态

```
~/.myagents/agents/{agentId}/channels/{channelId}/state.json
~/.myagents/agents/{agentId}/channels/{channelId}/buffer.json
~/.myagents/agents/{agentId}/channels/{channelId}/dedup.json
```

### 问题

1. Agent Channel 和旧版 IM Bot 共享 `im_bots/` 目录，磁盘结构混乱
2. 无法按 Agent 维度清理数据
3. 删除 Agent 时无法一次性清理所有 Channel 数据

### 涉及文件

- `src-tauri/src/im/health.rs` — 新增 `agent_data_dir(agent_id, channel_id)`，启动时检测旧路径自动迁移
- `src-tauri/src/im/mod.rs` — Channel 启动时传入 agent_id

---

## TD-4: `buildImBotConfigsShim()` 兼容层 (Plan 1.5) ✅ RESOLVED

**优先级: 中 | 工作量: 低 | 完成于: v0.1.41 commit `0ddb7b1`**

### 现状

每次 Agent 配置变更（patch/persist/add/remove），都会调 `buildImBotConfigsShim()` 将 `agents[]` 反推为 `imBotConfigs[]` 写入 config.json，供 Rust 旧代码读取。

```typescript
// agentConfigService.ts — 4 个调用点
export async function persistAgents(agents: AgentConfig[]): Promise<void> {
  await atomicModifyConfig(config => ({
    ...config,
    agents,
    imBotConfigs: buildImBotConfigsShim(agents),  // ← 每次都重建
  }));
}
```

### 问题

1. 每次 Agent 配置变更都要序列化两份数据
2. config.json 中 `imBotConfigs` 是冗余数据
3. 维护两种格式增加 bug 风险

### 删除条件

Rust 层完全从 `agents[]` 读取配置后 (TD-1 完成)，删除 shim + 清空 `imBotConfigs`。

### 涉及文件

- `src/renderer/config/services/agentConfigService.ts` — 删除 `buildImBotConfigsShim()` 及 4 个调用点

---

## TD-5: 旧版 IM 命令未改为 Alias (Plan 2.7)

**优先级: 中 | 工作量: 低**

### 现状

Rust 层同时注册了两套独立命令:

```rust
// lib.rs
// 旧版 (独立实现，读 ManagedImBots)
im::cmd_start_im_bot,
im::cmd_stop_im_bot,
im::cmd_im_bot_status,
im::cmd_im_all_bots_status,
im::cmd_update_im_bot_config,
im::cmd_add_im_bot_config,
im::cmd_remove_im_bot_config,

// 新版 (读 ManagedAgents)
im::cmd_start_agent_channel,
im::cmd_stop_agent_channel,
im::cmd_agent_status,
im::cmd_all_agents_status,
im::cmd_update_agent_config,
im::cmd_create_agent,
im::cmd_delete_agent,
```

### 问题

1. 两套命令操作不同的状态容器，可能产生不一致
2. 前端需要知道何时用哪套命令
3. 旧版 Settings → ImSettings 仍直接调旧命令

### 理想状态

旧命令内部转调新命令（通过 bot_id 查找所属 Agent），行为一致。或在 ImSettings 废弃后直接删除旧命令。

### 涉及文件

- `src-tauri/src/im/mod.rs` — 旧命令 wrapper 化
- `src-tauri/src/lib.rs` — 命令注册

---

## TD-6: 双套 UI 共存 (Plan 3.10)

**优先级: 中 | 工作量: 高**

### 现状

Settings 页面同时展示:
1. 新版 `<AgentCardList>` — Agent 管理
2. 旧版 `<ImSettings>` — 标注为「旧版 IM Bot 配置」

```tsx
// Settings.tsx L1924-1928
<div className="border-t border-[var(--line)] pt-6">
  <h3 className="mb-4 text-sm font-semibold text-[var(--ink-muted)]">旧版 IM Bot 配置</h3>
  <ImSettings />
</div>
```

### 问题

1. 用户困惑: 两个入口管理相似功能
2. ImSettings 的 20+ 组件仍需维护
3. 旧版创建的 Bot 不在 Agent 体系内，配置变更不触发 Agent 事件

### 删除条件

1. 存量用户的 `imBotConfigs` 已全部迁移为 `agents[]`（迁移函数已有 ✅）
2. 确认无用户仍在使用旧版直接创建 Bot
3. 至少保留一个版本的过渡期

### 涉及文件

- `src/renderer/components/ImSettings/` — 整个目录 (20 文件)
- `src/renderer/pages/Settings.tsx` — 移除旧版区块
- `src/renderer/config/types.ts` — 移除 `imBotConfigs` 字段（需确保迁移兜底）

---

## TD-7: 双重事件发射

**优先级: 低 | 工作量: 低**

### 现状

Agent Channel 状态变更时同时发射两个事件:
```rust
// mod.rs
app_handle.emit("agent:status-changed", json!({ "agentId": agentId, ... }));
app_handle.emit("im:status-changed", json!({ "event": "started" }));  // 兼容
```

### 问题

前端两处都要监听，多余的事件传播。

### 删除条件

前端所有消费者都已迁移到 `agent:status-changed` 后删除 `im:status-changed` 的兼容发射。

### 涉及文件

- `src-tauri/src/im/mod.rs` — 删除兼容事件发射（3 处）
- 前端确认无遗漏监听点

---

## TD-8: `management_api.rs` 双重查找

**优先级: 低 | 工作量: 低**

### 现状

Management API 的 `find_bot_refs()` 和 `find_bot_adapter()` 同时查 `ManagedImBots` 和 `ManagedAgents`:
```rust
// management_api.rs L379-408
async fn find_bot_refs(bot_id: &str) -> Option<(...)> {
    // Check ManagedImBots first
    if let Some(bots) = get_im_bots() { ... }
    // Then check ManagedAgents
    if let Some(agents) = get_agents() { ... }
    None
}
```

### 问题

两次加锁查找，TD-1 完成后 `ManagedImBots` 中不再有 Agent Channel，查找总是 miss 第一轮。

### 删除条件

TD-1 完成 + ImSettings 废弃后，移除 `ManagedImBots` 查找分支。

### 涉及文件

- `src-tauri/src/management_api.rs`

---

## 依赖关系图（更新于 2026-03-14）

```
✅ TD-1 (start_channel 提取)     — DONE
✅ TD-2 (session key 激活)        — DONE
✅ TD-3 (健康文件迁移)            — DONE
✅ TD-4 (shim 删除)               — DONE
✅ TD-6 主体 (ImSettings 从 Settings.tsx 移除) — DONE

❌ TD-5 (旧命令 alias)     — 待 v0.1.42
❌ TD-6 残留 (ImSettings 目录删除) — 待 v0.1.42
❌ TD-7 (双重事件清理)     — 待 v0.1.42
❌ TD-8 (management_api 简化) — 待 v0.1.42
```

---

## 实施计划

| 版本 | 内容 | 状态 |
|------|------|------|
| v0.1.41 | TD-1 + TD-2 + TD-3 + TD-4 + TD-6 主体 | ✅ 已完成 (commit `0ddb7b1`) |
| v0.1.42 | TD-5 + TD-6 残留 + TD-7 + TD-8 | 待实施 (PRD: `prd_0.1.42_rust_agent_native.md`) |

---

## 非技术债备忘

以下是 Plan 中提到但已完成的项，确认无遗漏:

- [x] SidecarOwner::ImBot → SidecarOwner::Agent (sidecar.rs)
- [x] AgentConfigRust / ChannelConfigRust 类型 (types.rs)
- [x] lastActiveChannel 追踪 (mod.rs processing loop)
- [x] 新 Tauri 命令 7 个 (lib.rs)
- [x] Config 读写 read_agent_configs_from_disk / persist_agent_config_patch
- [x] deliver_cron_result_to_bot Agent 优先查找 (cron_task.rs)
- [x] management_api 设置 Agent state (management_api.rs)
- [x] Heartbeat 上提到 Agent 级 + resolve_target_channel fallback 链
- [x] UI 全部组件 (AgentSettings/*, WorkspaceConfigPanel, Chat.tsx 守卫, Settings, Launcher)
- [x] useAgentStatuses hook + 5s 轮询
- [x] useTaskCenterData 同时查询 Agent 状态 (session tag 修复)
- [x] Mutex clone-then-drop 最佳实践 (status 命令 + heartbeat loops)
- [x] patchAgentConfig → cmd_update_agent_config 运行时同步
