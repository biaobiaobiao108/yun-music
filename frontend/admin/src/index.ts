/*
 * Copyright 2026 xcq0607 (https://github.com/xcq0607)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { initAdminAccessibility } from './accessibility';
import { createAdminRequest } from './api';
import { initConfigFeature } from './features/config';
import { initDashboardFeature } from './features/dashboard';
import { initDataFeature } from './features/data';
import { initLogsFeature } from './features/logs';
import { initShellFeature } from './features/shell';
import { initSnapshotsFeature } from './features/snapshots';
import { initStorageFeature } from './features/storage';
import { initUsersFeature } from './features/users';
import type { AdminApp, AdminRequest, AdminUser, AdminUserData, InstallPromptEvent, StorageItem } from './types';
import {
    escapeHtml,
    formatFileSize,
    formatMemory,
    formatTime,
    formatUptime,
    renderViewError,
    safeInlineString,
    safeResourceUrl,
    stringToColor,
} from './utils';

class App {
    currentView = 'dashboard';
    users: AdminUser[] = [];
    allUsers: AdminUser[] = [];
    configLoaded = false;
    currentUserData: AdminUserData | null = null;
    currentPlaylistView: number | string | null = null;
    currentStorageTab: 'cache' | 'music' = 'cache';
    storageItems: StorageItem[] = [];
    editingUser: string | null = null;
    deferredPrompt: InstallPromptEvent | null = null;
    monitorTimer: ReturnType<typeof setInterval> | null = null;
    systemCpuHistory: number[] = [];
    processCpuHistory: number[] = [];
    systemMemHistory: number[] = [];
    processMemHistory: number[] = [];
    request: AdminRequest;

    constructor() {
        const featureApp = this as unknown as AdminApp;
        this.request = createAdminRequest((message) => featureApp.logout(message));
        this.initializeFeatures();
        this.init();
    }

    private initializeFeatures(): void {
        const sharedMethods = {
            escapeHtml,
            formatFileSize,
            formatMemory,
            formatTime,
            formatUptime,
            renderViewError,
            safeInlineString,
            safeResourceUrl,
            stringToColor,
        };

        Object.assign(
            this,
            sharedMethods,
            initShellFeature({ app: this as unknown as AdminApp }),
            initDashboardFeature({ app: this as unknown as AdminApp }),
            initUsersFeature({ app: this as unknown as AdminApp }),
            initStorageFeature({ app: this as unknown as AdminApp }),
            initDataFeature({ app: this as unknown as AdminApp }),
            initConfigFeature({ app: this as unknown as AdminApp }),
            initLogsFeature({ app: this as unknown as AdminApp }),
            initSnapshotsFeature({ app: this as unknown as AdminApp }),
        );
    }

    private init(): void {
        initAdminAccessibility();

        this.bindShellEvents();
        this.bindUsersEvents();
        this.bindStorageEvents();
        this.bindDataEvents();
        this.bindConfigEvents();
        this.bindLogsEvents();
        this.bindSnapshotsEvents();

        void this.restoreSession();
    }

    private async restoreSession(): Promise<void> {
        try {
            const response = await fetch('/api/stats', {
                credentials: 'same-origin',
                cache: 'no-store',
            });
            if (!response.ok) return;
            const featureApp = this as unknown as AdminApp;
            featureApp.showApp();
            await Promise.all([featureApp.loadConfig(), featureApp.loadDashboard()]);
        } catch {
            const notice = window.sessionStorage.getItem('lx_auth_notice');
            if (notice) {
                window.sessionStorage.removeItem('lx_auth_notice');
                const errorEl = document.getElementById('login-error');
                if (errorEl) errorEl.textContent = notice;
            }
        }
    }
}

const app = new App();
