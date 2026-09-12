import type { DownloadManager } from './legacy/download_manager';
import type { SongListManagerApi } from './legacy/songlist_manager';

let songListManager: SongListManagerApi | null = null;
let downloadManager: DownloadManager | null = null;
let adminSessionChecker: (() => boolean) | null = null;

export function registerSongListManager(manager: SongListManagerApi): void {
    songListManager = manager;
}

export function registerDownloadManager(manager: DownloadManager): void {
    downloadManager = manager;
}

export function getSongListManager(): SongListManagerApi | null {
    return songListManager;
}

export function getDownloadManager(): DownloadManager | null {
    return downloadManager;
}

/**
 * Legacy feature modules are loaded lazily, so they use this typed service
 * accessor instead of reading the removed browser-side admin password.
 */
export function registerAdminSessionChecker(checker: () => boolean): void {
    adminSessionChecker = checker;
}

export function isAdminSessionActive(): boolean {
    return adminSessionChecker?.() ?? false;
}
