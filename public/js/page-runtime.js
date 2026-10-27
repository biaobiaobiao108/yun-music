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
    window.addEventListener(
      'load',
      () => {
        navigator.serviceWorker.register(new URL('sw.js', document.baseURI)).catch(() => undefined)
      },
      { once: true },
    )
  }
})()
