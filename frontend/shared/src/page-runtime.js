;(() => {
  const pathname = window.location.pathname
  const directoryPath = /\/[^/]+\.[^/]+$/.test(pathname) ? pathname.replace(/\/[^/]+$/, '/') : pathname
  const baseHref = directoryPath.endsWith('/') ? directoryPath : `${directoryPath}/`
  if (!document.querySelector('base')) {
    const base = document.createElement('base')
    base.href = baseHref
    document.head.prepend(base)
  }
})()
