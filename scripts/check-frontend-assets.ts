import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, relative, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..');
const publicRoot = join(repoRoot, 'public');

const htmlFiles = [
  'public/index.html',
  'public/music/index.html',
  'public/music/login.html',
];

const serviceWorkerFiles = [
  'public/sw.js',
  'public/music/sw.js',
];

const deletedResourceNames = [
  'ui-utils.js',
  'tailwindcss.js',
  'tailwind_setup.js',
  'quality.js',
  'idb_store.js',
  'list_search.js',
  'pwa.js',
  'theme_manager.js',
  'ios-background-audio.js',
  'common_ui.js',
  'crypto-js.min.js',
  'Sortable.min.js',
  'NoSleep.min.js',
  'marked.min.js',
  'lyric-utils.js',
  'lyric-parser.js',
  'log_viewer.js',
  'user_sync.js',
  'batch_pagination.js',
  'single_song_ops.js',
  'songlist_manager.js',
  'download_manager.js',
];

const forbiddenDomMigrationPatterns = [
  /data-event-click-action/i,
  /data-admin-action/i,
  /<script[^>]+>[^<]*(?:onclick|onchange|onsubmit)\s*=/is,
];

function readText(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function isExternalResource(value: string): boolean {
  return value.startsWith('http://') ||
    value.startsWith('https://') ||
    value.startsWith('//') ||
    value.startsWith('data:') ||
    value.startsWith('#');
}

function isRuntimeGeneratedResource(value: string): boolean {
  return value === '/js/config.js';
}

function toPublicPath(sourceFile: string, reference: string): string | null {
  const cleanReference = reference.split(/[?#]/, 1)[0];
  if (!cleanReference || isExternalResource(cleanReference)) return null;

  const sourceDirectory = join(repoRoot, sourceFile, '..');
  const absolutePath = cleanReference.startsWith('/')
    ? join(publicRoot, cleanReference.slice(1))
    : resolve(sourceDirectory, cleanReference);

  return normalize(absolutePath);
}

function collectHtmlReferences(file: string): string[] {
  const content = readText(file);
  const references: string[] = [];
  const referencePattern = /<(?:script[^>]+src|link[^>]+href)=["']([^"']+)["']/gi;

  for (const match of content.matchAll(referencePattern)) {
    if (match[1]) references.push(match[1]);
  }

  return references;
}

function collectServiceWorkerReferences(file: string): string[] {
  const content = readText(file);
  const references: string[] = [];

  for (const match of content.matchAll(/["'](\.\/[^"']+)["']/g)) {
    if (match[1] && !match[1].endsWith('/')) references.push(match[1]);
  }

  return references;
}

function collectLazyReferences(): string[] {
  const references: string[] = [];
  const sourceRoot = join(repoRoot, 'frontend');

  function visit(directory: string): void {
    for (const entry of readdirSync(directory)) {
      const entryPath = join(directory, entry);
      if (statSync(entryPath).isDirectory()) {
        visit(entryPath);
        continue;
      }

      if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue;
      const content = readFileSync(entryPath, 'utf8');
      for (const match of content.matchAll(/["'](\/music\/)?(?:js|assets|css)\/[^"']+["']/g)) {
        if (match[0]) references.push(match[0].slice(1, -1));
      }
    }
  }

  visit(sourceRoot);
  return references;
}

function collectTrackedFiles(): Set<string> {
  const result = Bun.spawnSync(['git', 'ls-files'], { cwd: repoRoot });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }

  return new Set(new TextDecoder().decode(result.stdout).split(/\r?\n/).filter(Boolean));
}

const missing: string[] = [];
const deletedReferences: string[] = [];
const checkedReferences = new Set<string>();

for (const file of [...htmlFiles, ...serviceWorkerFiles]) {
  const content = readText(file);
  if (file.endsWith('.html') && forbiddenDomMigrationPatterns.some((pattern) => pattern.test(content))) {
    deletedReferences.push(`${file} -> legacy inline DOM handler`);
  }
  const references = file.endsWith('.html')
    ? collectHtmlReferences(file)
    : collectServiceWorkerReferences(file);

  for (const reference of references) {
    if (isRuntimeGeneratedResource(reference)) continue;
    if (deletedResourceNames.some((name) => reference.endsWith(`/${name}`))) {
      deletedReferences.push(`${file} -> ${reference}`);
      continue;
    }

    const publicPath = toPublicPath(file, reference);
    if (!publicPath) continue;
    checkedReferences.add(publicPath);
    if (!existsSync(publicPath)) {
      missing.push(`${file} -> ${reference}`);
    }
  }
}

for (const reference of collectLazyReferences()) {
  if (deletedResourceNames.some((name) => reference.endsWith(`/${name}`))) {
    deletedReferences.push(`frontend -> ${reference}`);
    continue;
  }

  const cleanReference = reference.replace(/^\/music\//, '').replace(/^\//, '');
  const publicPath = join(publicRoot, 'music', cleanReference);
  checkedReferences.add(publicPath);
  if (!existsSync(publicPath)) {
    missing.push(`frontend -> ${reference}`);
  }
}

const trackedFiles = collectTrackedFiles();
const generatedFiles = [
  'public/app.js',
  'public/music/app.js',
  'public/music/js/vendor-bridge.js',
  'public/music/js/songlist_manager.js',
  'public/music/js/download_manager.js',
  'public/music/js/pitch-shifter/phase-vocoder.js',
  'public/music/login.js',
  'public/music/css/tailwind.generated.css',
];
const trackedGeneratedFiles = generatedFiles.filter((file) => trackedFiles.has(file));
const trackedChunkFiles = [...trackedFiles].filter((file) => file.startsWith('public/music/js/chunks/'));
const trackedHashedEntryFiles = [...trackedFiles].filter((file) => /^public\/(?:music\/)?app-[a-z0-9]+\.js$/i.test(file));
const trackedHashedLoginFiles = [...trackedFiles].filter((file) => /^public\/music\/login-[a-z0-9]+\.js$/i.test(file));

if (missing.length || deletedReferences.length || trackedGeneratedFiles.length || trackedChunkFiles.length || trackedHashedEntryFiles.length || trackedHashedLoginFiles.length) {
  if (missing.length) {
    console.error('Missing frontend resources:');
    for (const item of missing) console.error(`  ${item}`);
  }
  if (deletedReferences.length) {
    console.error('Deleted frontend resources are still referenced:');
    for (const item of deletedReferences) console.error(`  ${item}`);
  }
  if (trackedGeneratedFiles.length || trackedChunkFiles.length || trackedHashedEntryFiles.length || trackedHashedLoginFiles.length) {
    console.error('Generated frontend files must not be tracked by Git:');
    for (const item of [...trackedGeneratedFiles, ...trackedChunkFiles, ...trackedHashedEntryFiles, ...trackedHashedLoginFiles]) console.error(`  ${item}`);
  }
  process.exit(1);
}

console.log(`Frontend asset check passed (${checkedReferences.size} references checked).`);
