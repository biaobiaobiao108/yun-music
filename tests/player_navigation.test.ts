import { describe, it, expect, beforeAll } from 'bun:test';
import fs from 'fs';
import path from 'path';

describe('Player Navigation and State Restoration Safety', () => {
    const playerSrcPath = path.join(import.meta.dir, '../frontend/player/src/index.ts');
    const navigationSrcPath = path.join(import.meta.dir, '../frontend/player/src/features/navigation.ts');
    const playbackSrcPath = path.join(import.meta.dir, '../frontend/player/src/features/playback.ts');
    const searchSrcPath = path.join(import.meta.dir, '../frontend/player/src/features/search.ts');
    const librarySrcPath = path.join(import.meta.dir, '../frontend/player/src/features/library.ts');
    const lyricsSrcPath = path.join(import.meta.dir, '../frontend/player/src/features/lyrics.ts');
    const customSelectSrcPath = path.join(import.meta.dir, '../frontend/player/src/custom_select.ts');
    const accessibleOverlaysSrcPath = path.join(import.meta.dir, '../frontend/player/src/accessible_overlays.ts');
    const playlistModalSrcPath = path.join(import.meta.dir, '../frontend/player/src/features/playlist_modal.ts');
    const localMusicSrcPath = path.join(import.meta.dir, '../frontend/player/src/legacy/local_music.ts');
    const playerCssPath = path.join(import.meta.dir, '../public/music/css/app.css');
    const playerPublicDir = path.join(import.meta.dir, '../public/music');
    const getPlayerDistPath = () => path.join(playerPublicDir, fs.readdirSync(playerPublicDir).find(name => /^app-[a-z0-9]+\.js$/i.test(name)) || 'app.js');

    beforeAll(() => {
        if (!fs.existsSync(getPlayerDistPath())) {
            const { execSync } = require('child_process');
            execSync('bun run build:frontend', { cwd: path.join(import.meta.dir, '..'), stdio: 'ignore' });
        }
    });

    it('frontend player source should not contain navigation-hijacking _pendingResumeListId', () => {
        const srcContent = fs.readFileSync(playerSrcPath, 'utf8');
        expect(srcContent.includes('_pendingResumeListId')).toBe(false);
    });

    it('built frontend distribution (public/music/app.js) should not contain _pendingResumeListId', () => {
        const distContent = fs.readFileSync(getPlayerDistPath(), 'utf8');
        expect(distContent.includes('_pendingResumeListId')).toBe(false);
    });

    it('frontend player source defines and uses isCurrentlyViewingLocalList for guarded navigation', () => {
        const srcContent = fs.readFileSync(playerSrcPath, 'utf8');
        expect(srcContent.includes('function isCurrentlyViewingLocalList')).toBe(true);
        expect(srcContent.includes('isCurrentlyViewingLocalList(window.currentViewingListId)')).toBe(true);
    });

    it('playSong queue fallback does not hijack window.currentViewingListId', () => {
        const srcContent = [playerSrcPath, playbackSrcPath]
            .map(filePath => fs.readFileSync(filePath, 'utf8'))
            .join('\n');
        const fallbackSnippetMatch = srcContent.match(/shouldFallback\s*=\s*settings\.switchPlaylistOnSongListPlay\s*===\s*false[\s\S]*?currentIndex\s*=\s*0;[\s\S]*?currentPlayingScope\s*=\s*'local_list';/);
        expect(fallbackSnippetMatch).not.toBeNull();
        if (fallbackSnippetMatch) {
            expect(fallbackSnippetMatch[0].includes("window.currentViewingListId = 'default'")).toBe(false);
        }
    });

    it('frontend player exposes toggleSidebar and toggleDetailCover to window', () => {
        const srcContent = fs.readFileSync(playerSrcPath, 'utf8');
        expect(srcContent.includes('(window as any).toggleSidebar = toggleSidebar')).toBe(true);
        expect(srcContent.includes('(window as any).toggleDetailCover = toggleDetailCover')).toBe(true);

        const distContent = fs.readFileSync(getPlayerDistPath(), 'utf8');
        expect(distContent.includes('toggleSidebar')).toBe(true);
        expect(distContent.includes('toggleDetailCover')).toBe(true);
    });

    it('music index.html has viewport-fit=cover and mobile menu button', () => {
        const playerHtmlPath = path.join(import.meta.dir, '../public/music/index.html');
        const html = fs.readFileSync(playerHtmlPath, 'utf8');
        expect(html.includes('viewport-fit=cover')).toBe(true);
        expect(html.includes('id="mobile-menu-btn"')).toBe(true);
        expect(html.includes('data-event-click-action="toggleSidebar"')).toBe(true);
    });

    it('nested playlist creation keeps native dialogs interactive and syncs restored user status', () => {
        const player = fs.readFileSync(playerSrcPath, 'utf8');
        const playlistModal = fs.readFileSync(playlistModalSrcPath, 'utf8');
        const overlays = fs.readFileSync(accessibleOverlaysSrcPath, 'utf8');

        expect(player).toContain('const shouldRestorePlaylistModal');
        expect(player).toContain('closePlaylistAddModal(true)');
        expect(player).toContain('await openPlaylistAddModal()');
        expect(playlistModal).toContain('function closePlaylistAddModal(immediate = false)');
        expect(overlays).toContain("element.tagName === 'DIALOG'");
        expect(player).toContain('function syncUserSessionStatus()');
        expect(player).toContain('syncUserSessionStatus();');
    });

    it('local music uses the authenticated storage scope for media URLs and deletion', () => {
        const localMusic = fs.readFileSync(localMusicSrcPath, 'utf8');

        expect(localMusic).toContain('getStorageUsername()');
        expect(localMusic).toContain('window.getUserName');
        expect(localMusic).toContain('item._coverLoadFailed');
        expect(localMusic).toContain('/api/music/cache/remove?user=${encodeURIComponent(username)}');
        expect(localMusic).not.toContain("(window.currentListData && window.currentListData.username) || '_open'");

        const search = fs.readFileSync(searchSrcPath, 'utf8');
        expect(search).toContain("img.classList.contains('lm-cover-image')");
    });

    it('player sidebar prevents horizontal overflow from long navigation labels', () => {
        const playerHtmlPath = path.join(import.meta.dir, '../public/music/index.html');
        const html = fs.readFileSync(playerHtmlPath, 'utf8');
        const css = fs.readFileSync(playerCssPath, 'utf8');
        const source = fs.readFileSync(playerSrcPath, 'utf8');
        const sidebar = html.match(/<aside id="main-sidebar"[\s\S]*?class="([^"]+)"/)?.[1] ?? '';
        const nav = html.match(/<nav class="([^"]+)"/)?.[1] ?? '';
        const favoritesButton = html.match(/<button[^>]*id="tab-favorites"[\s\S]*?<\/button>/)?.[0] ?? '';

        expect(sidebar).toContain('shrink-0');
        expect(sidebar).toContain('min-w-0');
        expect(nav).toContain('min-w-0');
        expect(favoritesButton).toContain('netease-nav-item');
        expect(favoritesButton).toContain('min-w-0');
        expect(favoritesButton).toContain('truncate');
        expect(css).toContain('#main-sidebar nav');
        expect(css).toContain('overflow-x: clip');
        expect(css).toContain('min-inline-size: 0');
        expect(source).toContain('div.title = displayName;');
        expect(source).toContain('publicFavItem.title = \'公开收藏\';');
    });

    it('player list surfaces share stable tracks and constrained playlist cards', () => {
        const playerHtmlPath = path.join(import.meta.dir, '../public/music/index.html');
        const html = fs.readFileSync(playerHtmlPath, 'utf8');
        const css = fs.readFileSync(playerCssPath, 'utf8');
        const rendererSources = [
            path.join(import.meta.dir, '../frontend/player/src/features/search.ts'),
            path.join(import.meta.dir, '../frontend/player/src/legacy/songlist_manager.ts'),
            path.join(import.meta.dir, '../frontend/player/src/legacy/leaderboard_manager.ts'),
            path.join(import.meta.dir, '../frontend/player/src/legacy/local_music.ts'),
        ].map(filePath => fs.readFileSync(filePath, 'utf8'));

        expect(html).toContain('class="playlist-card-grid"');
        expect(html).toContain('class="w-56 shrink-0');
        expect(html).toContain('class="player-track-list-content flex-1');
        expect(html).toContain('class="player-pagination-bar');
        expect(css).toContain('--player-track-index-size: 5rem');
        expect(css).toContain('--player-track-action-size: 5rem');
        expect(css).toContain('grid-template-columns: var(--player-track-index-size) minmax(0, 1fr) minmax(var(--player-track-action-size), max-content)');
        expect(css).toContain('grid-template-columns: 5rem minmax(14rem, 3fr) minmax(12rem, 3fr) minmax(4.5rem, max-content) minmax(var(--player-track-action-size), max-content)');
        expect(css).toContain('grid-template-columns: 5rem minmax(14rem, 3fr) minmax(12rem, 3fr) minmax(12rem, 2fr) minmax(4.5rem, max-content) minmax(var(--player-track-action-size), max-content)');
        expect(css).toContain('--player-track-action-size: 12.5rem');
        expect(css).toContain('grid-template-columns: repeat(auto-fill, minmax(10rem, 13.75rem))');
        expect(css).toContain('min-inline-size: max-content');
        expect(css).toContain('flex-wrap: nowrap');
        expect(css).toContain('white-space: nowrap');
        expect(css).toContain('#search-results-header');
        expect(css).toContain('.player-track-list-content');
        expect(css).toContain('margin-inline: 0;');
        expect(css).toContain('.player-pagination-bar');
        expect(css).toContain('block-size: 3rem');
        expect(html).toContain('player-floating-capsule');
        expect(css).toContain('.favorite-sidebar-item.active-sub-item');
        for (const source of rendererSources) {
            expect(source).toContain('player-track-grid');
            expect(source).toContain('player-track-actions');
            expect(source).toContain('player-motion-item');
        }
        expect(rendererSources[0]).toContain('hot-search-item player-motion-item');
        expect(rendererSources[2]).toContain('lb-board-item player-motion-item');
        expect(rendererSources[0]).toContain("div.className = 'player-motion-item group flex flex-col");
    });

    it('search detail views keep one local track header and preserve navigation', () => {
        const playerContent = fs.readFileSync(playerSrcPath, 'utf8');
        const navigationContent = fs.readFileSync(navigationSrcPath, 'utf8');
        const searchContent = fs.readFileSync(searchSrcPath, 'utf8');
        const css = fs.readFileSync(playerCssPath, 'utf8');

        expect(searchContent).toContain('function syncSearchDetailHeaderVisibility');
        expect(searchContent).toContain('header.classList.toggle(\'hidden\', searchDetailOpen)');
        expect(searchContent).toContain('function renderTrackListHeader');
        expect(searchContent).toContain('includeBackToolbar: true');
        expect(searchContent).toContain('data-event-click-action="goBackToSearch"');
        expect(searchContent).toContain('renderTrackListHeader({ extraClass:');
        expect(searchContent).toContain('container.insertAdjacentHTML(\'beforeend\', emptyState)');
        expect(searchContent).toContain('paginationBar.classList.toggle(\'hidden\', searchDetailOpen)');
        expect(playerContent).toContain('const switchTab = createTabSwitcher');
        expect(navigationContent).toContain('transitionPlayerView(activeView, getPlayerViewDirection(tabId))');
        expect(css).toContain('#search-results-header.hidden');
        expect(css).toContain('display: none !important');
        expect(css).toContain('.player-detail-list-toolbar');
        expect(css).toContain('scrollbar-gutter: stable');
        expect(css).toContain('flex: 0 0 14rem');
        expect(css).toContain('min-inline-size: 14rem');
    });

    it('artist detail tabs and album cards keep stable, non-overlapping layout', () => {
        const searchContent = fs.readFileSync(searchSrcPath, 'utf8');
        const html = fs.readFileSync(path.join(import.meta.dir, '../public/music/index.html'), 'utf8');
        const css = fs.readFileSync(playerCssPath, 'utf8');
        const artistSongsSection = searchContent.match(/function renderArtistSongsUI[\s\S]*?window\.renderArtistSongsUI/)?.[0] ?? '';

        expect(artistSongsSection).toContain('<span class="index-num">${index + 1}</span>');
        expect(artistSongsSection).not.toContain('group-hover:block');
        expect(searchContent).toContain('class="artist-detail-tabs-bar flex items-center');
        expect(searchContent).toContain('style="min-height: 40px; height: 40px;"');
        expect(searchContent).toContain("const tabsClass = '';");
        expect(searchContent).toContain("tabsBar.classList.remove('mt-8', 'mt-1');");
        expect(searchContent).toContain('class="artist-tabs-group flex items-center');
        expect(searchContent).toContain('class="artist-albums-grid p-2 md:p-4');
        expect(artistSongsSection).toContain('getArtistSongsPageMetrics');
        expect(artistSongsSection).toContain('const startIndex = (artistPage - 1) * itemsPerPage;');
        expect(artistSongsSection).toContain('player-pagination-bar');
        expect(searchContent).toContain('class="artist-detail-view');
        expect(artistSongsSection).not.toContain('pageState.value');
        expect(css).toContain('#artist-tabs-bar');
        expect(css).toContain('block-size: 2.5rem');
        expect(css).toContain('align-items: center');
        expect(css).toContain('padding-block: 0');
        expect(css).toContain('.artist-albums-grid');
        expect(css).toContain('grid-template-columns: repeat(auto-fill, minmax(10rem, 13.75rem))');
        expect(css).toContain('max-inline-size: 13.75rem');
        expect(css).toContain('#main-sidebar nav::-webkit-scrollbar');
        expect(css).toContain('scrollbar-width: none');
        expect(css).toContain('scrollbar-gutter: auto');
        expect(html).toContain('overflow-y-auto no-scrollbar');
    });

    it('artist and favorite detail paths bound initial network and DOM work', () => {
        const searchContent = fs.readFileSync(searchSrcPath, 'utf8');
        const libraryContent = fs.readFileSync(librarySrcPath, 'utf8');
        const musicRoutes = fs.readFileSync(path.join(import.meta.dir, '../src/server/routes/music.ts'), 'utf8');

        expect(searchContent).toContain('const pendingContent = needsArtistInfo');
        expect(searchContent).toContain('page: String(page)');
        expect(searchContent).toContain('limit: String(pageSize)');
        expect(searchContent).toContain('const artistSongsPageCache = new Map<number, any[]>()');
        expect(searchContent).toContain('data-event-click-args="[${itemIdArg}, ${playlistIndex}]"');
        expect(searchContent).toContain('const ARTIST_ALBUM_RENDER_PAGE_SIZE = ARTIST_ALBUM_PAGE_SIZE;');
        expect(searchContent).toContain('const artistAlbumsPageCache = new Map<number, any[]>()');
        expect(searchContent).toContain("page: String(page) });");
        expect(searchContent).toContain('if (artistAlbumsUsesServerPagination && !artistAlbumsPageCache.has(targetPage))');

        expect(libraryContent).toContain('const LIBRARY_RENDER_PAGE_SIZE: Record<LibraryKind, number>');
        expect(libraryContent).toContain('visibleList: list.slice(startIndex, startIndex + pageSize)');
        expect(libraryContent).toContain('data-event-click-action="libraryGoToPage"');

        expect(musicRoutes).toContain("const requestedPage = ctx.query.get('page')");
        expect(musicRoutes).toContain("const requestedLimit = ctx.query.get('limit')");
        expect(musicRoutes).toContain('if (requestedPage !== null || requestedLimit !== null)');
        expect(musicRoutes).toContain('const limit = boundedInt(requestedLimit, 50, 1, 100)');
        expect(musicRoutes).toContain('// 未传分页参数时仍保留旧的全量数组响应');
    });

    it('lyric loading cancels stale requests when playback changes quickly', () => {
        const lyricsContent = fs.readFileSync(lyricsSrcPath, 'utf8');

        expect(lyricsContent).toContain('let lyricRequestController: AbortController | null = null;');
        expect(lyricsContent).toContain('lyricRequestController?.abort();');
        expect(lyricsContent).toContain('const isCurrentRequest = () => requestSerial === lyricRequestSerial');
        expect(lyricsContent).toContain('signal: requestController.signal');
        expect(lyricsContent).toContain("if (e?.name === 'AbortError' || !isCurrentRequest()) return;");
    });

    it('search favorite controls do not activate their parent detail cards', () => {
        const searchContent = fs.readFileSync(searchSrcPath, 'utf8');
        const singerSection = searchContent.match(/function renderSingerResults[\s\S]*?function renderAlbumResults/)?.[0] ?? '';
        const albumSection = searchContent.match(/function renderAlbumResults[\s\S]*?function formatPlayCount/)?.[0] ?? '';

        expect(searchContent).toContain('function isSearchResultFavoriteTarget');
        expect(searchContent).toContain("typeof (target as Element).closest === 'function'");
        expect(searchContent).toContain('event.composedPath().some');
        expect(singerSection).toContain('const activateSinger = (event?: Event)');
        expect(singerSection).toContain('if (isSearchResultFavoriteTarget(event)) return;');
        expect(singerSection).toContain('search-result-favorite-btn');
        expect(singerSection).toContain('favoriteButton?.addEventListener(\'click\', event =>');
        expect(singerSection).toContain('event.stopPropagation();');
        expect(albumSection).toContain('const activateAlbum = (event?: Event)');
        expect(albumSection).toContain('if (isSearchResultFavoriteTarget(event)) return;');
        expect(albumSection).toContain('search-result-favorite-btn');
        expect(albumSection).toContain('favoriteButton?.addEventListener(\'click\', event =>');
    });

    it('favorite library views have guarded loading, active data, and save rollback', () => {
        const libraryContent = fs.readFileSync(librarySrcPath, 'utf8');
        const searchContent = fs.readFileSync(searchSrcPath, 'utf8');

        expect(libraryContent).toContain('let libraryLoadSerial = 0;');
        expect(libraryContent).toContain('let libraryLoadController: AbortController | null = null;');
        expect(libraryContent).toContain('function getActiveLibraryList(kind: LibraryKind)');
        expect(libraryContent).toContain('if (!response.ok) throw new Error(await response.text());');
        expect(libraryContent).toContain('function renderLibraryLoadError(kind: LibraryKind)');
        expect(libraryContent).toContain('data-event-click-action="reloadLibraryData"');
        expect(libraryContent).toContain('const previousList = [...targetList];');
        expect(libraryContent).toContain('if (!await saveLibraryArtists(targetList))');
        expect(libraryContent).toContain('if (!await saveLibraryAlbums(targetList))');
        expect(libraryContent).toContain('async function handleArtistLibraryClick()');
        expect(libraryContent).toContain('async function handleAlbumLibraryClick()');
        expect(searchContent).toContain('const paginationBar = document.getElementById(\'search-pagination-bar\');');
        expect(searchContent).toContain('paginationBar.classList.toggle(\'hidden\', searchDetailOpen)');
    });

    it('artist details keep a single bounded scroll container and restore search pagination', () => {
        const searchContent = fs.readFileSync(searchSrcPath, 'utf8');
        const css = fs.readFileSync(playerCssPath, 'utf8');
        const distContent = fs.readFileSync(getPlayerDistPath(), 'utf8');

        expect(searchContent).toContain('id="artist-detail-view" class="artist-detail-view flex flex-1 min-h-0 flex-col overflow-y-auto custom-scrollbar"');
        expect(searchContent).toContain('container.classList.add(\'artist-detail-active\');');
        expect(searchContent).toContain('container.classList.remove(\'artist-detail-active\');');
        expect(searchContent).toContain("tabsBar.classList.remove('mt-8', 'mt-1');");
        expect(css).toContain('#search-results.artist-detail-active');
        expect(css).toContain('#search-results.artist-detail-active > .artist-detail-view');
        expect(css).toContain('#search-results.artist-detail-active #artist-tabs-bar');
        expect(css).toContain('overflow-y: auto;');
        expect(css).toContain('#search-pagination-bar.hidden');
        expect(css).toContain('display: none !important;');
        expect(css).toContain('margin-block: 0;');
        expect(distContent).toContain('artist-detail-active');
        expect(distContent).toContain('reloadLibraryData');
    });

    it('all player list surfaces use the same header and pagination boundaries', () => {
        const html = fs.readFileSync(path.join(import.meta.dir, '../public/music/index.html'), 'utf8');
        const css = fs.readFileSync(playerCssPath, 'utf8');

        const sharedHeaders = html.match(/player-track-list-header player-track-grid/g) ?? [];
        expect(sharedHeaders.length).toBe(0);
        for (const id of ['search-floating-actions', 'lb-floating-actions']) {
            const element = html.match(new RegExp(`id="${id}"[\\s\\S]{0,240}`))?.[0] ?? '';
            expect(element).toContain('player-floating-capsule');
        }
        for (const id of ['search-pagination-bar', 'songlist-pagination', 'lb-pagination', 'lm-pagination']) {
            const element = html.match(new RegExp(`id="${id}"[\\s\\S]{0,240}`))?.[0] ?? '';
            expect(element).toContain('player-pagination-bar');
        }
        expect(css).toContain('inline-size: 100%;');
        expect(css).toContain('padding-inline: 0 !important;');
        expect(css).toContain('.player-pagination-center');
        expect(css).toContain('.player-pagination-button');
        expect(css).toContain('.player-pagination-center {\n        flex-direction: row;');
    });

    it('player motion is progressive, directional, and reduced-motion aware', () => {
        const source = fs.readFileSync(navigationSrcPath, 'utf8');
        const css = fs.readFileSync(playerCssPath, 'utf8');

        expect(source).toContain('function prefersReducedPlayerMotion');
        expect(source).toContain('function transitionPlayerView');
        expect(source).toContain('updatePlayerViewVisibility(activeView, direction, true)');
        expect(css).toContain('--motion-duration-panel: 320ms');
        expect(css).toContain('--motion-ease-emphasized');
        expect(css).toContain('@keyframes player-view-enter-forward');
        expect(css).toContain('@keyframes player-view-enter-backward');
        expect(css).toContain('@keyframes player-list-item-enter');
        expect(css).toContain('.player-detail-content-entering');
        expect(css).toContain('@supports (view-transition-name: none)');
        expect(css).toContain('active-view-transition-type(forward)');
        expect(css).toContain('prefers-reduced-motion: reduce');
        expect(css).toContain('animation: none !important');
        expect(css).toContain('transition-property: transform, box-shadow, background-color, border-color, color, opacity');
    });

    it('mobile player footer uses explicit rows and keeps every control touchable', () => {
        const playerHtmlPath = path.join(import.meta.dir, '../public/music/index.html');
        const html = fs.readFileSync(playerHtmlPath, 'utf8');
        const css = fs.readFileSync(playerCssPath, 'utf8');

        expect(html).toContain('class="player-footer-song-info');
        expect(html).toContain('class="player-footer-center');
        expect(html).toContain('class="player-footer-control-row');
        expect(html).toContain('class="player-footer-progress-row');
        expect(html).toContain('aria-haspopup="menu" aria-expanded="false"');
        expect(html).toContain('class="player-footer-collapse-button ');
        expect(css).toContain('@media (max-width: 1024px)');
        expect(css).toContain('#player-footer .player-footer-control-row');
        expect(css).toContain('#player-footer .player-footer-progress-row');
        expect(css).toContain('min-inline-size: 0');
        expect(css).toContain('max-inline-size: 100dvw');
        expect(css).toContain('env(safe-area-inset-bottom');
        expect(css).toContain('-webkit-backdrop-filter: none !important');
        expect(css).not.toContain('#player-footer > .flex-1 > div:first-child');
        expect(css).not.toContain('#player-footer > .flex-1 > div:last-child #play-mode-btn');
    });

    it('mobile player menu closes with Escape and supports the tablet breakpoint', () => {
        const source = fs.readFileSync(playerSrcPath, 'utf8');
        expect(source).toContain('if (window.innerWidth < 1025)');
        expect(source).toContain("const moreMenu = document.getElementById('player-more-menu');");
        expect(source).toContain("moreButton?.focus();");
        expect(source).toContain('closeMobileSidebar: () => toggleSidebar(false)');
    });

    it('artist and album searches guard favorite callbacks and use the auth bridge', () => {
        const srcContent = fs.readFileSync(playerSrcPath, 'utf8');
        const searchContent = fs.readFileSync(searchSrcPath, 'utf8');
        expect(srcContent.includes('getUserAuthHeaders: getPlayerUserAuthHeaders')).toBe(true);
        expect(srcContent.includes('isUserLoggedIn: isPlayerUserLoggedIn')).toBe(true);
        expect(srcContent.indexOf('let authToken')).toBeLessThan(srcContent.indexOf('const playlistModalFeature'));
        expect(srcContent.indexOf('let userToken')).toBeLessThan(srcContent.indexOf('const playlistModalFeature'));
        expect(searchContent.includes("typeof context.isArtistFavorited === 'function'")).toBe(true);
        expect(searchContent.includes("typeof context.isAlbumFavorited === 'function'")).toBe(true);
    });

    it('player active states do not add the removed accent borders', () => {
        const css = fs.readFileSync(playerCssPath, 'utf8');
        const customSelect = fs.readFileSync(customSelectSrcPath, 'utf8');
        const playerSrc = fs.readFileSync(playerSrcPath, 'utf8');
        const activeTabRule = css.match(/\.active-tab\s*\{([\s\S]*?)\}/)?.[1] ?? '';
        const activeLmSelectRule = css.match(/\.lm-select\.active\s*\{([\s\S]*?)\}/)?.[1] ?? '';
        const activeSelectRule = css.match(/\.cs-wrapper\.active \.cs-trigger\s*\{([\s\S]*?)\}/)?.[1] ?? '';
        const triggerFocusRule = css.match(/\.cs-trigger:focus-visible\s*\{([\s\S]*?)\}/)?.[1] ?? '';
        const selectedOptionRule = css.match(/\.cs-option\.selected\s*\{([\s\S]*?)\}/)?.[1] ?? '';
        const selectedQualityRule = css.match(/\.player-quality-option\[aria-checked="true"\][\s\S]*?\{([\s\S]*?)\}/)?.[1] ?? '';
        expect(activeTabRule.includes('border-right')).toBe(false);
        expect(css.includes('.cs-wrapper.highlight .cs-trigger')).toBe(false);
        expect(css.includes('.cs-wrapper.highlight .cs-trigger-icon')).toBe(false);
        expect(customSelect.includes("wrapper.classList.remove('highlight')")).toBe(true);
        expect(customSelect.includes("wrapper.classList.add('highlight')")).toBe(false);
        expect(activeLmSelectRule.includes('var(--c-500)')).toBe(false);
        expect(activeLmSelectRule.includes('box-shadow')).toBe(false);
        expect(activeSelectRule.includes('var(--c-500)')).toBe(false);
        expect(activeSelectRule.includes('box-shadow')).toBe(false);
        expect(triggerFocusRule.includes('outline: 2px solid')).toBe(true);
        expect(selectedOptionRule.includes('background: transparent')).toBe(true);
        expect(selectedOptionRule.includes('box-shadow: none')).toBe(true);
        expect(selectedOptionRule.includes('inset')).toBe(false);
        expect(selectedOptionRule.includes('font-weight: 700')).toBe(false);
        expect(selectedQualityRule.includes('background: transparent')).toBe(true);
        expect(selectedQualityRule.includes('box-shadow: none')).toBe(true);
        expect(css.includes('background: color-mix(in srgb, var(--c-500) 12%, transparent)')).toBe(false);
        expect(css.includes('.active-option')).toBe(false);
        expect(css.includes('.cs-option:hover')).toBe(true);
        expect(css.includes('.header-clock-immersive')).toBe(true);
        expect(css.includes('.header-source-pill')).toBe(false);
        expect(css.includes('.player-quality-option:hover')).toBe(true);
        expect(customSelect.includes("item.setAttribute('aria-selected', String(selected))")).toBe(true);
        expect(customSelect.includes("check.className = 'fas fa-check'")).toBe(true);
        expect(playerSrc.includes("opt.setAttribute('aria-pressed', String(selected))")).toBe(true);
        expect(playerSrc.includes('window.togglePlayModeMenu = togglePlayModeMenu')).toBe(true);
        expect(playerSrc.includes('window.setPlaybackRate = setPlaybackRate')).toBe(true);
        expect(playerSrc.includes('window.togglePlaybackRateMenu = togglePlaybackRateMenu')).toBe(true);
    });

    it('album detail navigation cancels stale searches and isolates history events', () => {
        const searchContent = fs.readFileSync(searchSrcPath, 'utf8');
        const lyricsContent = fs.readFileSync(path.join(import.meta.dir, '../frontend/player/src/features/lyrics.ts'), 'utf8');
        const albumSection = searchContent.match(/async function enterAlbum\([\s\S]*?\n}\n\nfunction goBackToSearch/)?.[0] ?? '';

        expect(searchContent.includes('function invalidateSearchRequest')).toBe(true);
        expect(searchContent.includes('if (prefetch && searchDetailOpen) return;')).toBe(true);
        expect(searchContent.includes("if (!searchDetailOpen && window.currentSearchScope === 'network'" )).toBe(true);
        expect(searchContent.includes('function isAlbumRequestCurrent')).toBe(true);
        expect(searchContent.includes("kind: 'album'" )).toBe(true);
        expect(searchContent.includes("kind: 'artist'" )).toBe(true);
        expect(searchContent.includes('function handleSearchPopState')).toBe(true);
        expect(searchContent.includes("switchTab('search', true)")).toBe(true);
        expect(searchContent.includes('function leaveSearchView')).toBe(true);
        expect(searchContent.includes('获取专辑歌曲失败：${escapeHtmlText(e.message)}')).toBe(true);
        expect(albumSection.includes('goBackToSearch();')).toBe(false);
        expect(lyricsContent.includes('lyricHistoryClosePending')).toBe(true);
        expect(lyricsContent.includes('handleSearchPopState(e.state)')).toBe(true);
        expect(lyricsContent.includes("if (e.state?.page === 'player-detail') return;")).toBe(true);
        expect(lyricsContent.includes("if (e.state?.page === 'player-detail') {\n        toggleLyrics(true);\n        return;\n    }")).toBe(true);
        expect(fs.readFileSync(path.join(import.meta.dir, '../frontend/player/src/index.ts'), 'utf8').includes("window.history.replaceState({ page: 'player' }, '')")).toBe(true);
    });

    it('single mode distinguishes manual skipping from automatic ended replay', () => {
        const songUrlContent = fs.readFileSync(path.join(import.meta.dir, '../frontend/player/src/features/song_url.ts'), 'utf8');
        const playbackContent = fs.readFileSync(playbackSrcPath, 'utf8');
        const indexContent = fs.readFileSync(playerSrcPath, 'utf8');

        // getNextIndex accepts isManual flag
        expect(songUrlContent.includes('function getNextIndex(isManual = false)')).toBe(true);
        expect(songUrlContent.includes("case 'single':\n            if (isManual) {")).toBe(true);

        // playNext and playPrev forward isManual flag
        expect(playbackContent.includes('function playNext(depth = 0, isManual = true)')).toBe(true);
        expect(playbackContent.includes('function playPrev(isManual = true)')).toBe(true);

        // ended event replays seamlessly for single mode
        expect(indexContent.includes("if (playMode === 'single') {\n        audio.currentTime = 0;")).toBe(true);
    });

    it('cached URL playback resets ended media and retries rejected cache sources', () => {
        const playbackContent = fs.readFileSync(playbackSrcPath, 'utf8');

        expect(playbackContent).toContain('function setAudioSource(url)');
        expect(playbackContent).toContain('if (audio.ended) {\n                audio.currentTime = 0;');
        expect(playbackContent).toContain('let retryResolvedUrl: (() => boolean) | null = null;');
        expect(playbackContent).toContain("localStorage.removeItem(`lx_url_${cleanSongData(playbackSong).id}_${resolvedQuality}`);");
        expect(playbackContent).toContain('if (!isPlaybackPermissionError && retryResolvedUrl?.()) return;');
        expect(playbackContent).toContain('showSuccess(`[${song.name}] 命中${sourceText}`);');
    });

    it('restored playback waits for the source load and can recover a source that fails after play starts', () => {
        const playbackContent = fs.readFileSync(playbackSrcPath, 'utf8');

        expect(playbackContent).toContain('let playAfterSourceReady = false;');
        expect(playbackContent).toContain('if (state.currentLoadingRequestId !== 0) {\n            playAfterSourceReady = true;');
        expect(playbackContent).toContain('queueMicrotask(() => {');
        expect(playbackContent).toContain('if (!noPlay && finalUrl) {');
        expect(playbackContent).toContain('state.currentLoadingRequestId !== 0) return;');
        expect(playbackContent).toContain('void playSong(song, state.currentIndex, null, false, \'local_retry\', null, resumeTime);');
    });

    it('queue clearing resets player state and protects empty togglePlay', () => {
        const queueContent = fs.readFileSync(path.join(import.meta.dir, '../frontend/player/src/features/queue.ts'), 'utf8');
        const indexContent = fs.readFileSync(playerSrcPath, 'utf8');
        const playbackContent = fs.readFileSync(playbackSrcPath, 'utf8');

        expect(queueContent.includes('resetPlayer?: () => void;')).toBe(true);
        expect(queueContent.includes('context.resetPlayer();')).toBe(true);
        expect(indexContent.includes('function resetPlayer()')).toBe(true);
        expect(playbackContent.includes("if (!state.currentPlayingSong && (!state.currentPlaylist || state.currentPlaylist.length === 0))")).toBe(true);
    });

    it('volume fade and crossfade strictly preserve mute state', () => {
        const playbackContent = fs.readFileSync(playbackSrcPath, 'utf8');
        expect(playbackContent.includes('if (state.isMuted || targetVolume <= 0)')).toBe(true);
        expect(playbackContent.includes('audio.muted = isMuted;')).toBe(true);
        expect(playbackContent.includes('if (settings.enableCrossfade && !isMuted && effectiveVol > 0)')).toBe(true);
    });

    it('queue count badge updates immediately on playlist change without opening drawer', () => {
        const queueContent = fs.readFileSync(path.join(import.meta.dir, '../frontend/player/src/features/queue.ts'), 'utf8');
        const playbackContent = fs.readFileSync(playbackSrcPath, 'utf8');
        const indexHtmlContent = fs.readFileSync(path.join(import.meta.dir, '../public/music/index.html'), 'utf8');

        expect(queueContent.includes('function updateQueueBadge()')).toBe(true);
        expect(queueContent.includes('updateQueueBadge,')).toBe(true);
        expect(playbackContent.includes('updateQueueBadge();')).toBe(true);
        expect(indexHtmlContent.includes('id="queue-badge-count-mobile"')).toBe(true);
        expect(indexHtmlContent.includes('id="queue-badge-count"')).toBe(true);
    });

    it('modal overlays stay interactive when a player drawer is open', () => {
        const overlayContent = fs.readFileSync(accessibleOverlaysSrcPath, 'utf8');
        const playerContent = fs.readFileSync(playerSrcPath, 'utf8');

        expect(overlayContent).toContain('function getOverlayStackingOrder(element: OverlayElement): number');
        expect(overlayContent).toContain('function getTopmostOpenOverlay(openOverlays: OverlayElement[]): OverlayElement | null');
        expect(overlayContent).toContain('function dismissTransientPortals(): void');
        expect(overlayContent).toContain('getComputedStyle(element).zIndex');
        expect(overlayContent).toContain('getOverlayStackingOrder(overlay) >= getOverlayStackingOrder(topmost)');
        expect(overlayContent).toContain('const nextOverlay = getTopmostOpenOverlay(openOverlays);');
        expect(overlayContent).toContain("(window as any).closeFavoriteSidebarMenus?.();");
        expect(overlayContent).toContain("(window as any).CustomSelectManager?.closeAll?.();");
        expect(overlayContent).toContain('if (nextOverlay && !isDrawer(nextOverlay) && activeOverlay !== nextOverlay)');
        expect(playerContent).toContain('(window as any).closeFavoriteSidebarMenus = closeFavoriteSidebarMenus;');
    });

    it('library cards and songlist detail use sticky headers aligned with standard list height', () => {
        const libraryContent = fs.readFileSync(path.join(import.meta.dir, '../frontend/player/src/features/library.ts'), 'utf8');
        const songlistMgrContent = fs.readFileSync(path.join(import.meta.dir, '../frontend/player/src/legacy/songlist_manager.ts'), 'utf8');
        const indexHtmlContent = fs.readFileSync(path.join(import.meta.dir, '../public/music/index.html'), 'utf8');
        const cssContent = fs.readFileSync(playerCssPath, 'utf8');

        // Library artist/album sticky headers & height alignment
        expect(libraryContent).toContain('lib-sticky-header sticky top-0 z-20');
        expect(libraryContent).toContain('px-3 py-1.5 min-h-[42px] border-b t-border-main');
        expect(cssContent).toContain('.lib-sticky-header');
        expect(cssContent).toContain('#search-results:has(> .lib-sticky-header)');

        // Songlist detail unified scroll and sticky controls block
        expect(indexHtmlContent).toContain('id="sl-detail-scroll-container"');
        expect(indexHtmlContent).toContain('id="sl-detail-sticky-wrap"');
        expect(indexHtmlContent).toContain('id="sl-detail-tabs-bar"');
        expect(indexHtmlContent).toContain('id="sl-detail-count-badge"');
        expect(songlistMgrContent).toContain('sl-detail-scroll-container');
        expect(cssContent).toContain('#sl-detail-scroll-container');
        expect(cssContent).toContain('#sl-detail-sticky-wrap');
    });

    it('favorite sidebar keeps custom list names visible behind the right-side action menu', () => {
        const playerContent = fs.readFileSync(playerSrcPath, 'utf8');
        const cssContent = fs.readFileSync(playerCssPath, 'utf8');

        expect(playerContent).toContain('function getFavoriteListDisplayName(name)');
        expect(playerContent).toContain("const normalizedName = String(name ?? '').trim();");
        expect(playerContent).toContain('favorite-sidebar-name ml-2 flex-1 min-w-0');
        expect(playerContent).toContain('favorite-sidebar-more-btn');
        expect(playerContent).toContain('favorite-sidebar-menu');
        expect(playerContent).toContain('function toggleFavoriteListMenu(event, trigger)');
        expect(playerContent).toContain('function closeFavoriteSidebarMenus(restoreFocus = false)');
        expect(playerContent).toContain('portalMenus.forEach(menu => document.body.appendChild(menu));');
        expect(playerContent).toContain("menu.addEventListener('click', event => {");
        expect(playerContent).toContain('applyMarqueeChecks(container);');
        expect(playerContent).toContain('title = getFavoriteListDisplayName(uList.name);');
        expect(cssContent).toContain('.favorite-sidebar-item > button:not(.hidden)');
        expect(cssContent).toContain('.favorite-sidebar-more-btn');
        expect(cssContent).toContain('.favorite-sidebar-menu');
        expect(cssContent).toContain('.favorite-sidebar-more-btn:focus');
        expect(cssContent).not.toContain('.favorite-sidebar-item:hover .favorite-sidebar-actions');
        expect(cssContent).not.toContain('.favorite-sidebar-item > button {');
    });

    it('playPrev uses state.playMode safely without referencing undefined playMode', () => {
        const playbackContent = fs.readFileSync(playbackSrcPath, 'utf8');
        // Must not contain switch (playMode) which causes ReferenceError
        expect(playbackContent).not.toContain('switch (playMode)');
        expect(playbackContent).toContain('state.playMode');
    });
});

describe('Update Notification Engine & PostHog Removal', () => {
    const notificationEnginePath = path.join(import.meta.dir, '../public/js/notification-engine.js');
    const adminHtmlPath = path.join(import.meta.dir, '../public/index.html');
    const playerHtmlPath = path.join(import.meta.dir, '../public/music/index.html');
    const swPath = path.join(import.meta.dir, '../public/sw.js');

    it('notification-engine.js should be completely removed from public/js', () => {
        expect(fs.existsSync(notificationEnginePath)).toBe(false);
    });

    it('public/index.html should not include PostHog analytics or notification-engine.js', () => {
        const content = fs.readFileSync(adminHtmlPath, 'utf8');
        expect(content.includes('posthog')).toBe(false);
        expect(content.includes('notification-engine.js')).toBe(false);
        expect(content.includes('app.checkForUpdates')).toBe(false);
    });

    it('public/music/index.html should not include PostHog analytics or notification-engine.js', () => {
        const content = fs.readFileSync(playerHtmlPath, 'utf8');
        expect(content.includes('posthog')).toBe(false);
        expect(content.includes('notification-engine.js')).toBe(false);
        expect(content.includes('checkForUpdates')).toBe(false);
    });

    it('public/sw.js should not cache notification-engine.js', () => {
        const content = fs.readFileSync(swPath, 'utf8');
        expect(content.includes('notification-engine.js')).toBe(false);
    });
});
