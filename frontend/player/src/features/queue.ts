import { setPlayerDrawerOpen } from './player_drawer';

declare const Sortable: any;

export interface QueueFeatureContext {
    getPlaylist: () => any[];
    setPlaylist: (playlist: any[]) => void;
    getCurrentIndex: () => number;
    setCurrentIndex: (index: number) => void;
    getAudio: () => HTMLMediaElement | null;
    playSong: (song: any, index: number) => void;
    savePlaybackState: () => void;
    closeMobileSidebar: () => void;
    applyMarqueeChecks: () => void;
    createMarqueeHtml: (text: any, className?: string) => string;
    escapeHtmlText: (text: any) => string;
    getImgUrl: (song: any) => string;
    getSourceTag: (source: any) => string;
    getQualityTags: (song: any) => string;
    showInfo: (message: string) => void;
    showSuccess: (message: string) => void;
    showSelect: (...args: any[]) => Promise<boolean>;
    resetPlayer?: () => void;
}

/**
 * Queue state is owned by the entrypoint because playback and persistence use
 * it too. Rendering and queue actions live here so that those concerns no
 * longer add another several hundred lines to the bootstrap module.
 */
export function initQueueFeature(context: QueueFeatureContext) {
    let isQueueRendered = false;

    function updateQueueBadge() {
        const playlist = context.getPlaylist();
        const queueLen = playlist ? playlist.length : 0;
        const text = queueLen > 99 ? '99+' : String(queueLen);
        const isHidden = queueLen === 0;

        const badgeEls = [
            document.getElementById('queue-badge-count'),
            document.getElementById('queue-badge-count-mobile'),
        ];

        badgeEls.forEach(badgeEl => {
            if (badgeEl) {
                badgeEl.innerText = text;
                badgeEl.classList.toggle('hidden', isHidden);
            }
        });

        const countEl = document.getElementById('queue-count');
        if (countEl) countEl.innerText = `${queueLen} SONGS`;

        const desktopBtn = document.getElementById('player-queue-btn');
        if (desktopBtn) {
            desktopBtn.setAttribute('title', queueLen > 0 ? `当前播放队列 (${queueLen})` : '当前播放队列');
            desktopBtn.setAttribute('aria-label', queueLen > 0 ? `播放队列，共 ${queueLen} 首` : '播放队列');
        }
        const mobileBtn = document.getElementById('player-queue-btn-mobile');
        if (mobileBtn) {
            mobileBtn.setAttribute('title', queueLen > 0 ? `当前播放队列 (${queueLen})` : '当前播放队列');
            mobileBtn.setAttribute('aria-label', queueLen > 0 ? `播放队列，共 ${queueLen} 首` : '播放队列');
        }
    }

    function renderQueue() {
        updateQueueBadge();

        const listContainer = document.getElementById('queue-list');
        const countEl = document.getElementById('queue-count');
        if (!listContainer) return;

        const playlist = context.getPlaylist();
        const currentIndex = context.getCurrentIndex();

        if (!playlist || playlist.length === 0) {
            listContainer.innerHTML = `
                <div class="flex flex-col items-center justify-center py-20 opacity-30 select-none">
                    <i class="fas fa-music text-4xl mb-4"></i>
                    <p class="text-xs font-bold uppercase tracking-widest">队列为空</p>
                </div>
            `;
            if (countEl) countEl.innerText = '0 SONGS';
            isQueueRendered = true;
            return;
        }

        if (countEl) countEl.innerText = `${playlist.length} SONGS`;

        listContainer.innerHTML = playlist.map((song, index) => {
            const isActive = index === currentIndex;
            return `
                <div role="button" tabindex="0" aria-label="播放 ${context.escapeHtmlText(song.name || '未命名歌曲')}"
                     class="group flex items-center gap-3 p-3 rounded-xl transition-all hover:t-bg-item-hover cursor-pointer relative border ${isActive ? 'bg-emerald-500/10 dark:bg-emerald-500/15 border-emerald-500/25 shadow-sm' : 'border-transparent'} ${index > 12 ? 'deferred-list-item' : ''}"
                     data-event-click-action="playSongFromQueue" data-event-click-args="[${index}]"
                     data-event-keydown-action="playSongFromQueue" data-event-keydown-args="[${index}]" data-event-keys="Enter, " data-event-target-self="true" data-event-prevent="true">
                    <div class="w-10 h-10 rounded-lg overflow-hidden flex-shrink-0 relative">
                        <img src="${context.getImgUrl(song)}" alt="${context.escapeHtmlText(song.name || '歌曲')}专辑封面" width="40" height="40"
                             data-event-error-action="fallback-image"
                             loading="lazy" decoding="async"
                             class="w-full h-full object-cover">
                        ${isActive ? '<div class="absolute inset-0 bg-emerald-500/20 flex items-center justify-center"><div class="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-ping"></div></div>' : ''}
                    </div>
                    <div class="flex-1 min-w-0">
                        ${context.createMarqueeHtml(song.name, 'text-sm font-bold ' + (isActive ? 'text-emerald-500' : 't-text-main'))}
                        <div class="flex items-center gap-1 mt-0.5 overflow-hidden whitespace-nowrap">
                            ${context.getSourceTag(song.source)}
                            ${context.getQualityTags(song)}
                            ${context.createMarqueeHtml(song.singer, 'text-[10px] t-text-muted flex-1')}
                        </div>
                    </div>
                    <div class="queue-row-actions flex items-center gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                        <button aria-label="从队列移除 ${context.escapeHtmlText(song.name || '歌曲')}" data-event-click-action="removeFromQueue" data-event-click-args="[${index}]" data-event-stop="true" class="p-2 text-gray-400 hover:text-red-500 transition-colors">
                            <i class="fas fa-trash-alt text-xs"></i>
                        </button>
                        <div class="p-2 text-gray-400 cursor-grab active:cursor-grabbing queue-drag-handle">
                            <i class="fas fa-grip-lines text-xs"></i>
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        if (typeof Sortable !== 'undefined' && listContainer) {
            try {
                const oldSortable = Sortable.get(listContainer);
                if (oldSortable) oldSortable.destroy();
            } catch (error) {
                console.debug('[Queue] Unable to reuse sortable instance', error);
            }

            Sortable.create(listContainer, {
                animation: 200,
                handle: '.queue-drag-handle',
                ghostClass: 'sortable-ghost-solid',
                chosenClass: 'sortable-chosen-item',
                dragClass: 'sortable-drag-item',
                forceFallback: true,
                fallbackOnBody: true,
                delay: 100,
                delayOnTouchOnly: true,
                touchStartThreshold: 3,
                onStart: () => document.body.classList.add('select-none'),
                onEnd: (event: any) => {
                    document.body.classList.remove('select-none');
                    const oldIndex = event.oldIndex;
                    const newIndex = event.newIndex;
                    if (oldIndex === newIndex || oldIndex == null || newIndex == null) return;

                    const nextPlaylist = context.getPlaylist();
                    const movedItem = nextPlaylist.splice(oldIndex, 1)[0];
                    nextPlaylist.splice(newIndex, 0, movedItem);
                    let nextCurrentIndex = context.getCurrentIndex();
                    if (nextCurrentIndex === oldIndex) {
                        nextCurrentIndex = newIndex;
                    } else if (oldIndex < nextCurrentIndex && newIndex >= nextCurrentIndex) {
                        nextCurrentIndex--;
                    } else if (oldIndex > nextCurrentIndex && newIndex <= nextCurrentIndex) {
                        nextCurrentIndex++;
                    }

                    context.setCurrentIndex(nextCurrentIndex);
                    context.setPlaylist(nextPlaylist);
                    renderQueue();
                    context.savePlaybackState();
                    context.showInfo('播放顺序已更新');
                },
            });
        }

        const tip = document.getElementById('queue-tip');
        if (tip) tip.classList.toggle('hidden', playlist.length <= 1);
        context.applyMarqueeChecks();
        isQueueRendered = true;
    }

    function scrollToCurrentSongInQueue(flash = true) {
        const listContainer = document.getElementById('queue-list');
        if (!listContainer) return;

        const activeItem = listContainer.querySelector('.border-emerald-500') as HTMLElement | null;
        if (activeItem) {
            activeItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
            if (flash) {
                activeItem.classList.add('ring-2', 'ring-emerald-500', 'ring-inset', 'ring-opacity-50');
                setTimeout(() => activeItem.classList.remove('ring-2', 'ring-emerald-500', 'ring-inset', 'ring-opacity-50'), 1000);
            }
        } else if (flash) {
            context.showInfo('当前播放歌曲不在队列中或尚未渲染');
        }
    }

    function playSongFromQueue(index: number) {
        const playlist = context.getPlaylist();
        if (!playlist[index]) return;
        context.playSong(playlist[index], index);
    }

    function removeFromQueue(index: number) {
        const playlist = context.getPlaylist();
        if (!playlist || index < 0 || index >= playlist.length) return;

        const isRemovingCurrent = index === context.getCurrentIndex();
        playlist.splice(index, 1);

        if (playlist.length === 0) {
            if (typeof context.resetPlayer === 'function') {
                context.resetPlayer();
            } else {
                context.setCurrentIndex(-1);
                context.setPlaylist([]);
                try { context.getAudio()?.pause(); } catch (error) { }
                renderQueue();
            }
            context.showSuccess('已从队列移除');
            return;
        }

        let currentIndex = context.getCurrentIndex();
        if (isRemovingCurrent) {
            if (currentIndex >= playlist.length) {
                currentIndex = 0;
            }
            context.setCurrentIndex(currentIndex);
            context.setPlaylist(playlist);
            renderQueue();
            context.playSong(playlist[currentIndex], currentIndex);
        } else {
            if (index < currentIndex) {
                currentIndex--;
            }
            context.setCurrentIndex(currentIndex);
            context.setPlaylist(playlist);
            renderQueue();
            context.savePlaybackState();
        }

        context.showSuccess('已从队列移除');
    }

    async function clearQueue() {
        const playlist = context.getPlaylist();
        if (!playlist || playlist.length === 0) return;
        if (await context.showSelect('清空队列', '确定要清空当前播放队列吗？', { danger: true })) {
            if (typeof context.resetPlayer === 'function') {
                context.resetPlayer();
            } else {
                context.setPlaylist([]);
                context.setCurrentIndex(-1);
                try { context.getAudio()?.pause(); } catch (error) { }
                renderQueue();
                context.savePlaybackState();
            }
            context.showInfo('队列已清空');
        }
    }

    function toggleQueueDrawer() {
        const drawer = document.getElementById('queue-drawer');
        if (!drawer) return;

        const isHidden = drawer.classList.contains('translate-x-full');
        if (isHidden) {
            renderQueue();
            setPlayerDrawerOpen('queue-drawer', true);
            setTimeout(() => scrollToCurrentSongInQueue(false), 350);
            if (window.innerWidth <= 1024) context.closeMobileSidebar();
        } else {
            setPlayerDrawerOpen('queue-drawer', false);
        }
    }

    function addSongToNext(song: any) {
        if (!song) return;
        const playlist = context.getPlaylist() ? [...context.getPlaylist()] : [];
        if (playlist.length === 0) {
            context.setPlaylist([song]);
            context.setCurrentIndex(0);
            renderQueue();
            context.playSong(song, 0);
            context.showSuccess(`正在播放: ${song.name || '歌曲'}`);
            return;
        }

        const currentIndex = context.getCurrentIndex();
        const insertIndex = currentIndex >= 0 ? currentIndex + 1 : playlist.length;
        playlist.splice(insertIndex, 0, song);
        context.setPlaylist(playlist);
        renderQueue();
        context.savePlaybackState();
        context.showSuccess(`已设为下一首播放: ${song.name || '歌曲'}`);
    }

    function addSongToQueue(song: any) {
        if (!song) return;
        const playlist = context.getPlaylist() ? [...context.getPlaylist()] : [];
        if (playlist.length === 0) {
            context.setPlaylist([song]);
            context.setCurrentIndex(0);
            renderQueue();
            context.playSong(song, 0);
            context.showSuccess(`正在播放: ${song.name || '歌曲'}`);
            return;
        }

        playlist.push(song);
        context.setPlaylist(playlist);
        renderQueue();
        context.savePlaybackState();
        context.showSuccess(`已添加到播放队列: ${song.name || '歌曲'}`);
    }

    const feature = {
        renderQueue,
        updateQueueBadge,
        toggleQueueDrawer,
        scrollToCurrentSongInQueue,
        playSongFromQueue,
        removeFromQueue,
        clearQueue,
        addSongToNext,
        addSongToQueue,
        get isRendered() { return isQueueRendered; },
    };

    Object.assign(window, {
        updateQueueBadge,
        toggleQueueDrawer,
        scrollToCurrentSongInQueue,
        playSongFromQueue,
        removeFromQueue,
        clearQueue,
        addSongToNext,
        addSongToQueue,
    });

    return feature;
}
