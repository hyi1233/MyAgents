/**
 * Sidecar-side config read/write for Admin API
 *
 * Equivalent to the frontend's appConfigService.ts, but using native fs
 * instead of Tauri plugin-fs. Both read/write the same ~/.myagents/config.json.
 * Atomicity is guaranteed by write-to-tmp → rename pattern.
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, renameSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { getHomeDirOrNull } from './platform';
import type { McpServerDefinition } from '../../renderer/config/types';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getConfigDir(): string {
  const home = getHomeDirOrNull();
  if (!home) throw new Error('Cannot determine home directory');
  return resolve(home, '.myagents');
}

function getConfigPath(): string {
  return resolve(getConfigDir(), 'config.json');
}

function getProjectsPath(): string {
  return resolve(getConfigDir(), 'projects.json');
}

// ---------------------------------------------------------------------------
// Minimal types (mirrors renderer/config/types.ts — only the fields we touch)
// ---------------------------------------------------------------------------

/** Lightweight AppConfig subset used by admin operations */
export interface AdminAppConfig {
  // MCP
  mcpServers?: McpServerDefinition[];
  mcpEnabledServers?: string[];
  mcpServerEnv?: Record<string, Record<string, string>>;
  mcpServerArgs?: Record<string, string[]>;
  // Provider
  defaultProviderId?: string;
  providerApiKeys?: Record<string, string>;
  providerVerifyStatus?: Record<string, { status: string; verifiedAt?: string }>;
  // Agent
  agents?: AgentConfigSlim[];
  // Allow passthrough of all other fields
  [key: string]: unknown;
}

/** Minimal Agent config shape for admin operations */
export interface AgentConfigSlim {
  id: string;
  name: string;
  enabled: boolean;
  workspacePath?: string;
  providerId?: string;
  model?: string;
  channels?: ChannelConfigSlim[];
  [key: string]: unknown;
}

/** Minimal Channel config shape */
export interface ChannelConfigSlim {
  id: string;
  type: string;
  name?: string;
  enabled: boolean;
  botToken?: string;
  feishuAppId?: string;
  feishuAppSecret?: string;
  dingtalkClientId?: string;
  dingtalkClientSecret?: string;
  [key: string]: unknown;
}

/** Minimal Project shape */
export interface ProjectSlim {
  id: string;
  name: string;
  path: string;
  mcpEnabledServers?: string[];
  model?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Config read/write
// ---------------------------------------------------------------------------

export function loadConfig(): AdminAppConfig {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return {};
  }
  const raw = readFileSync(configPath, 'utf-8');
  return JSON.parse(raw) as AdminAppConfig;
}

/**
 * Atomic read-modify-write on config.json.
 * Pattern: read → modify → write .tmp → backup .bak → rename .tmp → target
 */
export function atomicModifyConfig(
  modifier: (config: AdminAppConfig) => AdminAppConfig
): AdminAppConfig {
  const configPath = getConfigPath();
  const configDir = getConfigDir();

  // Ensure directory exists
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  const config = loadConfig();
  const modified = modifier(config);

  const tmpPath = configPath + '.tmp';
  const bakPath = configPath + '.bak';

  writeFileSync(tmpPath, JSON.stringify(modified, null, 2), 'utf-8');
  if (existsSync(configPath)) {
    try { copyFileSync(configPath, bakPath); } catch { /* best-effort backup */ }
  }
  renameSync(tmpPath, configPath);

  return modified;
}

// ---------------------------------------------------------------------------
// Projects read/write
// ---------------------------------------------------------------------------

export function loadProjects(): ProjectSlim[] {
  const path = getProjectsPath();
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as ProjectSlim[];
  } catch {
    return [];
  }
}

export function saveProjects(projects: ProjectSlim[]): void {
  const path = getProjectsPath();
  const tmpPath = path + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(projects, null, 2), 'utf-8');
  renameSync(tmpPath, path);
}

// ---------------------------------------------------------------------------
// MCP helpers (preset + custom merge, matching renderer/config/services/mcpService.ts)
// ---------------------------------------------------------------------------

/** Preset MCP servers — imported at call time to avoid circular deps */
function getPresetMcpServers(): McpServerDefinition[] {
  // Inline the preset list import to avoid pulling in the full types module at module load
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PRESET_MCP_SERVERS } = require('../../renderer/config/types');
    return PRESET_MCP_SERVERS as McpServerDefinition[];
  } catch {
    return [];
  }
}

/**
 * Get all MCP servers (preset + custom), with user env/args overrides applied.
 * Mirrors getAllMcpServers() from mcpService.ts.
 */
export function getAllMcpServers(config?: AdminAppConfig): McpServerDefinition[] {
  const c = config ?? loadConfig();
  const presets = getPresetMcpServers();
  const custom = c.mcpServers ?? [];
  const envOverrides = c.mcpServerEnv ?? {};
  const argsOverrides = c.mcpServerArgs ?? {};

  // Custom servers can override presets with same ID
  const customIds = new Set(custom.map(s => s.id));
  const merged = [
    ...presets.filter(p => !customIds.has(p.id)),
    ...custom,
  ];

  // Apply user env/args overrides
  return merged.map(server => {
    const userEnv = envOverrides[server.id];
    const userArgs = argsOverrides[server.id];
    return {
      ...server,
      ...(userEnv ? { env: { ...(server.env || {}), ...userEnv } } : {}),
      ...(userArgs !== undefined ? { args: userArgs } : {}),
    };
  });
}

/**
 * Get globally enabled MCP server IDs
 */
export function getEnabledMcpServerIds(config?: AdminAppConfig): string[] {
  const c = config ?? loadConfig();
  return c.mcpEnabledServers ?? [];
}

/**
 * Get effective MCP servers for a specific project (global enabled ∩ project enabled)
 */
export function getEffectiveMcpServers(projectPath: string): McpServerDefinition[] {
  const config = loadConfig();
  const allServers = getAllMcpServers(config);
  const globalEnabled = new Set(getEnabledMcpServerIds(config));

  // Find project by path
  const projects = loadProjects();
  const project = projects.find(p => p.path === projectPath);
  const projectEnabled = new Set(project?.mcpEnabledServers ?? []);

  if (projectEnabled.size === 0) return [];

  return allServers.filter(s => globalEnabled.has(s.id) && projectEnabled.has(s.id));
}

// ---------------------------------------------------------------------------
// Provider helpers
// ---------------------------------------------------------------------------

/** Redact sensitive values for display (show first 4 + last 4 chars) */
export function redactSecret(value: string): string {
  if (value.length <= 10) return '****';
  return value.slice(0, 4) + '****' + value.slice(-4);
}
