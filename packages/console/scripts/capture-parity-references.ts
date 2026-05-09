import { existsSync } from 'node:fs';
import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, '..');
const defaultDesignDir = '/tmp/penumbra-design-new/penumbra-v3/project';
const designDir = process.env.PENUMBRA_DESIGN_DIR ?? defaultDesignDir;
const designRoot = resolve(designDir);
const targetDir = resolve(packageDir, 'e2e', 'parity-baselines');
const snapshotDir = resolve(packageDir, 'e2e', 'parity.spec.ts-snapshots');
const views = ['mission', 'chains', 'tasks'] as const;

async function main(): Promise<void> {
  const htmlPath = join(designRoot, 'penumbra-console.html');
  if (!existsSync(htmlPath)) {
    console.warn(`[parity:capture] missing design source: ${htmlPath}`);
    process.exit(0);
  }

  const server = await startServer();
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });

  try {
    await page.goto(`http://127.0.0.1:${server.port}/penumbra-console.html`);
    await page.getByRole('heading', { name: 'Mission Control' }).waitFor({ timeout: 15_000 });
    await disableAnimations(page);

    await mkdir(targetDir, { recursive: true });
    await mkdir(snapshotDir, { recursive: true });

    for (const view of views) {
      const label = view === 'mission' ? 'mission control' : view;
      await page.getByRole('button', { name: label, exact: false }).click();
      await page.waitForTimeout(300);
      await page.screenshot({ fullPage: true, path: join(targetDir, `${view}.png`) });
      await copyFile(join(targetDir, `${view}.png`), join(snapshotDir, `${view}-chromium-darwin.png`));
      console.log(`[parity:capture] wrote ${view}`);
    }
  } finally {
    await browser.close();
    server.stop();
  }
}

async function startServer(): Promise<{ port: number; stop: () => void }> {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      if (request.method === 'OPTIONS') {
        return cors(new Response(null, { status: 204 }));
      }

      const url = new URL(request.url);
      const relPath = url.pathname === '/' ? '/penumbra-console.html' : url.pathname;
      const filePath = resolve(designRoot, `.${relPath}`);

      if (!filePath.startsWith(`${designRoot}${sep}`) && filePath !== designRoot) {
        return cors(new Response('forbidden', { status: 403 }));
      }

      try {
        const body = await readFile(filePath);
        return cors(new Response(body, { headers: { 'content-type': contentType(filePath) } }));
      } catch {
        return cors(new Response('not found', { status: 404 }));
      }
    },
  });

  return { port: server.port, stop: () => server.stop() };
}

function cors(response: Response): Response {
  response.headers.set('access-control-allow-origin', '*');
  response.headers.set('access-control-allow-methods', 'GET,HEAD,OPTIONS');
  response.headers.set('access-control-allow-headers', '*');
  return response;
}

function contentType(filePath: string): string {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js') || filePath.endsWith('.jsx')) return 'text/javascript; charset=utf-8';
  return 'application/octet-stream';
}

async function disableAnimations(page: Page): Promise<void> {
  await page.addStyleTag({
    content:
      '* { animation: none !important; transition: none !important; caret-color: transparent !important; }',
  });
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
