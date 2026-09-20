import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.join(import.meta.dir, '..');
const adminSourceRoot = path.join(projectRoot, 'frontend/admin/src');
const adminEntryPath = path.join(adminSourceRoot, 'index.ts');
const adminHtmlPath = path.join(projectRoot, 'public/index.html');

function readAdminSources(): string {
    const files = fs.readdirSync(adminSourceRoot, { withFileTypes: true });
    return files
        .filter(file => file.isFile() && file.name.endsWith('.ts'))
        .map(file => fs.readFileSync(path.join(adminSourceRoot, file.name), 'utf8'))
        .concat(
            fs.readdirSync(path.join(adminSourceRoot, 'features'), { withFileTypes: true })
                .filter(file => file.isFile() && file.name.endsWith('.ts'))
                .map(file => fs.readFileSync(path.join(adminSourceRoot, 'features', file.name), 'utf8'))
        )
        .join('\n');
}

describe('Admin frontend modular entrypoint', () => {
    it('keeps the entrypoint as a small composition root', () => {
        const entry = fs.readFileSync(adminEntryPath, 'utf8');
        expect(entry.split(/\r?\n/).length).toBeLessThan(250);
        expect(entry).toContain('initDashboardFeature');
        expect(entry).toContain('initSnapshotsFeature');
        expect(entry).not.toContain('(window as any).app = app;');
        expect(entry).toContain('initAdminAccessibility');
    });

    it('uses delegated admin actions without inline handlers or a window app bridge', () => {
        const html = fs.readFileSync(adminHtmlPath, 'utf8');
        const source = readAdminSources();
        expect(html).toContain('data-admin-action=');
        expect(html).not.toMatch(/\bon[a-z]+\s*=\s*["']/i);
        expect(source).not.toMatch(/\bonclick\s*=/i);
        expect(source).not.toContain('window.app');
    });

    it('ensures all views are siblings and balanced in html structure', () => {
        const html = fs.readFileSync(adminHtmlPath, 'utf8');
        const lines = html.split(/\r?\n/);
        let divDepth = 0;
        const viewDepths: Record<string, number> = {};
        for (const line of lines) {
            const opens = (line.match(/<div\b/g) || []).length;
            const closes = (line.match(/<\/div>/g) || []).length;
            divDepth += opens - closes;
            const viewMatch = line.match(/id="(view-[a-z0-9-]+)"/);
            if (viewMatch) {
                viewDepths[viewMatch[1]] = divDepth;
            }
        }
        expect(divDepth).toBe(0);
        const expectedViews = [
            'view-dashboard',
            'view-users',
            'view-storage',
            'view-data',
            'view-config',
            'view-logs',
            'view-snapshots',
            'view-about',
        ];
        for (const viewId of expectedViews) {
            expect(viewDepths[viewId]).toBe(3);
        }
    });
});

