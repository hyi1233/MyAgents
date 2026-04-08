import { execSync } from 'child_process';
import { join } from 'path';
import { readdirSync, existsSync } from 'fs';

const isWindows = process.platform === 'win32';
const PATH_SEPARATOR = isWindows ? ';' : ':';
const PATH_KEY = isWindows ? 'Path' : 'PATH';

/**
 * Common binary paths for the current platform
 */
function getFallbackPaths(): string[] {
    if (isWindows) {
        const userProfile = process.env.USERPROFILE || '';
        const localAppData = process.env.LOCALAPPDATA || '';
        const programFiles = process.env.PROGRAMFILES || '';

        return [
            userProfile ? join(userProfile, '.bun', 'bin') : '',
            localAppData ? join(localAppData, 'bun', 'bin') : '',
            programFiles ? join(programFiles, 'nodejs') : '',
            userProfile ? join(userProfile, 'AppData', 'Roaming', 'npm') : '',
            // Git for Windows — SDK requires git; PATH may be stale after NSIS install
            programFiles ? join(programFiles, 'Git', 'cmd') : '',
            join(process.env['PROGRAMFILES(X86)'] || '', 'Git', 'cmd'),
            localAppData ? join(localAppData, 'Programs', 'Git', 'cmd') : '',
        ].filter(Boolean);
    }

    // macOS/Linux paths — cover common package managers and version managers.
    // GUI apps don't inherit shell PATH, so we enumerate known binary directories.
    const home = process.env.HOME;
    const paths = [
        '/opt/homebrew/bin',        // macOS Apple Silicon homebrew
        '/usr/local/bin',           // macOS Intel homebrew / Linux system
        home ? `${home}/.local/bin` : '',          // Claude Code / pipx / XDG user-local
        home ? `${home}/.bun/bin` : '',            // Bun global installs
        home ? `${home}/.npm-global/bin` : '',     // npm custom global prefix
        home ? `${home}/.cargo/bin` : '',          // Rust / cargo installs
        home ? `${home}/.volta/bin` : '',          // Volta (Node version manager)
        home ? `${home}/Library/pnpm` : '',        // pnpm (macOS)
    ];

    // Attempt to resolve NVM path manually if exists
    if (process.env.HOME) {
        const nvmDir = join(process.env.HOME, '.nvm', 'versions', 'node');
        if (existsSync(nvmDir)) {
            try {
                const versions = readdirSync(nvmDir)
                    .filter(v => v.startsWith('v'))
                    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

                if (versions.length > 0) {
                    const nvmBin = join(nvmDir, versions[0], 'bin');
                    paths.push(nvmBin);
                    console.log('[shell] Found NVM node path:', nvmBin);
                }
            } catch (e) {
                console.warn('[shell] Failed to resolve NVM paths:', e);
            }
        }

        const homeDir = process.env.HOME!; // narrowed by if-guard above

        // fnm (Fast Node Manager) — ~/.local/share/fnm/aliases/default/bin
        const fnmDir = join(homeDir, '.local', 'share', 'fnm', 'aliases', 'default', 'bin');
        if (existsSync(fnmDir)) paths.push(fnmDir);

        // asdf version manager — ~/.asdf/shims
        const asdfDir = join(homeDir, '.asdf', 'shims');
        if (existsSync(asdfDir)) paths.push(asdfDir);

        // mise (formerly rtx) — ~/.local/share/mise/shims
        const miseDir = join(homeDir, '.local', 'share', 'mise', 'shims');
        if (existsSync(miseDir)) paths.push(miseDir);
    }

    return paths.filter(Boolean);
}

let cachedPath: string | null = null;

/**
 * Detects the user's full shell PATH.
 * Essential for GUI apps (like Tauri) on macOS which don't inherit the user's shell environment.
 */
export function getShellPath(): string {
    if (cachedPath) return cachedPath;

    const fallback = getFallbackPaths().join(PATH_SEPARATOR);

    // On Windows, just use existing PATH with fallback paths prepended
    if (isWindows) {
        const existing = process.env[PATH_KEY] || process.env.PATH || '';
        cachedPath = existing ? `${fallback}${PATH_SEPARATOR}${existing}` : fallback;
        console.log('[shell] Windows PATH configured');
        return cachedPath;
    }

    // macOS/Linux: Try to detect shell PATH
    try {
        const shell = process.env.SHELL || '/bin/zsh';
        const detectedPath = execSync(`${shell} -l -c 'echo $PATH'`, {
            encoding: 'utf-8',
            timeout: 2000,
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();

        if (detectedPath && detectedPath.length > 10) {
            console.log('[shell] Detected user PATH via shell');
            cachedPath = `${fallback}${PATH_SEPARATOR}${detectedPath}`;
            console.log('[shell] Final Merged PATH:', cachedPath);
            return cachedPath;
        }
    } catch (error) {
        console.warn('[shell] Failed to detect shell PATH via spawn:', error);
    }

    // Fallback
    console.log('[shell] Using fallback PATH construction ONLY');
    const existing = process.env[PATH_KEY] || process.env.PATH || '';
    cachedPath = existing ? `${fallback}${PATH_SEPARATOR}${existing}` : fallback;
    console.log('[shell] Fallback PATH:', cachedPath);
    return cachedPath!;
}

/**
 * Returns an environment object with the corrected PATH
 */
export function getShellEnv(): Record<string, string> {
    const path = getShellPath();
    const env = { ...process.env } as Record<string, string>;
    // Ensure single PATH key — Windows env may have Path or PATH;
    // spreading process.env into a plain object loses case-insensitivity,
    // so both casings can coexist and confuse child_process.spawn().
    delete env.PATH;
    delete env.Path;
    env[PATH_KEY] = path;
    return env;
}
