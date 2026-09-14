const getProxyUrl = proxy => proxy ? `http://${proxy.host}:${proxy.port}` : undefined

/** Download a small metadata image through Bun's native fetch and file writer. */
module.exports = async (url, filePath, proxy) => {
  try {
    const options = { redirect: 'follow' }
    const proxyUrl = getProxyUrl(proxy)
    if (proxyUrl) options.proxy = proxyUrl

    const response = await fetch(url, options)
    if (response.status !== 200 && response.status !== 206) return false
    await Bun.write(filePath, response)
    return true
  } catch (error) {
    console.warn(`[MusicMeta] image download failed: ${error?.message || error}`)
    try { await Bun.file(filePath).delete() } catch { }
    return false
  }
}
