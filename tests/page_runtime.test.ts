import { expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { runInNewContext } from 'vm'

const source = readFileSync(new URL('../frontend/shared/src/page-runtime.js', import.meta.url), 'utf8')

test('removes only legacy app workers and caches and reloads a controlled page', async () => {
  const removed: string[] = []
  const deletedCaches: string[] = []
  let reloads = 0
  const registrations = [
    { scope: 'https://example.com/', active: { scriptURL: 'https://example.com/sw.js' } },
    { scope: 'https://example.com/music/', active: { scriptURL: 'https://example.com/music/sw.js' } },
    { scope: 'https://example.com/other/', active: { scriptURL: 'https://example.com/other/sw.js' } },
    { scope: 'https://example.com/music/', active: { scriptURL: 'https://example.com/other-worker.js' } },
  ].map(registration => ({
    ...registration,
    unregister: async () => {
      removed.push(registration.active.scriptURL)
      return true
    },
  }))
  const serviceWorker = {
    controller: { scriptURL: 'https://example.com/music/sw.js' },
    getRegistrations: async () => registrations,
  }
  const caches = {
    keys: async () => ['yun-yin-admin-react-1', 'yun-yin-web-react-2', 'unrelated-cache'],
    delete: async (name: string) => {
      deletedCaches.push(name)
      return true
    },
  }
  const location = {
    href: 'https://example.com/music/',
    pathname: '/music/',
    reload: () => {
      reloads++
    },
  }
  const document = { baseURI: location.href, querySelector: () => ({}) }
  runInNewContext(source, {
    document,
    location,
    window: { location, caches },
    navigator: { serviceWorker },
    caches,
    URL,
    console,
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(removed).toEqual(['https://example.com/sw.js', 'https://example.com/music/sw.js'])
  expect(deletedCaches).toEqual(['yun-yin-admin-react-1', 'yun-yin-web-react-2'])
  expect(reloads).toBe(1)
})

test('does not reload an uncontrolled page after cleanup', async () => {
  let reloads = 0
  const location = {
    href: 'https://example.com/music/',
    pathname: '/music/',
    reload: () => {
      reloads++
    },
  }
  const document = { baseURI: location.href, querySelector: () => ({}) }
  const serviceWorker = { controller: null, getRegistrations: async () => [] }
  runInNewContext(source, { document, location, window: { location }, navigator: { serviceWorker }, URL, console })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(reloads).toBe(0)
})
