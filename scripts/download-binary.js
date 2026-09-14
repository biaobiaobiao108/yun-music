const fs = require('fs');
const path = require('path');
const os = require('os');
const unzipper = require('unzipper');

/**
 * 自动下载 Chromaprint fpcalc 二进制文件 (基于 Bun 现代化网络与文件 I/O)
 * 目标目录: /public/music/bin/
 */

const TARGET_DIR = path.join(__dirname, '../public/music/bin');
const GITHUB_RELEASES_URL = 'https://github.com/acoustid/chromaprint/releases/latest';

const PLATFORMS = [
    { id: 'win-x64', platform: 'win32', arch: 'x64', fileNamePart: 'windows-x86_64.zip', target: 'fpcalc-win-x64.exe' },
    { id: 'linux-x64', platform: 'linux', arch: 'x64', fileNamePart: 'linux-x86_64.tar.gz', target: 'fpcalc-linux-x64' },
    { id: 'linux-arm64', platform: 'linux', arch: 'arm64', fileNamePart: 'linux-arm64.tar.gz', target: 'fpcalc-linux-arm64' },
    { id: 'linux-arm', platform: 'linux', arch: 'arm', fileNamePart: 'linux-armhf.tar.gz', target: 'fpcalc-linux-arm' },
    { id: 'macos', platform: 'darwin', arch: 'any', fileNamePart: 'macos-universal.tar.gz', target: 'fpcalc-macos' },
];

// 获取最新版本号 (利用原生 fetch 自动跟随重定向)
async function getLatestVersion() {
    const res = await fetch(GITHUB_RELEASES_URL, { redirect: 'follow' });
    const finalUrl = res.url || '';
    const versionMatch = finalUrl.match(/tag\/(v[\d.]+)/);
    if (versionMatch) {
        return versionMatch[1];
    }
    // 降级使用通用稳定版本
    return 'v1.5.1';
}

// 下载文件 (利用原生 fetch 与 Bun.write 零拷贝写盘)
async function downloadFile(url, dest) {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) {
        throw new Error(`下载失败，状态码: ${res.status}`);
    }
    await Bun.write(dest, res);
}

async function extractZip(filePath, destDir) {
    return new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
            .pipe(unzipper.Extract({ path: destDir }))
            .on('close', resolve)
            .on('error', reject);
    });
}

function findFile(dir, fileName) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            const found = findFile(fullPath, fileName);
            if (found) return found;
        } else if (file === fileName || (file === 'fpcalc.exe' && fileName === 'fpcalc')) {
            return fullPath;
        }
    }
    return null;
}

async function downloadPlatform(platformInfo, version, customTargetName) {
    const v = version.replace('v', '');
    const fileName = `chromaprint-fpcalc-${v}-${platformInfo.fileNamePart}`;
    const downloadUrl = `https://github.com/acoustid/chromaprint/releases/download/${version}/${fileName}`;
    const tempFilePath = path.join(TARGET_DIR, `temp-${platformInfo.id}-${fileName}`);

    console.log(`正在下载 [${platformInfo.id}]: ${fileName}...`);
    await downloadFile(downloadUrl, tempFilePath);

    const tempDir = path.join(TARGET_DIR, `extract-${platformInfo.id}`);
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

    if (fileName.endsWith('.zip')) {
        await extractZip(tempFilePath, tempDir);
    } else {
        const tarResult = Bun.spawnSync(['tar', '-xzf', tempFilePath, '-C', tempDir]);
        if (tarResult.exitCode !== 0) {
            throw new Error(`tar 解压失败: ${tarResult.stderr.toString()}`);
        }
    }

    const binaryBaseName = platformInfo.platform === 'win32' ? 'fpcalc.exe' : 'fpcalc';
    const fpcalcPath = findFile(tempDir, binaryBaseName);

    if (fpcalcPath) {
        const targetName = customTargetName || platformInfo.target;
        const finalPath = path.join(TARGET_DIR, targetName);
        fs.renameSync(fpcalcPath, finalPath);
        if (platformInfo.platform !== 'win32') {
            fs.chmodSync(finalPath, '755');
        }
        console.log(`成功安装: ${targetName}`);
    } else {
        throw new Error(`在解压后的文件中未找到 ${binaryBaseName}`);
    }

    // 清理
    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
}

async function main() {
    const isAll = process.argv.includes('--all');

    try {
        if (!isAll) {
            const platform = os.platform();
            const genericName = platform === 'win32' ? 'fpcalc.exe' : 'fpcalc';
            const targetPath = path.join(TARGET_DIR, genericName);
            if (fs.existsSync(targetPath)) {
                console.log(`已检测到目标文件 ${genericName}，跳过下载。`);
                return;
            }

            // 环境检查：如果系统中已有 fpcalc，直接复用
            const checkGlobal = Bun.spawnSync([os.platform() === 'win32' ? 'where' : 'which', 'fpcalc']);
            if (checkGlobal.exitCode === 0) {
                console.log('检测到系统环境中已安装 fpcalc，跳过外部下载。');
                return;
            }
        }

        if (!fs.existsSync(TARGET_DIR)) {
            fs.mkdirSync(TARGET_DIR, { recursive: true });
        }

        console.log('正在查询最新版本...');
        const version = await getLatestVersion();
        console.log(`最新版本: ${version}`);

        if (isAll) {
            console.log('模式: 下载所有平台二进制文件');
            for (const p of PLATFORMS) {
                try {
                    await downloadPlatform(p, version);
                } catch (err) {
                    console.error(`下载 ${p.id} 失败: ${err.message}`);
                }
            }
        } else {
            const platform = os.platform();
            const arch = os.arch();
            const p = PLATFORMS.find(item => item.platform === platform && (item.arch === 'any' || item.arch === arch));
            if (p) {
                const genericName = platform === 'win32' ? 'fpcalc.exe' : 'fpcalc';
                await downloadPlatform(p, version, genericName);
            } else {
                console.log(`未找到匹配当前平台 (${platform}-${arch}) 的预编译文件。`);
            }
        }

        console.log('任务完成！');

    } catch (error) {
        console.error('任务失败:', error.message);
        process.exit(1);
    }
}

main();
