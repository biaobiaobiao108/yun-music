import { marked } from 'marked'

const BLOCKED_TAGS = 'script, iframe, object, embed, frame, frameset, form, link, meta, base, style'

/** Render trusted project markdown without allowing executable markup or unsafe URLs. */
export function renderSafeMarkdown(markdown: string): string {
  const template = document.createElement('template')
  template.innerHTML = String(marked.parse(String(markdown ?? '')))
  template.content.querySelectorAll(BLOCKED_TAGS).forEach(element => element.remove())
  template.content.querySelectorAll('*').forEach(element => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on') || name === 'style') {
        element.removeAttribute(attribute.name)
        continue
      }
      if (!['href', 'src', 'xlink:href', 'action', 'formaction'].includes(name)) continue
      try {
        const url = new URL(attribute.value, window.location.origin)
        if (!['http:', 'https:'].includes(url.protocol)) element.removeAttribute(attribute.name)
      } catch {
        element.removeAttribute(attribute.name)
      }
    }
  })
  return template.innerHTML
}
