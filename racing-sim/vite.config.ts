import { execSync } from 'node:child_process';
import { defineConfig } from 'vitest/config';

/** The build's version for the viewer: last commit, its date, and whether the tree had changes. */
function version(): string {
  const git = (cmd: string) => { try { return execSync(`git ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };
  const hash = git('rev-parse --short HEAD');
  if (!hash) return `built ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
  const date = git('log -1 --format=%cd --date=format:%Y-%m-%d\\ %H:%M');
  const dirty = git('status --porcelain -- .') ? ' +changes' : '';
  return `${hash} · ${date}${dirty}`;
}

export default defineConfig({
  server: { port: 5173 },
  define: { __VERSION__: JSON.stringify(version()) },
  test: {
    include: ['tests/**/*.test.ts'],
    reporters: ['dot'],
  },
});
