import { safeImageUrl, safeInlineString } from '../player_security';
import { toUserMessage } from '../player_notifications';

export interface CommentsFeatureContext {
    getActiveSong: () => any | null;
    escapeHtmlText: (value: any) => string;
}

type CommentCache = {
    pages: Record<number, any[]>;
    total: number;
    maxPage: number;
};

export function initCommentsFeature(context: CommentsFeatureContext) {
    let currentCommentType = 'hot';
    let currentCommentPage = 1;
    let isCommentLoading = false;
    let lastCommentSongId: any = null;
    let commentCache: Record<string, CommentCache> = {
        hot: { pages: {}, total: 0, maxPage: 1 },
        new: { pages: {}, total: 0, maxPage: 1 },
    };

    function clearCommentCache() {
        commentCache = {
            hot: { pages: {}, total: 0, maxPage: 1 },
            new: { pages: {}, total: 0, maxPage: 1 },
        };
        const hotCount = document.getElementById('hot-comment-count');
        const newCount = document.getElementById('new-comment-count');
        if (hotCount) hotCount.innerText = '';
        if (newCount) newCount.innerText = '';
    }

    function updatePaginationUI(total: number, maxPage: number) {
        const totalPages = maxPage || Math.ceil((total || 0) / 20) || 1;
        const pageIndicator = document.getElementById('comment-page-indicator');
        if (pageIndicator) pageIndicator.innerText = `PAGE ${currentCommentPage} / ${totalPages}`;

        const prevBtn = document.getElementById('btn-comment-prev') as HTMLButtonElement | null;
        const nextBtn = document.getElementById('btn-comment-next') as HTMLButtonElement | null;
        if (prevBtn) prevBtn.disabled = currentCommentPage <= 1;
        if (nextBtn) nextBtn.disabled = currentCommentPage >= totalPages;

        const oldInfo = document.getElementById('comment-pagination-info');
        if (oldInfo) oldInfo.innerText = `Page ${currentCommentPage}`;
    }

    function updateCommentCountLabels(total: number) {
        if (total === undefined) return;
        const countLabel = currentCommentType === 'hot' ? 'hot-comment-count' : 'new-comment-count';
        const element = document.getElementById(countLabel);
        if (element) element.innerText = total > 1000 ? `${(total / 1000).toFixed(1)}k` : String(total);
    }

    function createCommentItemHTML(comment: any, isReply = false): string {
        const timeStr = comment.timeStr || (comment.time ? new Date(comment.time).toLocaleString() : '');
        const location = comment.location ? ` • ${context.escapeHtmlText(comment.location)}` : '';
    const defaultAvatar = '/music/assets/yun-yin.png';
        const avatar = safeImageUrl(comment.avatar, defaultAvatar);
    const isDefault = avatar.includes('yun-yin.png') || !comment.avatar;
        const avatarClass = `w-8 h-8 md:w-10 md:h-10 rounded-full shadow-sm hover:scale-110 transition-transform t-bg-main flex-shrink-0 object-cover ${isDefault ? 'dynamic-logo is-placeholder p-1.5' : ''}`;

        let replyHtml = '';
        if (comment.reply && comment.reply.length > 0) {
            replyHtml = `
                <div class="comment-reply-tree mt-4 ml-2 pl-4 space-y-4">
                    ${comment.reply.map((reply: any) => createCommentItemHTML(reply, true)).join('')}
                </div>
            `;
        }

        return `
            <div class="comment-item group flex gap-3 md:gap-4 transition-all animate-fade-in-up">
                <img src="${avatar}"
                     loading="lazy" fetchpriority="low"
                     width="40" height="40" alt="${context.escapeHtmlText(comment.userName || '用户')}的头像"
                     class="${avatarClass}"
                     data-event-error-action="fallback-comment-image">
                <div class="flex-1 min-w-0">
                    <div class="flex items-center justify-between mb-1">
                        <span class="text-xs md:text-sm font-black t-text-main truncate">${context.escapeHtmlText(comment.userName || '用户')}</span>
                        <div class="flex items-center gap-1.5 text-[10px] t-text-muted font-bold">
                            <i class="far fa-thumbs-up"></i>
                            <span>${comment.likedCount || 0}</span>
                        </div>
                    </div>
                    <p class="text-xs md:text-sm t-text-muted leading-relaxed break-words whitespace-pre-wrap">${context.escapeHtmlText(comment.text || '')}</p>
                    ${comment.images && comment.images.length > 0 ? `
                        <div class="mt-2 flex flex-wrap gap-2">
                            ${comment.images.map((image: any) => {
                                const imageUrl = safeImageUrl(image);
                                return `
                                <button type="button" class="border-0 p-0 bg-transparent rounded-lg cursor-pointer hover:opacity-90 transition-opacity" aria-label="打开评论图片" data-event-click-action="window.open" data-event-click-args="[${safeInlineString(imageUrl)}, &quot;_blank&quot;, &quot;noopener&quot;]">
                                    <img src="${context.escapeHtmlText(imageUrl)}" loading="lazy" fetchpriority="low" width="200" height="300" alt="评论图片"
                                         class="w-[200px] h-[300px] object-contain rounded-lg shadow-sm"
                                         data-event-error-action="hide-parent-button">
                                </button>
                            `;
                            }).join('')}
                        </div>
                    ` : ''}
                    <div class="mt-2 flex items-center gap-3 text-[10px] t-text-muted font-bold uppercase tracking-tight">
                        <span>${timeStr}${location}</span>
                    </div>
                    ${replyHtml}
                </div>
            </div>
        `;
    }

    function renderComments(comments: any[]) {
        const list = document.getElementById('comment-list');
        if (!list) return;

        if (!comments || comments.length === 0) {
            if (currentCommentPage === 1) {
                list.innerHTML = '<div class="text-center py-20 text-gray-300 font-bold uppercase tracking-widest">暂无评论</div>';
            }
            return;
        }

        const html = comments.map((comment) => createCommentItemHTML(comment)).join('');
        if (currentCommentPage === 1) list.innerHTML = html;
        else list.insertAdjacentHTML('beforeend', html);
    }

    function getCurrentCommentCache() {
        return commentCache[currentCommentType];
    }

    async function fetchComments() {
        const song = context.getActiveSong();
        if (!song || isCommentLoading) {
            console.log('[Comment] Fetch skipped:', { hasSong: !!song, isLoading: isCommentLoading });
            return;
        }

        const loader = document.getElementById('comment-loader');
        const list = document.getElementById('comment-list');
        const pageIndicator = document.getElementById('comment-page-indicator');
        const cache = getCurrentCommentCache();
        const cachedPage = cache.pages[currentCommentPage];

        if (cachedPage) {
            console.log(`[Comment] Using cached ${currentCommentType} page ${currentCommentPage}`);
            if (list) list.innerHTML = '';
            renderComments(cachedPage);
            updateCommentCountLabels(cache.total);
            updatePaginationUI(cache.total, cache.maxPage);
            if (loader) loader.classList.add('hidden');
            isCommentLoading = false;
            return;
        }

        isCommentLoading = true;
        if (loader) loader.classList.remove('hidden');
        if (list) list.innerHTML = '';
        if (pageIndicator) pageIndicator.innerText = 'PAGE -- / --';

        const title = document.getElementById('comment-title');
        const sourceInfo = document.getElementById('comment-source-info');
        if (title) title.innerText = `${song.name} - 评论`;
        if (sourceInfo) sourceInfo.innerText = `Source: ${String(song.source || '').toUpperCase()}`;

        try {
            const response = await fetch('/api/music/comment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ songInfo: song, type: currentCommentType, page: currentCommentPage, limit: 20 }),
            });
            if (!response.ok) throw new Error(`API Error: ${response.status}`);

            const data = await response.json();
            if (data.error) throw new Error(data.error);

            const nextCache = getCurrentCommentCache();
            nextCache.pages[currentCommentPage] = data.comments;
            nextCache.total = data.total;
            nextCache.maxPage = data.maxPage || Math.ceil((data.total || 0) / 20) || 1;
            renderComments(data.comments);
            updateCommentCountLabels(data.total);
            updatePaginationUI(data.total, data.maxPage);
        } catch (error) {
            console.error('Fetch comments failed:', error);
            if (list) list.innerHTML = `<div class="text-center py-10 text-red-400 font-bold">加载失败: ${context.escapeHtmlText(toUserMessage(error))}</div>`;
        } finally {
            if (loader) loader.classList.add('hidden');
            isCommentLoading = false;
        }
    }

    function toggleCommentModal() {
        const modal = document.getElementById('comment-modal');
        const content = document.getElementById('comment-modal-content');
        if (!modal || !content) return;

        if (modal.classList.contains('hidden')) {
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            requestAnimationFrame(() => {
                content.classList.remove('translate-y-10', 'opacity-0');
                content.classList.add('translate-y-0', 'opacity-100');
            });

            const song = context.getActiveSong();
            if (song) {
                const songId = song.songmid || song.hash || song.id;
                if (lastCommentSongId !== songId) {
                    lastCommentSongId = songId;
                    clearCommentCache();
                    refreshComments();
                } else {
                    fetchComments();
                }
            } else {
                const list = document.getElementById('comment-list');
                const loader = document.getElementById('comment-loader');
                if (list) list.innerHTML = '<div class="text-center py-10 t-text-muted font-bold">请先播放歌曲</div>';
                if (loader) loader.classList.add('hidden');
            }
        } else {
            content.classList.remove('translate-y-0', 'opacity-100');
            content.classList.add('translate-y-10', 'opacity-0');
            setTimeout(() => {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }, 300);
        }
    }

    async function switchCommentType(type: string) {
        if (currentCommentType === type) return;
        currentCommentType = type;

        const hotButton = document.getElementById('tab-hot-comments');
        const newButton = document.getElementById('tab-new-comments');
        if (!hotButton || !newButton) return;
        const hotIndicator = hotButton.querySelector('div');
        const newIndicator = newButton.querySelector('div');
        if (type === 'hot') {
            hotButton.classList.add('text-emerald-600');
            hotButton.classList.remove('t-text-muted');
            hotIndicator?.classList.remove('scale-x-0');
            newButton.classList.remove('text-emerald-600');
            newButton.classList.add('t-text-muted');
            newIndicator?.classList.add('scale-x-0');
        } else {
            newButton.classList.add('text-emerald-600');
            newButton.classList.remove('t-text-muted');
            newIndicator?.classList.remove('scale-x-0');
            hotButton.classList.remove('text-emerald-600');
            hotButton.classList.add('t-text-muted');
            hotIndicator?.classList.add('scale-x-0');
        }

        await refreshComments(false);
    }

    async function refreshComments(force = true) {
        if (force) clearCommentCache();
        currentCommentPage = 1;
        await fetchComments();
    }

    async function changeCommentPage(delta: number) {
        const newPage = currentCommentPage + delta;
        if (newPage < 1 || isCommentLoading) return;
        currentCommentPage = newPage;
        await fetchComments();
        const container = document.getElementById('comment-list-container');
        if (container) container.scrollTo({ top: 0, behavior: 'smooth' });
    }

    async function toggleSongInList(listId: string, isAdd: boolean) {
        console.warn('toggleSongInList is deprecated');
    }

    const feature = {
        clearCommentCache,
        toggleCommentModal,
        switchCommentType,
        refreshComments,
        changeCommentPage,
        fetchComments,
        renderComments,
        updatePaginationUI,
        updateCommentCountLabels,
        createCommentItemHTML,
        toggleSongInList,
    };

    Object.assign(window, feature);
    return feature;
}
