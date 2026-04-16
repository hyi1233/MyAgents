// Cross-Runtime Workspace Instructions (v0.1.68)
//
// Reads Claude-protocol workspace files (CLAUDE.md, .claude/rules/*.md, AGENTS.md)
// and formats them for injection into external runtimes (Codex, Gemini).
//
// Format is replicated from Claude Code's getClaudeMds() in utils/claudemd.ts:
//   "Contents of {absolutePath} (project instructions, checked into the codebase):\n\n{content}"
//
// Design:
//   - Codex: CLAUDE.md discovered natively via `-c project_doc_fallback_filenames=["CLAUDE.md"]`;
//            only .claude/rules/*.md injected through developerInstructions
//   - Gemini: chain fallback (GEMINI.md present → skip; else CLAUDE.md + rules; else AGENTS.md)
//            injected through GEMINI_SYSTEM_MD merge
//   - Zero external config file modification

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';

// ─── Constants (replicated from Claude Code utils/claudemd.ts) ───

const MEMORY_INSTRUCTION_PROMPT =
  'Codebase and user instructions are shown below. Be sure to adhere to these instructions. ' +
  'IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.';

const PROJECT_DESCRIPTION = '(project instructions, checked into the codebase)';

// ─── Types ───

interface WorkspaceInstruction {
  path: string;     // absolute path
  content: string;  // trimmed content
}

// ─── File reading helpers ───

/** Read a single file if it exists and is non-empty. */
function readIfExists(filePath: string): WorkspaceInstruction | null {
  try {
    if (!existsSync(filePath)) return null;
    const stat = statSync(filePath);
    if (!stat.isFile()) return null;
    const content = readFileSync(filePath, 'utf-8').trim();
    if (!content) return null;
    return { path: filePath, content };
  } catch {
    return null;
  }
}

/**
 * Recursively collect .md files from a rules directory.
 * Mirrors Claude Code's processMdRules() — recurse subdirs, sort by name for determinism.
 */
function collectRuleFiles(dir: string, out: WorkspaceInstruction[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // ENOENT / EACCES — silently skip
  }
  entries.sort();
  for (const name of entries) {
    const full = join(dir, name);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) {
        collectRuleFiles(full, out);
      } else if (stat.isFile() && extname(name).toLowerCase() === '.md') {
        const content = readFileSync(full, 'utf-8').trim();
        if (content) out.push({ path: full, content });
      }
    } catch {
      // skip unreadable entries
    }
  }
}

// ─── Core read functions ───

/**
 * Read CLAUDE.md + .claude/CLAUDE.md + .claude/rules/*.md from a workspace.
 */
function readClaudeWorkspaceInstructions(workspacePath: string): WorkspaceInstruction[] {
  const instructions: WorkspaceInstruction[] = [];

  // CLAUDE.md at project root
  const claudeMd = readIfExists(join(workspacePath, 'CLAUDE.md'));
  if (claudeMd) instructions.push(claudeMd);

  // .claude/CLAUDE.md (Claude Code also checks this location)
  const dotClaudeMd = readIfExists(join(workspacePath, '.claude', 'CLAUDE.md'));
  if (dotClaudeMd) instructions.push(dotClaudeMd);

  // .claude/rules/*.md (recursive)
  collectRuleFiles(join(workspacePath, '.claude', 'rules'), instructions);

  return instructions;
}

/**
 * Read only .claude/rules/*.md (for Codex — CLAUDE.md itself is loaded natively via -c flag).
 */
function readClaudeRulesOnly(workspacePath: string): WorkspaceInstruction[] {
  const rules: WorkspaceInstruction[] = [];
  collectRuleFiles(join(workspacePath, '.claude', 'rules'), rules);
  return rules;
}

/**
 * Read AGENTS.md from a workspace root.
 */
function readAgentsMd(workspacePath: string): WorkspaceInstruction[] {
  const agentsMd = readIfExists(join(workspacePath, 'AGENTS.md'));
  return agentsMd ? [agentsMd] : [];
}

// ─── Formatting (replicates Claude Code getClaudeMds() output) ───

/**
 * Format instruction files into the Claude Code getClaudeMds() text format.
 *
 * Output:
 *   Codebase and user instructions are shown below. ...
 *
 *   Contents of /abs/path/CLAUDE.md (project instructions, checked into the codebase):
 *
 *   <file content>
 *
 *   Contents of /abs/path/.claude/rules/foo.md (project instructions, checked into the codebase):
 *
 *   <file content>
 */
function formatInstructions(instructions: WorkspaceInstruction[]): string {
  if (instructions.length === 0) return '';

  const blocks = instructions.map(
    ({ path, content }) => `Contents of ${path} ${PROJECT_DESCRIPTION}:\n\n${content}`,
  );

  return `${MEMORY_INSTRUCTION_PROMPT}\n\n${blocks.join('\n\n')}`;
}

// ─── Runtime-specific resolvers ───

/**
 * Codex: resolve .claude/rules/*.md for developerInstructions injection.
 * CLAUDE.md itself is handled by Codex's native file discovery via
 * `-c 'project_doc_fallback_filenames=["CLAUDE.md"]'` CLI arg.
 */
export function resolveCodexWorkspaceInstructions(workspacePath: string): string {
  const rules = readClaudeRulesOnly(workspacePath);
  return formatInstructions(rules);
}

/**
 * Gemini: chain fallback for GEMINI_SYSTEM_MD injection.
 *
 * Priority:
 *   1. GEMINI.md exists → return '' (Gemini loads it natively, avoid duplication)
 *   2. CLAUDE.md exists → inject CLAUDE.md + .claude/CLAUDE.md + .claude/rules/*.md
 *   3. AGENTS.md exists → inject AGENTS.md
 *   4. None found → return ''
 */
export function resolveGeminiWorkspaceInstructions(workspacePath: string): string {
  // 1. GEMINI.md present → Gemini native, skip
  if (existsSync(join(workspacePath, 'GEMINI.md'))) {
    return '';
  }

  // 2. CLAUDE.md present → full Claude protocol
  const claudeInstructions = readClaudeWorkspaceInstructions(workspacePath);
  if (claudeInstructions.length > 0) {
    return formatInstructions(claudeInstructions);
  }

  // 3. AGENTS.md present → Codex protocol
  const agentsInstructions = readAgentsMd(workspacePath);
  if (agentsInstructions.length > 0) {
    return formatInstructions(agentsInstructions);
  }

  // 4. Nothing found
  return '';
}
