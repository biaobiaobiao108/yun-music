const path = require('path');

async function getDirectoryHash(dir, exclude = [], extensions = []) {
    const files = [...new Bun.Glob('**/*').scanSync({ cwd: dir, absolute: true, dot: true })]
        .filter(file => {
            const relPath = path.relative(dir, file).replace(/\\/g, '/');
            const fileName = path.basename(file);
            return !exclude.some(ex => relPath.startsWith(ex) || fileName === ex) &&
                (extensions.length === 0 || extensions.some(ext => fileName.endsWith(ext)));
        });

    // Sort files to ensure stable hash
    files.sort();

    const hash = new Bun.CryptoHasher('md5');
    for (const file of files) {
        const content = await Bun.file(file).bytes();
        const ext = path.extname(file).toLowerCase();
        const textExtensions = ['.js', '.ts', '.json', '.html', '.css', '.md', '.svg', '.txt', '.cjs', '.mjs', '.xml', '.yaml', '.yml'];

        if (textExtensions.includes(ext)) {
            // 统一将 CRLF 转换为 LF 再计算 Hash，确保跨平台一致性
            const text = new TextDecoder().decode(content).replace(/\r\n/g, '\n');
            hash.update(text);
        } else {
            hash.update(content);
        }
    }

    return hash.digest('hex');
}

const targetDir = path.resolve(__dirname, '../');

// We exclude config.js/about.md itself to avoid infinite hash changes when injecting the hash.
// Also ignore logs, data, server (dist), node_modules, .git.
const publicHash = await getDirectoryHash(path.join(targetDir, 'public'), ['js/config.js', 'about.md', 'music/about.md', 'music/bin'], []);
const srcHash = await getDirectoryHash(path.join(targetDir, 'src'), [], []);

const finalHash = new Bun.CryptoHasher('md5').update(publicHash + srcHash).digest('hex').substring(0, 7);

// Update config.js using Bun native I/O
const configPath = path.join(targetDir, 'public', 'js', 'config.js');
const configFile = Bun.file(configPath);
if (await configFile.exists()) {
    let configContent = await configFile.text();

    if (configContent.includes('buildHash:')) {
        configContent = configContent.replace(/buildHash:\s*['"][a-f0-9]+['"]/, `buildHash: '${finalHash}'`);
    } else {
        configContent = configContent.replace(/(window\.CONFIG\s*=\s*\{)/, `$1\n    buildHash: '${finalHash}',`);
    }

    await Bun.write(configPath, configContent);
    console.log(`Build hash updated to ${finalHash} in config.js`);
}
