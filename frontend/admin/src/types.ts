export type AdminSong = {
    name?: string;
    singer?: string;
    [key: string]: unknown;
};

export type AdminPlaylist = {
    id: string;
    name: string;
    list?: AdminSong[];
};

export type AdminUser = {
    name: string;
    password?: string;
    passwordHash?: string;
    maxSnapshotNum?: number;
    'list.addMusicLocationType'?: 'top' | 'bottom';
};

export type AdminData = {
    defaultList?: AdminSong[];
    loveList?: AdminSong[];
    userList?: AdminPlaylist[];
};

export type AdminUserData = {
    username: string;
    data: AdminData;
};

export type InstallPromptEvent = Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

export type AdminRequest = (url: string, options?: RequestInit) => Promise<any>;
export type AdminMethod = (...args: unknown[]) => unknown;

export interface AdminApp {
    currentView: string;
    users: AdminUser[];
    allUsers: AdminUser[];
    configLoaded: boolean;
    currentUserData: AdminUserData | null;
    currentPlaylistView: number | string | null;
    editingUser: string | null;
    deferredPrompt: InstallPromptEvent | null;
    monitorTimer: ReturnType<typeof setInterval> | null;
    systemCpuHistory: number[];
    processCpuHistory: number[];
    systemMemHistory: number[];
    processMemHistory: number[];
    cacheSizeHistory: number[];
    musicSizeHistory: number[];
    request: AdminRequest;
    escapeHtml: (value: unknown) => string;
    formatFileSize: (value: number) => string;
    formatTime: (value: number) => string;
    formatUptime: (value: number) => string;
    renderViewError: (container: HTMLElement | null, message: string, retryAction?: string) => void;
    renderSongNameCell: (song: AdminSong) => string;
    bindShellEvents: AdminMethod;
    initMobileEvents: AdminMethod;
    installPWA: AdminMethod;
    login: AdminMethod;
    logout: AdminMethod;
    showApp: AdminMethod;
    switchView: AdminMethod;
    handleQuickAction: AdminMethod;
    initPlayerLink: AdminMethod;
    closeModal: AdminMethod;
    loadDashboard: AdminMethod;
    updateGreeting: AdminMethod;
    startMonitor: AdminMethod;
    updateMonitorUI: AdminMethod;
    renderMultiLineChart: AdminMethod;
    renderAllUserSelectors: AdminMethod;
    bindUsersEvents: AdminMethod;
    toggleUserDropdown: AdminMethod;
    renderUserDropdown: AdminMethod;
    renderUserSelectionGrid: AdminMethod;
    selectUser: AdminMethod;
    loadUsers: AdminMethod;
    batchDeleteUsers: AdminMethod;
    showBatchDeleteUserDialog: AdminMethod;
    toggleAllUsers: AdminMethod;
    updateUserBatchBtn: AdminMethod;
    renderUsers: AdminMethod;
    filterUsers: AdminMethod;
    showAddUserModal: AdminMethod;
    togglePasswordVisibility: AdminMethod;
    showEditPasswordModal: AdminMethod;
    saveNewPassword: AdminMethod;
    deleteUser: AdminMethod;
    showDeleteUserDialog: AdminMethod;
    showRenameUserModal: AdminMethod;
    saveRenameUser: AdminMethod;
    bindDataEvents: AdminMethod;
    loadUserData: AdminMethod;
    renderPlaylists: AdminMethod;
    viewPlaylistDetails: AdminMethod;
    deletePlaylist: AdminMethod;
    deleteSong: AdminMethod;
    viewSystemList: AdminMethod;
    editPlaylistName: AdminMethod;
    updateBatchDeleteBtn: AdminMethod;
    toggleAllSongs: AdminMethod;
    selectAllSongs: AdminMethod;
    invertSelection: AdminMethod;
    clearSelection: AdminMethod;
    batchDeleteSongs: AdminMethod;
    filterSongs: AdminMethod;
    sortSongs: AdminMethod;
    viewAllSongs: AdminMethod;
    bindConfigEvents: AdminMethod;
    loadConfig: AdminMethod;
    saveConfig: AdminMethod;
    togglePublicNonAdminAccessVisibility: AdminMethod;
    togglePublicNonAdminLocalMusicVisibility: AdminMethod;
    bindLogsEvents: AdminMethod;
    loadLogs: AdminMethod;
    bindSnapshotsEvents: AdminMethod;
    loadSnapshots: AdminMethod;
    triggerUploadSnapshot: AdminMethod;
    handleSnapshotUpload: AdminMethod;
    deleteSnapshot: AdminMethod;
    downloadSnapshot: AdminMethod;
    downloadLocalBackup: AdminMethod;
    triggerLocalRestore: AdminMethod;
    handleLocalRestore: AdminMethod;
    restoreSnapshot: AdminMethod;
    restartServer: AdminMethod;
    currentStorageTab: 'cache' | 'music';
    storageItems: StorageItem[];
    bindStorageEvents: AdminMethod;
    loadStorageData: (tab?: 'cache' | 'music') => Promise<void>;
    renderStorageList: AdminMethod;
    switchStorageTab: (tab: 'cache' | 'music') => void;
    toggleStorageAudio: (index: number) => void;
    deleteStorageItem: (index: number) => Promise<void>;
    batchDeleteStorageItems: AdminMethod;
    moveStorageItem: (index: number) => Promise<void>;
    batchMoveStorageItems: AdminMethod;
    clearStorageCache: AdminMethod;
    filterStorageSongs: AdminMethod;
    sortStorageSongs: AdminMethod;
    toggleAllStorageSongs: (checked: boolean) => void;
    selectAllStorageSongs: AdminMethod;
    invertStorageSelection: AdminMethod;
    clearStorageSelection: AdminMethod;
    updateStorageBatchBtns: AdminMethod;
}

export type StorageItem = {
    id: string;
    songmid?: string;
    name: string;
    singer: string;
    albumName: string;
    albumId?: string;
    img?: string;
    interval?: string;
    source: string;
    quality: string;
    filename: string;
    folder: 'cache' | 'music';
    subPath?: string;
    mtime: number;
    size: number;
    lyricFilename?: string;
    ext: string;
    username?: string;
    rawUsername?: string;
    hasCover?: boolean;
    hasLyric?: boolean;
    songInfo?: AdminSong;
};

export type AdminFeatureContext = {
    app: AdminApp;
};
