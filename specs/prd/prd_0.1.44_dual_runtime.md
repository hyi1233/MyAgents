# 双运行时架构：内置 Node.js + Bun 分层运行

> **Version**: 0.1.44
> **Date**: 2026-03-17
> **Status**: Draft
> **Trigger**: [GitHub Issue #29](https://github.com/hAcKlyc/MyAgents/issues/29) — Windows Playwright MCP 空白浏览器超时

---

## 1. 背景

### 1.1 运行时依赖全景

MyAgents 的「零外部依赖」目标要求核心功能在安装后即可使用，所有运行时依赖随 App 打包：

```
MyAgents App
├── Bun (内置)          ← 跑 Agent Runtime：Claude Agent SDK (executable: 'bun')
│                         SDK 本身兼容 node/bun/deno，我们选 Bun 因为启动快、单文件易打包
├── Git (Windows 捆绑)   ← SDK (Claude Code) 需要 git（代码操作）+ bash（工具执行环境）
│                         macOS 自带 git+bash；Windows 两者都没有 → NSIS 安装器静默装 Git for Windows
└── Node.js (待内置)     ← 功能层需要：MCP Server / 社区 npm 包 / AI bash 中的 node/npx 命令
```

**Bun 的角色**：运行 Agent Runtime（Sidecar 进程 → Claude Agent SDK → AI 对话与工具调用）。SDK 的 Bash 工具在 macOS 走 `/bin/bash`，Windows 走 git-bash，AI 的所有命令行操作都在这个 bash 环境中执行。`buildClaudeSessionEnv()` 构造的 PATH 决定了 AI 能找到哪些命令。

### 1.2 现状与问题

当前 Bun 是唯一 JS 运行时，所有原本需要 Node.js 的场景均被替换：

| # | 场景 | 原始方式 | 当前替代 |
|---|------|---------|---------|
| 1 | Builtin MCP Server 执行 | `npx @playwright/mcp` | `bun x @playwright/mcp` |
| 2 | MCP 启用时预热缓存 | `npx <pkg> --help` | `bun x <pkg> --help` |
| 3 | Chromium 浏览器安装 | `node playwright-core/cli.js install` | `bun playwright-core/cli.js install` |
| 4 | agent-browser 自动安装 | `npm install agent-browser` | `bun add agent-browser` |
| 5 | OpenClaw 插件安装 | `npm init` + `npm install` | `bun init` + `bun add` |
| 6 | Plugin Bridge 进程 | `node plugin-bridge.js` | `bun plugin-bridge.js` |
| 7 | agent-browser wrapper + node shim | `node` | `~/.myagents/shims/node` → hardlink/脚本指向 bun |
| 8 | SDK 子进程 PATH | 系统 PATH | `buildClaudeSessionEnv()` 前置 bundled bun 目录 |

**核心矛盾**：场景 1-7 全是功能层代码（社区 npm 生态），设计目标是 Node.js。用 Bun 强行替代，等于让我们承担 Bun 所有兼容性 debt。

### 1.2 问题

Bun 对 Node.js 的兼容性存在系统性缺陷，随着接入的社区 MCP / 插件增多，兼容性问题呈线性增长趋势：

#### 已踩过的坑

| 问题 | 根因 | 我们的补丁 |
|------|------|-----------|
| **Windows Playwright 空白浏览器** (Issue #29) | Bun `child_process.spawn()` 的 fd3/fd4 管道处理在 Windows 上不兼容 Playwright CDP pipe transport (`oven-sh/bun#15679`, `#27977`，至今未修复) | v0.1.44 临时改为 Windows 上 `npx` 回退（引入 Node.js 依赖） |
| **Plugin Bridge axios 挂起** | Bun 将 axios 解析为 browser 版本，缺少 `http` adapter（`oven-sh/bun#3371`, `#8996`） | `plugin-bridge/index.ts` 手动打 timeout 补丁 |
| **v0.1.30 node shim 泄漏到全局 PATH** | `~/.myagents/bin/node` shim 污染 Playwright WebSocket transport | v0.1.31 迁移 shim 到 `~/.myagents/shims/`，隔离作用域 |

#### 已知但尚未踩到的风险

| 风险领域 | 具体表现 | Bun issue |
|---------|---------|-----------|
| Windows 命名管道 | 创建命名管道时 assertion crash | `oven-sh/bun#13042` |
| `worker_threads` | 缺少 stdin/stdout/stderr 选项，workerpool 等库直接坏 | `oven-sh/bun#23875` |
| native addon ABI | better-sqlite3、sharp 等 NODE_MODULE_VERSION 不匹配 | `oven-sh/bun#19328` |
| `node:crypto` | RSA 解密比 Node.js 慢 20 倍，基于 browserify polyfill 架构 | `oven-sh/bun#14040` |
| `bunx` 缓存 | 激进缓存策略，静默提供旧版本，无 `--no-cache` 选项 | `oven-sh/bun#12245` |
| postinstall 脚本 | 非信任包的 postinstall 被静默跳过，Playwright/Puppeteer 浏览器下载失败 | by design |
| `v8.serialize` | 使用 JSC 格式而非 V8 格式，跨运行时序列化数据不兼容 | by design |

#### 核心矛盾

每多接入一个 MCP / 社区插件，就多一个潜在的兼容性炸弹。而且这些 bug 是 Bun 上游的，我们无法修复，只能逐个打补丁绕过（axios 补丁、Playwright Windows 补丁、node shim 隔离……）。

### 1.3 目标

引入 **双运行时架构**：Agent Runtime 走 Bun（快），功能层 / 社区生态走 Node.js（稳）。

- 保持零外部依赖（Node.js 随 App 打包，与 Bun、Git 同等待遇）
- 消除 Bun 兼容性问题对 MCP / 插件 / AI 工具调用的影响
- AI 的 Bash 工具执行环境自动包含 Node.js（`node`/`npx`/`npm` 可用）
- 安装包体积增量可控

---

## 2. 架构设计

### 2.1 分层原则

```
┌─────────────────────────────────────────────────────────────┐
│                      MyAgents App                            │
├────────────────────────────┬────────────────────────────────┤
│      Bundled Bun           │      Bundled Node.js           │
│      (已有，不变)           │      (新增)                    │
├────────────────────────────┼────────────────────────────────┤
│ ✅ Bun Sidecar 进程        │ ✅ MCP Server 执行 (npx)       │
│ ✅ Plugin Bridge 进程      │ ✅ AI Bash 工具里的 node/npx    │
│ ✅ bun add 内部包安装       │ ✅ 社区 npm 包 postinstall     │
│ ✅ Chromium 下载安装        │ ✅ 有 native addon 的 MCP      │
│ ✅ agent-browser 运行       │                                │
├────────────────────────────┼────────────────────────────────┤
│  我们写的代码               │  社区生态 / 第三方代码          │
│  行为可控可测               │  设计预期是 Node.js            │
└────────────────────────────┴────────────────────────────────┘
```

**判断标准**：
- **Bun**：我们编写或控制的代码（Sidecar 主进程、Plugin Bridge、内部工具脚本）——追求启动速度
- **Node.js**：社区编写的代码（MCP Server、npm 包的 postinstall、AI 自行调用的 node 命令）——追求生态兼容

### 2.2 打包方案

#### 二进制文件

```
src-tauri/binaries/
  ├── bun-aarch64-apple-darwin              55 MB  (已有)
  ├── bun-x86_64-apple-darwin               60 MB  (已有)
  ├── bun-x86_64-pc-windows-msvc.exe              (已有)
  ├── node-aarch64-apple-darwin             ~108 MB (新增，从 nodejs.org 官方 tarball 提取)
  ├── node-x86_64-apple-darwin              ~108 MB (新增)
  └── node-x86_64-pc-windows-msvc.exe       ~83 MB (新增，从 nodejs.org 官方 zip 提取)
```

> **注意**：只需要 `node` 二进制本身（macOS 从 tarball 提取 `bin/node`，Windows 下载独立 `node.exe`）。不需要 npm/npx——npm 随 Node.js 标准分发包含在 `lib/node_modules/` 中，但对于我们的场景，`npx` 的功能可通过其他方式覆盖（见 §2.4）。

#### 版本选择

- **Node.js v22 LTS**（Maintenance LTS，EOL 2027-04），钉死到具体 patch 版本（如 `v22.22.1`）
- 官方下载 URL 含完整版本号，不可变，附 SHA256 校验
- 版本升级通过修改构建脚本中的常量完成，跟随 App 大版本更新

#### 体积影响

| 平台 | 当前安装包 | 新增 Node.js (压缩后) | 增幅 |
|------|----------|---------------------|------|
| macOS arm64 | ~170 MB | +26 MB (.xz) | +15% |
| macOS x64 | ~180 MB | +27 MB (.xz) | +15% |
| Windows x64 | ~150 MB | +36 MB (.zip) | +24% |

> 对于桌面 App 这是合理的增量。许多同类产品（VS Code、Cursor）内置多个运行时，体积远大于此。

### 2.3 运行时发现（runtime.ts 改动）

新增函数：

```typescript
// 返回内置 Node.js 二进制路径
getBundledNodePath(): string | null

// 返回内置 Node.js 所在目录（用于 PATH 注入）
getBundledNodeDir(): string | null
```

查找逻辑与现有 `getBundledRuntimePath()` / `getBundledBunDir()` 对称：

| 平台 | Bun 位置 | Node.js 位置 |
|------|---------|-------------|
| macOS (prod) | `Contents/MacOS/bun-<arch>` | `Contents/MacOS/node-<arch>` |
| macOS (dev) | `src-tauri/binaries/bun-<arch>` | `src-tauri/binaries/node-<arch>` |
| Windows (prod) | `<install_dir>/bun.exe` | `<install_dir>/node.exe` |
| Windows (dev) | `src-tauri/binaries/bun-<arch>.exe` | `src-tauri/binaries/node-<arch>.exe` |

### 2.4 PATH 注入（agent-session.ts 改动）

`buildClaudeSessionEnv()` 的 `essentialPaths` 新增 Node.js 目录：

```
PATH 优先级（从高到低）：
1. bundledBunDir         — 内置 Bun（Sidecar 自身、agent-browser 等需要）
2. bundledNodeDir        — 内置 Node.js  ← 新增
3. ~/.myagents/bin       — MyAgents wrapper 脚本（agent-browser 等）
4. ~/.bun/bin            — 用户系统 bun（fallback）
5. 系统路径              — /opt/homebrew/bin, /usr/local/bin, ...
```

**效果**：AI 使用 Bash 工具时，`node`、`npm`、`npx` 命令自动可用，无需用户安装任何东西。

### 2.5 MCP Server 执行策略（agent-session.ts 改动）

`buildSdkMcpServers()` 中 builtin MCP 的执行逻辑简化：

```
改前：
  command = 'npx'
  → 检测 isBuiltin?
    → 是 → 强制替换为 bun x（Windows Playwright 特判走 npx）
    → 否 → 保持 npx

改后：
  command = 'npx'
  → 检测内置 Node.js 可用?
    → 是 → 保持 npx，PATH 里的 Node.js 自然接管（所有平台统一）
    → 否 → fallback 到 bun x（向后兼容，理论上不会发生）
```

**核心变化**：不再把 `npx` 强行改写为 `bun x`。让 MCP Server 以 npm 生态原生的方式运行。

> **版本钉死仍然保留**：`pinMcpPackageVersions()` 继续将 `@latest` 替换为钉死版本（如 `@playwright/mcp@0.0.68`），这是性能优化，与运行时选择无关。

### 2.6 MCP 预热策略（index.ts 改动）

当前预热用 `bun x <pkg> --help` 下载缓存 → 改为 `npx -y <pkg> --help`。

因为实际执行也是 `npx`，预热和运行使用同一套 npm cache，行为一致。

### 2.7 node shim 清理

当前 `~/.myagents/shims/node` 是指向 Bun 的 shim（让 agent-browser 的内部 `node` 调用走 Bun）。

引入真实 Node.js 后，这个 shim **可以保留也可以移除**，取决于 agent-browser 的兼容性测试结果：
- 如果 agent-browser 在 Node.js 下运行正常 → 移除 shim，让 `node` 指向真实 Node.js
- 如果 agent-browser 依赖 Bun 特有行为 → 保留 shim，仅在 wrapper 作用域内生效

> 这是一个实施阶段的测试决策，不阻塞主方案。

---

## 3. 需求清单

### P0（必须完成）

| # | 需求 | 改动文件 | 说明 |
|---|------|---------|------|
| 1 | Node.js 二进制打包 | 构建脚本 (`build_macos.sh`, `build_windows.ps1`, `tauri.conf.json`) | 各平台下载 Node.js LTS 二进制，放入 `src-tauri/binaries/`，构建时打入安装包 |
| 2 | Node.js 路径发现 | `src/server/utils/runtime.ts` | 新增 `getBundledNodePath()` / `getBundledNodeDir()`，macOS/Windows 双平台 |
| 3 | PATH 注入 | `src/server/agent-session.ts` — `buildClaudeSessionEnv()` | `essentialPaths` 加入 `bundledNodeDir` |
| 4 | MCP 执行回归 npx | `src/server/agent-session.ts` — `buildSdkMcpServers()` | builtin MCP 不再替换为 `bun x`，保持 `npx`（Node.js 接管） |
| 5 | MCP 预热改 npx | `src/server/index.ts` — `/api/mcp/enable` | 预热命令从 `bun x --help` 改为 `npx -y --help` |
| 6 | 移除 Windows Playwright 临时补丁 | `src/server/agent-session.ts`, `src/server/index.ts` | 本版临时加的 `isPlaywrightOnWin` 特判不再需要，统一走 npx |

### P1（应该完成）

| # | 需求 | 改动文件 | 说明 |
|---|------|---------|------|
| 7 | node shim 策略决策 | `src/server/index.ts` — `writeAgentBrowserWrapper()` | 测试 agent-browser 在真实 Node.js 下的表现，决定 shim 保留或移除 |
| 8 | npm cache 预热 | `src/server/index.ts` — `ensureChromiumInstalled()` | 考虑 Chromium 安装也走 Node.js（`node playwright-core/cli.js install`），避免 Bun postinstall 兼容问题 |
| 9 | 构建脚本自动化 | `setup.sh`, `setup_windows.ps1` | 开发环境 setup 脚本自动下载 Node.js 二进制到 `src-tauri/binaries/` |

### P2（可以推迟）

| # | 需求 | 说明 |
|---|------|------|
| 10 | Plugin Bridge 迁移到 Node.js | 当前 Plugin Bridge 用 Bun 跑，如果社区插件出现更多 Bun 兼容问题，可迁移到 Node.js |
| 11 | OpenClaw 插件安装走 npm | `bun add` → `npm install`，解决 postinstall 被跳过的问题 |
| 12 | Node.js 版本自动更新 | App 升级时检测 bundled Node.js 版本并更新 |

---

## 4. 不变的部分

以下场景 **继续使用 Bun**，不受本次改动影响：

| 场景 | 原因 |
|------|------|
| Bun Sidecar 主进程 | 我们自己的代码，Bun 启动快且行为完全可控 |
| Plugin Bridge 进程 | 我们自己的 bridge 代码，已打过 axios 补丁 |
| `bun add` 安装内部包 | agent-browser 安装是内部行为，不涉及社区 postinstall |
| agent-browser wrapper | 通过 shim 机制隔离，不影响外部环境 |
| `buildClaudeSessionEnv()` 中 Bun 优先 | Bun 仍在 PATH 最高优先位，SDK 内部工具链不受影响 |

---

## 5. 风险与回退

### 5.1 体积增长

安装包增加 ~26-36 MB（压缩后）。如果体积敏感，可考虑：
- 仅打包 `node` 二进制（不含 npm），通过 `node --run` 或直接 `node <script>` 执行
- 但不打包 npm 意味着 `npx` 不可用，需要额外实现包下载逻辑，复杂度大增
- **建议**：打包完整 Node.js 分发（含 npm/npx），体积增量可接受

### 5.2 两个包管理器缓存

Bun 和 npm 各自有独立的包缓存：
- `bun x` 缓存在 `~/.bun/install/cache/`
- `npx` 缓存在 `~/.npm/_npx/`

改为 npx 后，之前 `bun x` 缓存的 MCP 包不会被复用，首次启动各 MCP 会有一次 npm 下载。这是一次性的。

### 5.3 回退方案

如果 Node.js 打包出现问题，`buildSdkMcpServers()` 已有 fallback：当 Node.js 不可用时回退到 `bun x`。现有所有 Bun 相关代码不删除，仅调整优先级。

---

## 6. 验证计划

| 场景 | 验证点 |
|------|--------|
| macOS + Playwright MCP | 浏览器正常启动、可操控、无空白页 |
| Windows + Playwright MCP | 浏览器正常启动（**Issue #29 核心验证**） |
| Windows + `--user-data-dir` + 非正常关闭后重启 | 无 "要恢复页面吗" 阻塞 |
| AI Bash 工具执行 `node -v` | 返回内置 Node.js 版本 |
| AI Bash 工具执行 `npx cowsay hello` | 正常下载执行 |
| DuckDuckGo MCP (uvx) | 不受影响，仍走原路径 |
| agent-browser 浏览器自动化 | 正常工作，不受 Node.js 引入影响 |
| 全新安装（无 npm cache） | MCP 启用 → 预热 → 正常工作 |
| 离线环境 | Sidecar / 基础聊天正常（不依赖 Node.js 下载） |
| 安装包体积 | macOS DMG < 220 MB，Windows NSIS < 200 MB |
