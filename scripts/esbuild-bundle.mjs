// Cross-platform esbuild driver for the three Node bundles we ship
// (server, plugin-bridge, CLI). Replaces the inline `npm run build:*`
// commands that used `--banner:js='...'` with embedded single quotes —
// that worked under bash/zsh on macOS/Linux but broke under Windows
// `cmd.exe`, which doesn't recognise single quotes and split the banner
// arg on spaces, surfacing as:
//
//   ✘ ERROR  Must use "outdir" when there are multiple input files
//
// Using esbuild's JS API removes the shell-quoting hazard entirely and
// gives us one source of truth for the build config (entry, banner,
// format, externals, sourcemap).

import { build } from 'esbuild';

// Banner content kept as plain string literals here — no shell parsing
// involved, so single/double quotes mean what they say.
const ESM_INTEROP_BANNER =
  'import { createRequire } from "module"; const require = createRequire(import.meta.url);';
const CLI_SHEBANG_BANNER = '#!/usr/bin/env node';

const TARGETS = {
  server: {
    entryPoints: ['src/server/index.ts'],
    outfile: 'src-tauri/resources/server-dist.js',
    format: 'esm',
    sourcemap: true,
    banner: { js: ESM_INTEROP_BANNER },
  },
  bridge: {
    entryPoints: ['src/server/plugin-bridge/index.ts'],
    outfile: 'src-tauri/resources/plugin-bridge-dist.js',
    format: 'esm',
    sourcemap: true,
    banner: { js: ESM_INTEROP_BANNER },
    external: ['openclaw'],
  },
  cli: {
    entryPoints: ['src/cli/myagents.ts'],
    outfile: 'src-tauri/resources/cli/myagents.js',
    format: 'cjs',
    sourcemap: false,
    banner: { js: CLI_SHEBANG_BANNER },
  },
};

const targetName = process.argv[2];
const cfg = TARGETS[targetName];
if (!cfg) {
  const known = Object.keys(TARGETS).join(', ');
  console.error(`Usage: node scripts/esbuild-bundle.mjs <${known}>`);
  process.exit(1);
}

await build({
  bundle: true,
  platform: 'node',
  target: 'node22',
  ...cfg,
});

console.log(`✓ ${targetName} → ${cfg.outfile}`);
