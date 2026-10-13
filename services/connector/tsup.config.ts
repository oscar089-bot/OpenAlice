import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { connector: 'src/main.ts' },
  format: ['cjs'],
  outDir: 'dist',
  target: 'es2023',
  platform: 'node',
  // esbuild merges every module into one scope, so a class whose name collides
  // (e.g. abort-controller's AbortSignal) is renamed to AbortSignal2. Libraries
  // that identify objects by constructor.name then break: node-fetch's
  // isAbortSignal() compares proto.constructor.name to 'AbortSignal', so
  // grammY's polling requests throw "Expected signal to be an instanceof
  // AbortSignal". keepNames preserves the original class/function names.
  keepNames: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  // Connector Service is a separately supervised deployable. Bundle its JS
  // SDKs (discord.js / grammY / Slack / Feishu / Hono / protocol) so Docker and Electron do not
  // depend on pnpm workspace symlinks surviving prune/package collection.
  noExternal: [/.*/],
  outExtension: () => ({ js: '.cjs' }),
  esbuildOptions: (options) => {
    // Setting `conditions` REPLACES esbuild's platform defaults, dropping the
    // implicit "node" condition. grammY then resolves to its browser build
    // (out/web.mjs), which pulls in node-fetch's XMLHttpRequest build and
    // fails every request under Node ("Network request failed"), surfacing as
    // a misleading 30s Telegram readiness timeout. Always keep "node".
    options.conditions = ['node', 'openalice-source', ...(options.conditions ?? [])]
  },
})
