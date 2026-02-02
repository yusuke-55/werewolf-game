import { test, expect } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import path from 'path';

function getRepoRoot(): string {
  // playwright runs from repo root in this project
  return process.cwd();
}

function getTsNodeEntrypoint(): string {
  const root = getRepoRoot();
  // Avoid spawning the Windows .cmd shim (can throw EINVAL in some environments).
  // Run ts-node as a normal JS entrypoint via Node.
  return path.join(root, 'node_modules', 'ts-node', 'dist', 'bin.js');
}

async function startDevServer(): Promise<{ proc: ChildProcessWithoutNullStreams; url: string }> {
  const node = process.execPath;
  const tsNodeEntry = getTsNodeEntrypoint();
  const proc = spawn(node, [tsNodeEntry, 'src/server.ts'], {
    cwd: getRepoRoot(),
    env: {
      ...process.env,
      PORT: '0',
      AUTO_OPEN_BROWSER: '0',
      CI: '1',
    },
  });

  const lines: string[] = [];
  let resolved = false;

  const urlPromise = new Promise<string>((resolve, reject) => {
    const onLine = (line: string) => {
      lines.push(line);
      const m1 = line.match(/Server listening on (http:\/\/localhost:\d+)/);
      const m2 = line.match(/Server listening on fallback port \d+ -> (http:\/\/localhost:\d+)/);
      const url = (m1 && m1[1]) || (m2 && m2[1]);
      if (url && !resolved) {
        resolved = true;
        resolve(url);
      }
    };

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    proc.stdout.on('data', (chunk: string) => {
      chunk
        .replace(/\r\n/g, '\n')
        .split('\n')
        .filter(Boolean)
        .forEach(onLine);
    });

    proc.stderr.on('data', (chunk: string) => {
      chunk
        .replace(/\r\n/g, '\n')
        .split('\n')
        .filter(Boolean)
        .forEach(onLine);
    });

    proc.on('exit', (code) => {
      if (!resolved) {
        reject(new Error(`dev server exited before url was detected (code=${code}). logs:\n${lines.join('\n')}`));
      }
    });

    setTimeout(() => {
      if (!resolved) {
        reject(new Error(`timeout waiting for server url. logs:\n${lines.join('\n')}`));
      }
    }, 30_000);
  });

  const url = await urlPromise;
  return { proc, url };
}

async function runAutoplay(url: string): Promise<ChildProcessWithoutNullStreams> {
  const root = getRepoRoot();
  const node = process.execPath;
  const proc = spawn(node, ['tools/autoplay.js', '--url', url, '--quiet'], {
    cwd: root,
    env: {
      ...process.env,
    },
  });
  return proc;
}

function killProcessTree(proc: ChildProcessWithoutNullStreams | null) {
  if (!proc) return;
  try {
    proc.kill();
  } catch {
    // ignore
  }
}

test('Chrome: start -> autoplay to end -> play again works', async ({ page }) => {
  const server = await startDevServer();
  const baseUrl = server.url;

  let autoplay1: ChildProcessWithoutNullStreams | null = null;
  let autoplay2: ChildProcessWithoutNullStreams | null = null;

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

    // Start screen should be visible
    await expect(page.locator('#startScreen')).toBeVisible();

    // Start game via start screen button
    await page.locator('#startScreenStartBtn').click();

    // Wait until start screen is hidden
    await expect(page.locator('#startScreen')).toBeHidden({ timeout: 60_000 });

    // Autoplay will drive the game via API while we observe UI in Chrome.
    autoplay1 = await runAutoplay(baseUrl);

    // Wait until play-again appears (game ended)
    await expect(page.locator('#playAgainBtn')).toBeVisible({ timeout: 180_000 });

    // Click play-again (regression: used to freeze)
    await page.locator('#playAgainBtn').click();

    // After restart, start screen should stay hidden
    await expect(page.locator('#startScreen')).toBeHidden({ timeout: 60_000 });

    // Ensure the second game actually starts (freeze regression check)
    // We use autoplay again to ensure the game proceeds into day/operation quickly.
    autoplay2 = await runAutoplay(baseUrl);
    await expect(page.locator('#dayInfo')).not.toHaveText('待機中', { timeout: 60_000 });
  } finally {
    killProcessTree(autoplay1);
    killProcessTree(autoplay2);
    killProcessTree(server.proc);
  }
});
