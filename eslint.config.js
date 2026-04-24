import { fileURLToPath } from 'node:url';
import { includeIgnoreFile } from '@eslint/compat';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import eslintComments from 'eslint-plugin-eslint-comments';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig } from 'eslint/config';
import ts from 'typescript-eslint';

const gitignorePath = fileURLToPath(new URL('./.gitignore', import.meta.url));

export default defineConfig(
  includeIgnoreFile(gitignorePath),
  {
    // Additional ignore patterns for build output and bundled resources
    ignores: ['**/out/**', '**/dist/**', '**/.vite/**', '**/coverage/**', '**/.eslintcache', 'bundled-skills/**', '**/sdk-shim/**']
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  prettier,
  {
    plugins: {
      'eslint-comments': eslintComments,
      react,
      'react-hooks': reactHooks
    }
  },
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  // Renderer process (Browser + React environment)
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
        ecmaFeatures: {
          jsx: true
        }
      },
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly'
      }
    },
    rules: {
      ...react.configs.recommended.rules,
      ...react.configs['jsx-runtime'].rules,
      ...reactHooks.configs.recommended.rules,
      'react/prop-types': 'off' // Using TypeScript for prop validation
    }
  },
  // Global rules for all files
  {
    rules: {
      // TypeScript rules
      'no-undef': 'off', // TypeScript handles this
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ],
      // Prevent disabling the no-explicit-any rule via inline comments
      'eslint-comments/no-restricted-disable': ['error', '@typescript-eslint/no-explicit-any']
    }
  },
  // Structural guard: builtin MCP tool files MUST NOT eager-import the SDK
  // or zod at module top (value imports only — `import type { ... }` is
  // erased at compile time and is fine). Value imports from these modules
  // must be loaded inside `createXxxServer()` via `await import(...)` so
  // the Sidecar cold-start singleton-creation tax (~500-1000ms) stays
  // deferred. Enforces the "Pit of success" convention codified in
  // CLAUDE.md 补充禁止事项 and builtin-mcp-meta.ts header.
  //
  // Uses @typescript-eslint/no-restricted-imports (not the base rule) so
  // that `allowTypeImports: true` lets us keep type-only imports zero-cost.
  {
    files: ['src/server/tools/*.ts'],
    ignores: ['src/server/tools/builtin-mcp-registry.ts', 'src/server/tools/builtin-mcp-meta.ts'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@anthropic-ai/claude-agent-sdk',
              message: "Value-import inside createXxxServer() via `await import('@anthropic-ai/claude-agent-sdk')`. `import type { ... }` at module top is OK. See CLAUDE.md 补充禁止事项.",
              allowTypeImports: true
            },
            {
              name: 'zod',
              message: "Value-import inside createXxxServer() via `await import('zod/v4')`. `import type { ... }` at module top is OK.",
              allowTypeImports: true
            },
            {
              name: 'zod/v4',
              message: "Value-import inside createXxxServer() via `await import('zod/v4')`. `import type { ... }` at module top is OK.",
              allowTypeImports: true
            }
          ]
        }
      ]
    }
  }
);
