export type PlayerCustomSource = {
    id?: string;
    enabled?: boolean;
    status?: string;
    supportedSources?: string[];
    owner?: string;
    isPublic?: boolean;
    [key: string]: unknown;
};

/**
 * 播放器只读取已经由管理员配置的音源。
 * 管理、上传、排序和归属转移全部位于管理后台，避免播放器继续保留
 * 可写的 DOM 管理桥接。
 */
export async function fetchPlayerCustomSources(
    username: string,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
): Promise<PlayerCustomSource[] | null> {
    try {
        const response = await fetch(`/api/custom-source/list?username=${encodeURIComponent(username || 'default')}`, {
            headers,
            signal,
        });
        if (response.status === 403) return null;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload: unknown = await response.json();
        return Array.isArray(payload) ? payload as PlayerCustomSource[] : [];
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        console.error('[CustomSource] 读取音源失败:', error);
        return [];
    }
}
