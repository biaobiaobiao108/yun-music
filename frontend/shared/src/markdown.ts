import { marked } from 'marked'

const BLOCKED_TAGS = 'script, iframe, object, embed, frame, frameset, form, link, meta, base, style'
const RESOURCE_ATTRIBUTES = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'poster', 'background'])

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
      if (name === 'srcset' || name === 'imagesrcset') {
        element.removeAttribute(attribute.name)
        continue
      }
      if (!RESOURCE_ATTRIBUTES.has(name)) continue
      try {
        const url = new URL(attribute.value, window.location.origin)
        if (!['http:', 'https:'].includes(url.protocol)) element.removeAttribute(attribute.name)
      } catch {
        element.removeAttribute(attribute.name)
      }
    }
  })
  template.content.querySelectorAll('a[target]').forEach(anchor => {
    const rel = new Set((anchor.getAttribute('rel') || '').split(/\s+/).filter(Boolean))
    rel.add('noopener')
    rel.add('noreferrer')
    anchor.setAttribute('rel', [...rel].join(' '))
  })
  return template.innerHTML
}
