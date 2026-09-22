import fs from 'fs'
import path from 'path'

const projectRoot = path.resolve(import.meta.dir, '..')
const sourcePath = path.join(projectRoot, 'frontend/shared/assets/fontawesome/all.min.css')
const targetPath = path.join(projectRoot, 'public/music/assets/fontawesome/css/solid-subset.min.css')
const unusedPublishedFontFiles = [
  'fa-brands-400.ttf',
  'fa-brands-400.woff2',
  'fa-regular-400.woff2',
  'fa-solid-900.ttf',
].map(file => path.join(projectRoot, 'public/music/assets/fontawesome/webfonts', file))

const fallbackIconNames = [
  'arrow-down', 'arrow-left', 'arrow-right', 'backward-step', 'bars', 'bolt', 'broom',
  'chart-line', 'check', 'chevron-down', 'chevron-left', 'chevron-right', 'chevron-up',
  'circle-check', 'circle-info', 'circle-user', 'circle-xmark', 'clock', 'clock-rotate-left',
  'cloud-arrow-down', 'cloud-rain', 'comments', 'compact-disc', 'database', 'download',
  'ellipsis', 'expand', 'eye', 'eye-slash', 'file-code', 'file-lines', 'file-zipper',
  'floppy-disk', 'folder-open', 'forward-step', 'gear', 'hard-drive', 'heart', 'home',
  'inbox', 'leaf', 'list', 'list-music', 'list-ul', 'lock', 'magnifying-glass', 'memory',
  'microchip', 'moon', 'music', 'pause', 'pen', 'play', 'plug', 'plus', 'repeat',
  'right-left', 'right-to-bracket', 'rotate', 'search', 'shield-halved', 'spinner', 'sun',
  'shuffle', 'trash', 'triangle-exclamation', 'user', 'user-plus', 'users', 'volume-high',
  'volume-low', 'volume-xmark', 'xmark', 'fire', 'right-from-bracket',
]

function addStringLiterals(value: string, names: Set<string>): void {
  for (const match of value.matchAll(/["']([a-z0-9-]+)["']/g)) names.add(match[1])
}

function collectSourceIconNames(): Set<string> {
  const names = new Set(fallbackIconNames)
  for (const sourceRoot of ['frontend/player/src', 'frontend/admin/src']) {
    const files = new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: path.join(projectRoot, sourceRoot), absolute: true })
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8')
      for (const match of source.matchAll(/\bIcon\s+name\s*=\s*["']([a-z0-9-]+)["']/g)) names.add(match[1])
      for (const match of source.matchAll(/\bIcon\s+name\s*=\s*\{([^}\n]+)\}/g)) addStringLiterals(match[1], names)
      for (const match of source.matchAll(/\bicon\s*(?::\s*[^=;]+)?=\s*([^;\n]+)/g)) addStringLiterals(match[1], names)
      for (const match of source.matchAll(/\bicon\s*:\s*["']([a-z0-9-]+)["']/g)) names.add(match[1])
    }
  }
  return names
}

function buildSubset(source: string, iconNames: Set<string>): string {
  const firstIconRule = source.indexOf('.fa-0:before')
  const brandSection = source.indexOf(':root', firstIconRule)
  const solidFontFace = '@font-face{font-family:"Font Awesome 6 Free";font-style:normal;font-weight:900;font-display:block;src:url(../webfonts/fa-solid-900.woff2) format("woff2")}.fa-solid,.fas{font-weight:900}'
  if (firstIconRule < 0 || brandSection < 0) throw new Error('Font Awesome CSS structure is not recognized')

  const base = source.slice(0, firstIconRule)
  const solidRules = source.slice(firstIconRule, brandSection)
    .split('}')
    .filter(rule => rule.includes(':before') && [...iconNames].some(name => new RegExp(`(?:^|,)\\.fa-${name}:before`).test(rule)))
    .map(rule => `${rule}}`)
    .join('')

  return `${base}${solidRules}${solidFontFace}\n`
}

if (!fs.existsSync(sourcePath)) throw new Error(`Font Awesome source not found: ${sourcePath}`)
const source = fs.readFileSync(sourcePath, 'utf8')
const iconNames = collectSourceIconNames()
const subset = buildSubset(source, iconNames)
const current = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : ''
if (current !== subset) fs.writeFileSync(targetPath, subset)
for (const file of unusedPublishedFontFiles) {
  if (fs.existsSync(file)) fs.rmSync(file, { force: true })
}
console.log(`[Font Awesome] solid subset ready (${iconNames.size} icons, ${(Buffer.byteLength(subset) / 1024).toFixed(1)}KB)`)
