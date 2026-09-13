function getAudio() {
    return document.getElementById('audio-player') as HTMLAudioElement | null;
}

function showSuccess(message) {
    const handler = (window as any).showSuccess;
    if (typeof handler === 'function') handler(message);
}

function showInfo(message) {
    const handler = (window as any).showInfo;
    if (typeof handler === 'function') handler(message);
}

function showError(message) {
    const handler = (window as any).showError;
    if (typeof handler === 'function') handler(message);
    else console.error(message);
}

// ========================================
// Sleep timer logic
// ========================================

let sleepTimerId: ReturnType<typeof setInterval> | null = null;
let sleepTimerEnd = 0;
let sleepTimerMode: 'minutes' | 'end_of_song' | null = null;
let isFadingForSleep = false;
let savedPreSleepVolume: number | null = null;
let endOfSongHandler: (() => void) | null = null;

export function openSleepTimerModal() {
    const modal = document.getElementById('sleep-timer-modal');
    const content = document.getElementById('sleep-timer-modal-content');
    if (!modal || !content) return;

    modal.classList.remove('hidden');
    modal.classList.add('flex');

    // Trigger animation
    requestAnimationFrame(() => {
        content.classList.remove('scale-95', 'opacity-0');
        content.classList.add('scale-100', 'opacity-100');
    });

    updateSleepTimerModalUI();
}

export function closeSleepTimerModal() {
    const modal = document.getElementById('sleep-timer-modal');
    const content = document.getElementById('sleep-timer-modal-content');
    if (!modal || !content) return;

    content.classList.add('scale-95', 'opacity-0');
    content.classList.remove('scale-100', 'opacity-100');

    setTimeout(() => {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }, 300);
}

export function setSleepTimer(minutes: number) {
    cancelSleepTimer();
    sleepTimerMode = 'minutes';
    const durationMs = minutes * 60 * 1000;
    sleepTimerEnd = Date.now() + durationMs;

    startSleepTimerLoop();
    closeSleepTimerModal();
    showSuccess(`已设置 ${minutes} 分钟后停止播放`);
}

export function setSleepTimerAfterCurrent() {
    cancelSleepTimer();
    sleepTimerMode = 'end_of_song';
    const audio = getAudio();
    if (!audio || audio.paused) {
        showError('当前未在播放歌曲');
        return;
    }

    const onEnded = () => {
        finishSleepTimer(true);
    };
    endOfSongHandler = onEnded;
    audio.addEventListener('ended', onEnded, { once: true });

    const countdown = document.getElementById('sleep-timer-countdown');
    const statusCountdown = document.getElementById('status-countdown');
    const triggerIcon = document.querySelector('#sleep-timer-trigger i');
    const activeStatus = document.getElementById('active-timer-status');

    if (countdown) {
        countdown.innerText = '本首结束';
        countdown.classList.remove('hidden');
    }
    if (statusCountdown) statusCountdown.innerText = '播完本首停止';
    if (activeStatus) activeStatus.classList.remove('hidden');
    if (triggerIcon) {
        triggerIcon.classList.replace('far', 'fas');
        triggerIcon.classList.add('text-emerald-500');
    }

    closeSleepTimerModal();
    showSuccess('已设置播完当前歌曲后停止');
}

export function cancelSleepTimer() {
    if (sleepTimerId) {
        clearInterval(sleepTimerId);
        sleepTimerId = null;
    }
    sleepTimerEnd = 0;
    if (endOfSongHandler) {
        const audio = getAudio();
        if (audio) audio.removeEventListener('ended', endOfSongHandler);
        endOfSongHandler = null;
    }
    if (isFadingForSleep && savedPreSleepVolume !== null) {
        const audio = getAudio();
        if (audio) audio.volume = savedPreSleepVolume;
    }
    savedPreSleepVolume = null;
    isFadingForSleep = false;
    sleepTimerMode = null;

    const countdown = document.getElementById('sleep-timer-countdown');
    const triggerIcon = document.querySelector('#sleep-timer-trigger i');
    const activeStatus = document.getElementById('active-timer-status');

    if (countdown) countdown.classList.add('hidden');
    if (activeStatus) activeStatus.classList.add('hidden');
    if (triggerIcon) {
        triggerIcon.classList.replace('fas', 'far');
        triggerIcon.classList.remove('text-emerald-500');
    }
}

function startSleepTimerLoop() {
    const countdown = document.getElementById('sleep-timer-countdown');
    const triggerIcon = document.querySelector('#sleep-timer-trigger i');

    if (countdown) countdown.classList.remove('hidden');
    if (triggerIcon) {
        triggerIcon.classList.replace('far', 'fas');
        triggerIcon.classList.add('text-emerald-500');
    }

    updateSleepTimerDisplay();
    sleepTimerId = setInterval(() => {
        updateSleepTimerDisplay();
    }, 1000);
}

function updateSleepTimerDisplay() {
    const now = Date.now();
    const remain = sleepTimerEnd - now;

    if (remain <= 0) {
        finishSleepTimer(false);
        return;
    }

    // 在倒计时最后 5 秒执行音量柔和淡出
    if (remain <= 5000 && !isFadingForSleep) {
        const audio = getAudio();
        if (audio && !audio.paused && audio.volume > 0) {
            isFadingForSleep = true;
            savedPreSleepVolume = audio.volume;
            const fade = (window as any).fadeVolume;
            if (typeof fade === 'function') {
                void fade(0, remain);
            }
        }
    }

    const minutes = Math.floor(remain / 60000);
    const seconds = Math.floor((remain % 60000) / 1000);
    const timeStr = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

    const countdown = document.getElementById('sleep-timer-countdown');
    const statusCountdown = document.getElementById('status-countdown');

    if (countdown) countdown.innerText = timeStr;
    if (statusCountdown) statusCountdown.innerText = timeStr;
}

function finishSleepTimer(isFromEndOfSong = false) {
    const audio = getAudio();
    const originalVol = savedPreSleepVolume;
    cancelSleepTimer();

    if (audio && !audio.paused) {
        try {
            audio.pause();
        } catch (_) {}
        const handler = (window as any).updatePlayButton;
        if (typeof handler === 'function') handler(false);
        showInfo(isFromEndOfSong ? '当前歌曲播放完毕，音乐已停止 🌙' : '睡眠时间到，音乐已停止播放 🌙');
    }

    if (originalVol !== null && audio) {
        setTimeout(() => {
            audio.volume = originalVol;
        }, 500);
    }
}

function updateSleepTimerModalUI() {
    const activeStatus = document.getElementById('active-timer-status');
    const statusCountdown = document.getElementById('status-countdown');
    const customInput = document.getElementById('custom-timer-input');

    if (activeStatus) {
        if (sleepTimerMode === 'end_of_song') {
            activeStatus.classList.remove('hidden');
            if (statusCountdown) statusCountdown.innerText = '播完本首停止';
        } else if (sleepTimerEnd > Date.now()) {
            activeStatus.classList.remove('hidden');
        } else {
            activeStatus.classList.add('hidden');
        }
    }
    if (customInput) customInput.classList.add('hidden');
}

export function showCustomTimerInput() {
    const input = document.getElementById('custom-timer-input');
    if (input) input.classList.remove('hidden');
}

export function applyCustomTimer() {
    const inputEl = document.getElementById('custom-minutes');
    const val = parseInt(inputEl.value);
    if (val > 0) {
        setSleepTimer(val);
        inputEl.value = '';
    } else {
        showError('请输入正确的时间（分钟）');
    }
}

// 监听模态框外部点击关闭
document.addEventListener('mousedown', (e) => {
    const modal = document.getElementById('sleep-timer-modal');
    const content = document.getElementById('sleep-timer-modal-content');
    if (modal && !modal.classList.contains('hidden') && e.target === modal) {
        closeSleepTimerModal();
    }
});

(window as any).setSleepTimer = setSleepTimer;
(window as any).setSleepTimerAfterCurrent = setSleepTimerAfterCurrent;
(window as any).cancelSleepTimer = cancelSleepTimer;
(window as any).openSleepTimerModal = openSleepTimerModal;
(window as any).closeSleepTimerModal = closeSleepTimerModal;
(window as any).showCustomTimerInput = showCustomTimerInput;
(window as any).applyCustomTimer = applyCustomTimer;
