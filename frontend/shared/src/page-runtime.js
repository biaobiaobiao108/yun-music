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
    const userAgent = navigator.userAgent
    const webKit =
      /AppleWebKit/i.test(userAgent) &&
      (/iPhone|iPad|iPod/i.test(userAgent) || !/Chrome|Chromium|Edg|OPR/i.test(userAgent))
    const player = document.currentScript?.hasAttribute('data-player')
    if (player && webKit) {
      // WebKit can delay media requests even when the worker does not intercept them.
      const scope = new URL('.', document.baseURI).href
      navigator.serviceWorker
        .getRegistration(scope)
        .then(async registration => {
          if (!registration || registration.scope !== scope) return
          const controlled = navigator.serviceWorker.controller?.scriptURL === new URL('sw.js', scope).href
          if ((await registration.unregister()) && controlled) window.location.reload()
        })
        .catch(error => console.warn('无法移除播放器 Service Worker', error))
      return
    }
    window.addEventListener(
      'load',
      () => {
        navigator.serviceWorker.register(new URL('sw.js', document.baseURI)).catch(() => undefined)
      },
      { once: true },
    )
  }
})()
