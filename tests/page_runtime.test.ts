import { expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { runInNewContext } from 'vm'

const source = readFileSync(new URL('../frontend/shared/src/page-runtime.js', import.meta.url), 'utf8')

async function runPage(options: { userAgent: string; player: boolean; scope?: string; controlled?: boolean }) {
  const expectedScope = 'https://example.com/music/'
  let reloads = 0
  let unregistered = 0
  let registered = 0
  let load: (() => void) | undefined
  const registration = options.scope
    ? {
        scope: options.scope,
        unregister: async () => {
          unregistered++
          return true
        },
      }
    : undefined
  const serviceWorker = {
    controller: options.controlled ? { scriptURL: `${expectedScope}sw.js` } : null,
    getRegistration: async () => registration,
    register: async () => {
      registered++
    },
  }
  const document = {
    baseURI: expectedScope,
    currentScript: { hasAttribute: () => options.player },
    querySelector: () => ({}),
  }
  const window = {
    location: {
      pathname: '/music/',
      reload: () => {
        reloads++
      },
    },
    addEventListener: (_name: string, handler: () => void) => {
      load = handler
    },
  }
  runInNewContext(source, {
    document,
    window,
    navigator: { userAgent: options.userAgent, serviceWorker },
    URL,
    console,
  })
  load?.()
  await new Promise(resolve => setTimeout(resolve, 0))
  return { reloads, unregistered, registered }
}

const safari = 'Mozilla/5.0 AppleWebKit/605.1.15 Version/27.2 Safari/605.1.15'
const chrome = 'Mozilla/5.0 AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36'

test('Safari player unregisters its existing worker and reloads once if controlled', async () => {
  expect(
    await runPage({ userAgent: safari, player: true, scope: 'https://example.com/music/', controlled: true }),
  ).toEqual({ reloads: 1, unregistered: 1, registered: 0 })
  expect(await runPage({ userAgent: safari, player: true })).toEqual({ reloads: 0, unregistered: 0, registered: 0 })
})

test('does not unregister another scope, and retains workers for Chrome and the admin page', async () => {
  expect(await runPage({ userAgent: safari, player: true, scope: 'https://example.com/' })).toEqual({
    reloads: 0,
    unregistered: 0,
    registered: 0,
  })
  expect(await runPage({ userAgent: chrome, player: true })).toEqual({ reloads: 0, unregistered: 0, registered: 1 })
  expect(await runPage({ userAgent: safari, player: false })).toEqual({ reloads: 0, unregistered: 0, registered: 1 })
})
