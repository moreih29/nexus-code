import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      // vitest는 Node 런타임에서 실행되므로 bun:sqlite를 better-sqlite3로 대체
      'bun:sqlite': resolve(__dirname, 'src/__vitest__/bun-sqlite-shim.ts'),
    },
  },
  test: {
    environment: 'node',
  },
})
