/**
 * Zenvest MT5 EA Deep Auto-Installer
 * Deeply scans macOS and Windows file systems to locate any MQL5/Experts directory
 * and automatically deploys ZenCopyTrader.mq5.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SOURCE_EA = path.join(__dirname, '..', 'public', 'ea', 'ZenCopyTrader.mq5');

function searchForMQL5Directories(baseDir, depth = 0, maxDepth = 6) {
  const found = [];
  if (depth > maxDepth || !fs.existsSync(baseDir)) return found;

  try {
    const stats = fs.statSync(baseDir);
    if (!stats.isDirectory()) return found;

    const baseName = path.basename(baseDir).toLowerCase();
    if (baseName === 'mql5') {
      const expertsPath = path.join(baseDir, 'Experts');
      if (fs.existsSync(expertsPath)) {
        found.push(expertsPath);
      } else {
        found.push(baseDir);
      }
      return found;
    }

    if (baseName === 'experts' && baseDir.includes('MQL5')) {
      found.push(baseDir);
      return found;
    }

    const items = fs.readdirSync(baseDir);
    for (const item of items) {
      if (item.startsWith('.') || item === 'node_modules' || item === 'Library/Caches') continue;
      const fullPath = path.join(baseDir, item);
      try {
        const itemStats = fs.statSync(fullPath);
        if (itemStats.isDirectory()) {
          const subFound = searchForMQL5Directories(fullPath, depth + 1, maxDepth);
          found.push(...subFound);
        }
      } catch (e) {}
    }
  } catch (e) {}

  return found;
}

function findMT5ExpertDirectories() {
  const homeDir = os.homedir();
  const platform = os.platform();
  const targetPaths = new Set();

  console.log(`[Auto-Installer] Deep scanning file system for MT5 Data Directories on OS: ${platform}...`);

  if (platform === 'darwin') {
    // macOS Deep Search Roots
    const searchRoots = [
      path.join(homeDir, 'Library/Application Support'),
      path.join(homeDir, 'Library/Containers'),
      path.join(homeDir, '.wine'),
      path.join(homeDir, 'Desktop'),
      path.join(homeDir, 'Downloads'),
      path.join(homeDir, 'Documents')
    ];

    searchRoots.forEach(root => {
      if (fs.existsSync(root)) {
        const foundDirs = searchForMQL5Directories(root, 0, 5);
        foundDirs.forEach(d => targetPaths.add(d));
      }
    });
  } else if (platform === 'win32') {
    // Windows Search Roots
    const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
    
    [appData, localAppData].forEach(root => {
      if (fs.existsSync(root)) {
        const foundDirs = searchForMQL5Directories(root, 0, 5);
        foundDirs.forEach(d => targetPaths.add(d));
      }
    });
  }

  return Array.from(targetPaths);
}

function installEA(customPath) {
  if (!fs.existsSync(SOURCE_EA)) {
    console.error(`[Auto-Installer] Error: Source EA file missing at ${SOURCE_EA}`);
    return { success: false, installedPaths: [], message: 'Source EA file missing' };
  }

  let expertDirs = findMT5ExpertDirectories();

  if (customPath && fs.existsSync(customPath)) {
    expertDirs.unshift(customPath);
  }

  const installed = [];

  if (expertDirs.length === 0) {
    // Local workspace fallback directory
    const fallbackDir = path.join(__dirname, '..', 'installed_ea');
    if (!fs.existsSync(fallbackDir)) fs.mkdirSync(fallbackDir, { recursive: true });
    
    const targetFile = path.join(fallbackDir, 'ZenCopyTrader.mq5');
    fs.copyFileSync(SOURCE_EA, targetFile);
    console.log(`[Auto-Installer] Copied EA to workspace folder: ${fallbackDir}`);
    
    return {
      success: true,
      message: `Could not locate MT5 automatically. EA copied to workspace folder: ${fallbackDir}. Please copy it into MT5 -> File -> Open Data Folder -> MQL5/Experts`,
      installedPaths: [targetFile]
    };
  }

  expertDirs.forEach(dir => {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const destFile = path.join(dir, 'ZenCopyTrader.mq5');
      fs.copyFileSync(SOURCE_EA, destFile);
      installed.push(destFile);
      console.log(`[Auto-Installer] ✅ Installed EA successfully to: ${destFile}`);
    } catch (err) {
      console.error(`[Auto-Installer] Failed copying to ${dir}:`, err.message);
    }
  });

  return {
    success: installed.length > 0,
    message: `Successfully auto-installed ZenCopyTrader.mq5 into ${installed.length} MT5 terminal folder(s)!`,
    installedPaths: installed
  };
}

if (require.main === module) {
  const customPathArg = process.argv[2];
  const result = installEA(customPathArg);
  console.log(result.message);
}

module.exports = { installEA, findMT5ExpertDirectories };
