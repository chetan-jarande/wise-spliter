#!/usr/bin/env node
/**
 * Wise-Spliter Full-Stack Development Orchestrator
 * Spawns both:
 *   1. Backend API Server (`bun run src/server/index.ts` on API_PORT=4174)
 *   2. Frontend Vite Server (`bun run dev:web --port APP_PORT=4173`)
 * Cleanly terminates both child processes on SIGINT / SIGTERM.
 */

import { spawn } from 'node:child_process';

const cliArgs = process.argv.slice(2);
const portFlagIdx = cliArgs.indexOf('--port');
const cliPort =
  portFlagIdx >= 0 && cliArgs[portFlagIdx + 1]
    ? cliArgs[portFlagIdx + 1]
    : null;

const APP_PORT = cliPort || process.env.APP_PORT || process.env.PORT || '4173';
const API_PORT = process.env.API_PORT || '4174';

const children = [];
let shuttingDown = false;

function spawnService(label, cmd, args, extraEnv = {}) {
  const proc = spawn(cmd, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      APP_PORT,
      API_PORT,
      VITE_API_BASE_URL:
        process.env.VITE_API_BASE_URL || `http://127.0.0.1:${API_PORT}`,
      ...extraEnv,
    },
  });

  proc.on('exit', (code, signal) => {
    if (!shuttingDown && code !== 0 && code !== null) {
      console.error(`[dev-stack] ${label} exited with code ${code} (${signal ?? 'no signal'})`);
      shutdown(code);
    }
  });

  children.push(proc);
  return proc;
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      // Ignore already exited child
    }
  }
  setTimeout(() => process.exit(exitCode), 250);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log(
  `[dev-stack] Starting Wise-Spliter API (:${API_PORT}) + Frontend (:${APP_PORT})...`
);

spawnService('api', 'bun', ['run', 'src/server/index.ts']);
spawnService('web', 'bun', ['run', 'dev:web', '--port', String(APP_PORT)]);
