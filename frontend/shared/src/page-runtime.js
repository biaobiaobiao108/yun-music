;(() => {
  const pathname = window.location.pathname
  const directoryPath = /\/[^/]+\.[^/]+$/.test(pathname) ? pathname.replace(/\/[^/]+$/, '/') : pathname
  const baseHref = directoryPath.endsWith('/') ? directoryPath : `${directoryPath}/`
  if (!document.querySelector('base')) {
    const base = document.createElement('base')
    base.href = baseHref
    document.head.prepend(base)
  }

  if ('serviceWorker' in navigator) {
    // Remove only the workers and caches created by earlier versions of this app.
    const root = new URL('/', location.href)
    const legacyWorkers = new Map([
      [root.href, new URL('sw.js', root).href],
      [new URL('music/', root).href, new URL('music/sw.js', root).href],
    ])
    navigator.serviceWorker
      .getRegistrations()
      .then(async registrations => {
        const controller = navigator.serviceWorker.controller?.scriptURL
        let reload = false
        for (const registration of registrations) {
          const script = legacyWorkers.get(registration.scope)
          if (
            !script ||
            ![registration.active, registration.waiting, registration.installing].some(w => w?.scriptURL === script)
          )
            continue
          if ((await registration.unregister()) && controller === script) reload = true
        }
        if ('caches' in window) {
          try {
            const names = await caches.keys()
            await Promise.all(
              names
                .filter(name => name.startsWith('yun-yin-admin-') || name.startsWith('yun-yin-web-'))
                .map(name => caches.delete(name)),
            )
          } catch (error) {
            console.warn('无法清理旧版离线缓存', error)
          }
        }
        if (reload) window.location.reload()
      })
      .catch(error => console.warn('无法清理旧版离线缓存', error))
  }
})()
