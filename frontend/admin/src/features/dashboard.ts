import type { AdminFeatureContext } from '../types';

export function initDashboardFeature(context: AdminFeatureContext) {
    const app = context.app;

    async function loadDashboard() {
        app.updateGreeting();
        try {
            const status = await app.request('/api/status');
            const errorEl = document.getElementById('dashboard-error');
            if (errorEl) {
                errorEl.hidden = true;
                errorEl.innerHTML = '';
            }

            // 更新顶部概览卡片
            const statUsersEl = document.getElementById('stat-users');
            if (statUsersEl) statUsersEl.textContent = status.users;
            const statPublicAccessEl = document.getElementById('stat-public-access');
            if (statPublicAccessEl) statPublicAccessEl.textContent = status.publicAccess ? '开' : '关';
            const statCpuEl = document.getElementById('stat-cpu');
            if (statCpuEl) statCpuEl.textContent = status.cpuUsage + '%';
            const statMemoryEl = document.getElementById('stat-memory');
            if (statMemoryEl) statMemoryEl.textContent = app.formatFileSize(status.memory);

            // 更新缓存音乐与下载音乐卡片
            const cacheStats = status.cacheStats || {};
            const cacheInfo = cacheStats.cache || { fileCount: 0, totalSize: 0 };
            const musicInfo = cacheStats.music || { fileCount: 0, totalSize: 0 };

            const statCacheCount = document.getElementById('stat-cache-count');
            const statCacheSize = document.getElementById('stat-cache-size');
            if (statCacheCount) statCacheCount.textContent = `${cacheInfo.fileCount || 0} 首`;
            if (statCacheSize) statCacheSize.textContent = app.formatFileSize(cacheInfo.totalSize || 0);

            const statMusicCount = document.getElementById('stat-music-count');
            const statMusicSize = document.getElementById('stat-music-size');
            if (statMusicCount) statMusicCount.textContent = `${musicInfo.fileCount || 0} 首`;
            if (statMusicSize) statMusicSize.textContent = app.formatFileSize(musicInfo.totalSize || 0);

            // 实时监控详情
            app.updateMonitorUI(status);

            // 加载用户列表
            const users = await app.request('/api/users');
            app.allUsers = users;
            app.renderAllUserSelectors();

            // 启动定时刷新
            app.startMonitor();

        } catch (err) {
            console.error('Failed to load dashboard:', err);
            app.renderViewError(
                document.getElementById('dashboard-error'),
                '仪表盘数据加载失败: ' + err.message,
                'app.loadDashboard()'
            );
        }
    }

    function updateGreeting() {
        const hour = new Date().getHours();
        let greeting = '你好';
        if (hour < 6) greeting = '深夜好';
        else if (hour < 9) greeting = '早安';
        else if (hour < 12) greeting = '上午好';
        else if (hour < 14) greeting = '中午好';
        else if (hour < 18) greeting = '下午好';
        else if (hour < 22) greeting = '晚上好';
        else greeting = '深夜好';

        const greetingEl = document.getElementById('greeting-text');
        if (greetingEl) greetingEl.textContent = greeting;

        const dateEl = document.getElementById('dashboard-date');
        if (dateEl) {
            const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
            dateEl.textContent = '今天是 ' + new Date().toLocaleDateString('zh-CN', options);
        }
    }

    function startMonitor() {
        if (app.monitorTimer) return;
        app.monitorTimer = setInterval(async () => {
            if (app.currentView !== 'dashboard') {
                clearInterval(app.monitorTimer);
                app.monitorTimer = null;
                return;
            }
            try {
                const status = await app.request('/api/status');
                app.updateMonitorUI(status);
            } catch (e) {
                console.error('Monitor refresh failed:', e);
            }
        }, 3000);
    }

    function updateMonitorUI(status) {
        // --- CPU 监控 ---
        const sysCpuVal = parseFloat(status.cpuUsage) || 0;
        const procCpuVal = parseFloat(status.processCpuUsage) || 0;

        // 顶部概览
        const statCpu = document.getElementById('stat-cpu');
        const statProcCpu = document.getElementById('stat-process-cpu');
        if (statCpu) statCpu.textContent = sysCpuVal.toFixed(2) + '%';
        if (statProcCpu) statProcCpu.textContent = procCpuVal.toFixed(2) + '%';

        // 详情面板
        const cpuProgress = document.getElementById('monitor-cpu-progress');
        const sysCpuText = document.getElementById('monitor-cpu-val');
        const procCpuText = document.getElementById('monitor-process-cpu-val');
        if (cpuProgress) cpuProgress.style.width = Math.max(sysCpuVal, procCpuVal) + '%';
        if (sysCpuText) sysCpuText.textContent = sysCpuVal.toFixed(2) + '%';
        if (procCpuText) procCpuText.textContent = procCpuVal.toFixed(2) + '%';

        if (app.systemCpuHistory.length === 0) {
            app.systemCpuHistory.push(sysCpuVal);
            app.processCpuHistory.push(procCpuVal);
        }
        app.systemCpuHistory.push(sysCpuVal);
        app.processCpuHistory.push(procCpuVal);
        if (app.systemCpuHistory.length > 20) {
            app.systemCpuHistory.shift();
            app.processCpuHistory.shift();
        }
        app.renderMultiLineChart('cpu-chart', [
            { data: app.systemCpuHistory, color: 'rgba(59, 130, 246, 0.4)', fill: true, label: 'System' },
            { data: app.processCpuHistory, color: '#a855f7', fill: false, label: 'Process', strokeWidth: 3 }
        ]);

        // --- 内存监控 ---
        const sysMemVal = parseFloat(status.systemMemoryUsage) || 0;
        const procMemVal = parseFloat(status.processMemoryUsage) || 0;

        // 顶部概览
        const statMemPerc = document.getElementById('stat-memory-percent');
        const statProcMemPerc = document.getElementById('stat-process-memory-percent');
        const statMemAbs = document.getElementById('stat-memory');
        if (statMemPerc) statMemPerc.textContent = sysMemVal.toFixed(2) + '%';
        if (statProcMemPerc) statProcMemPerc.textContent = procMemVal.toFixed(2) + '%';
        if (statMemAbs) statMemAbs.textContent = app.formatFileSize(status.memory);

        // 详情面板
        const memProgress = document.getElementById('monitor-mem-progress');
        const sysMemText = document.getElementById('monitor-mem-val');
        const procMemText = document.getElementById('monitor-process-mem-val');
        if (memProgress) memProgress.style.width = sysMemVal + '%';
        if (sysMemText) sysMemText.textContent = sysMemVal.toFixed(2) + '%';
        if (procMemText) procMemText.textContent = procMemVal.toFixed(2) + '%';

        if (app.systemMemHistory.length === 0) {
            app.systemMemHistory.push(sysMemVal);
            app.processMemHistory.push(procMemVal);
        }
        app.systemMemHistory.push(sysMemVal);
        app.processMemHistory.push(procMemVal);
        if (app.systemMemHistory.length > 20) {
            app.systemMemHistory.shift();
            app.processMemHistory.shift();
        }
        app.renderMultiLineChart('mem-chart', [
            { data: app.systemMemHistory, color: 'rgba(16, 185, 129, 0.4)', fill: true, label: 'System' },
            { data: app.processMemHistory, color: '#3b82f6', fill: false, label: 'Process', strokeWidth: 3 }
        ]);

        // --- 状态与概览更新 ---
        const statUsers = document.getElementById('stat-users');
        const statPublicAccess = document.getElementById('stat-public-access');
        const statUptime = document.getElementById('stat-uptime');
        if (statUsers) statUsers.textContent = status.users;
        if (statPublicAccess) statPublicAccess.textContent = status.publicAccess ? '开' : '关';
        if (statUptime) statUptime.textContent = app.formatUptime(status.uptime);

        // 更新硬件详情
        const statCpuInfo = document.getElementById('stat-cpu-info');
        if (statCpuInfo) {
            const speedGhz = (status.cpuSpeed / 1000).toFixed(1);
            statCpuInfo.textContent = `${status.cpus} Cores @ ${speedGhz}GHz`;
        }

        // --- 缓存与下载音乐监控卡片更新 ---
        if (status.cacheStats) {
            const cacheInfo = status.cacheStats.cache || { fileCount: 0, totalSize: 0 };
            const musicInfo = status.cacheStats.music || { fileCount: 0, totalSize: 0 };
            const statCacheCount = document.getElementById('stat-cache-count');
            const statCacheSize = document.getElementById('stat-cache-size');
            if (statCacheCount) statCacheCount.textContent = `${cacheInfo.fileCount || 0} 首`;
            if (statCacheSize) statCacheSize.textContent = app.formatFileSize(cacheInfo.totalSize || 0);

            const statMusicCount = document.getElementById('stat-music-count');
            const statMusicSize = document.getElementById('stat-music-size');
            if (statMusicCount) statMusicCount.textContent = `${musicInfo.fileCount || 0} 首`;
            if (statMusicSize) statMusicSize.textContent = app.formatFileSize(musicInfo.totalSize || 0);

            // 进度条与占比计算 (以配额限制为基准，默认2000MB)
            const cacheLimitMb = Number(status.cacheLimit) || 2000;
            const cacheLimitBytes = cacheLimitMb * 1024 * 1024;
            const cachePercent = Math.min(100, Math.max(0, ((cacheInfo.totalSize || 0) / cacheLimitBytes) * 100));
            const musicPercent = Math.min(100, Math.max(0, ((musicInfo.totalSize || 0) / cacheLimitBytes) * 100));

            const cacheProgress = document.getElementById('monitor-cache-progress');
            if (cacheProgress) {
                const widthVal = (cacheInfo.fileCount || 0) > 0 ? Math.max(cachePercent, 2) : 0;
                cacheProgress.style.width = widthVal.toFixed(1) + '%';
                cacheProgress.title = `配额占用: ${cachePercent.toFixed(1)}% (配额上限: ${cacheLimitMb} MB)`;
            }

            const musicProgress = document.getElementById('monitor-music-progress');
            if (musicProgress) {
                const widthVal = (musicInfo.fileCount || 0) > 0 ? Math.max(musicPercent, 2) : 0;
                musicProgress.style.width = widthVal.toFixed(1) + '%';
                musicProgress.title = `下载存储占用: ${app.formatFileSize(musicInfo.totalSize || 0)} (${musicInfo.fileCount || 0} 首)`;
            }

            // 缓存与下载音乐历史趋势图表
            if (app.cacheSizeHistory.length === 0) {
                app.cacheSizeHistory.push(cachePercent);
            }
            app.cacheSizeHistory.push(cachePercent);
            if (app.cacheSizeHistory.length > 20) {
                app.cacheSizeHistory.shift();
            }

            if (app.musicSizeHistory.length === 0) {
                app.musicSizeHistory.push(musicPercent);
            }
            app.musicSizeHistory.push(musicPercent);
            if (app.musicSizeHistory.length > 20) {
                app.musicSizeHistory.shift();
            }

            app.renderMultiLineChart('cache-chart', [
                { data: app.cacheSizeHistory, color: 'rgba(16, 185, 129, 0.4)', fill: true, label: 'Cache' }
            ]);

            app.renderMultiLineChart('music-chart', [
                { data: app.musicSizeHistory, color: 'rgba(139, 92, 246, 0.4)', fill: true, label: 'Music' }
            ]);
        }
    }

    function renderMultiLineChart(svgId, series) {
        const svg = document.getElementById(svgId);
        if (!svg) return;

        const width = 200;
        const height = 60;
        const padding = 5;

        // 检查 svg 是否已经初始化过持久化结构
        let defs = svg.querySelector('defs');
        if (!defs) {
            defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
            svg.appendChild(defs);
        }

        series.forEach((s, idx) => {
            if (s.data.length < 2) return;

            const points = s.data.map((val, i) => {
                const x = (i / (s.data.length - 1)) * width;
                const y = height - (Math.max(val, 2) / 100) * (height - padding * 2) - padding;
                return { x, y };
            });

            // 二次贝塞尔曲线平滑处理
            let d = `M ${points[0].x} ${points[0].y}`;
            for (let i = 0; i < points.length - 1; i++) {
                const xc = (points[i].x + points[i + 1].x) / 2;
                const yc = (points[i].y + points[i + 1].y) / 2;
                d += ` Q ${points[i].x} ${points[i].y} ${xc} ${yc}`;
            }
            d += ` L ${points[points.length - 1].x} ${points[points.length - 1].y}`;

            const gradId = `grad-${svgId}-${idx}`;
            const fillPathId = `${svgId}-fill-${idx}`;
            const linePathId = `${svgId}-line-${idx}`;

            if (s.fill) {
                const fillD = d + ` L ${width} ${height} L 0 ${height} Z`;
                let grad = defs.querySelector(`#${gradId}`);
                if (!grad) {
                    grad = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
                    grad.id = gradId;
                    grad.setAttribute('x1', '0%');
                    grad.setAttribute('y1', '0%');
                    grad.setAttribute('x2', '0%');
                    grad.setAttribute('y2', '100%');
                    grad.innerHTML = `
                        <stop offset="0%" style="stop-color:${s.color};stop-opacity:0.3" />
                        <stop offset="100%" style="stop-color:${s.color};stop-opacity:0" />
                    `;
                    defs.appendChild(grad);
                }

                let fillPath = svg.querySelector(`#${fillPathId}`);
                if (!fillPath) {
                    fillPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                    fillPath.id = fillPathId;
                    fillPath.setAttribute('fill', `url(#${gradId})`);
                    svg.appendChild(fillPath);
                }
                fillPath.setAttribute('d', fillD);
            }

            let linePath = svg.querySelector(`#${linePathId}`);
            if (!linePath) {
                linePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                linePath.id = linePathId;
                linePath.setAttribute('fill', 'none');
                linePath.setAttribute('stroke', s.color);
                linePath.setAttribute('stroke-width', String(s.strokeWidth || 2));
                linePath.setAttribute('stroke-linecap', 'round');
                svg.appendChild(linePath);
            }
            linePath.setAttribute('d', d);
        });
    }
    return {
        loadDashboard,
        updateGreeting,
        startMonitor,
        updateMonitorUI,
        renderMultiLineChart,
    };
}
