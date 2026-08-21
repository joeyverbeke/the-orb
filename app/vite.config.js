import { defineConfig } from 'vite';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

// Multi-page, not a router: every experiment is its own document, so one
// experiment failing to compile or blowing up the GPU cannot take the others
// with it. Dropping a folder into experiments/ is all it takes to add one --
// this scan picks it up, and the homepage discovers its meta.js the same way.
function pages() {
  const input = { home: resolve(root, 'index.html') };
  const dir = resolve(root, 'experiments');
  if (!existsSync(dir)) return input;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const html = resolve(dir, entry.name, 'index.html');
    if (existsSync(html)) input[entry.name] = html;
  }
  return input;
}

export default defineConfig({
  server: { port: 5173, strictPort: true },
  build: {
    // WebGPU and TSL rely on modern syntax; don't down-level it.
    target: 'esnext',
    rollupOptions: { input: pages() },
  },
});
