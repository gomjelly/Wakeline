// Electron 메인 프로세스: 창 생성, 출력 디스플레이 선택, 전체화면, 카메라 권한, app:// 프로토콜.
const { app, BrowserWindow, ipcMain, screen, session, protocol, net, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const isDev = process.argv.includes('--dev');
const DEV_URL = 'http://127.0.0.1:5173';
const DIST_DIR = path.join(__dirname, '..', 'dist');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// ---------- 창 설정 저장 (선택한 디스플레이, 전체화면 여부) ----------
const settingsPath = () => path.join(app.getPath('userData'), 'window-settings.json');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  } catch (err) {
    console.error('설정 저장 실패', err);
  }
}

// ---------- 디스플레이 ----------
function findDisplay(id) {
  return screen.getAllDisplays().find((d) => d.id === id) ?? null;
}

function displayOfWindow(win) {
  return screen.getDisplayMatching(win.getBounds());
}

function describeDisplays(win) {
  const primaryId = screen.getPrimaryDisplay().id;
  const currentId = win ? displayOfWindow(win).id : null;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: d.label || `디스플레이 ${i + 1}`,
    width: Math.round(d.size.width * d.scaleFactor),
    height: Math.round(d.size.height * d.scaleFactor),
    primary: d.id === primaryId,
    current: d.id === currentId,
  }));
}

function centeredBounds(display, width = 1280, height = 800) {
  const wa = display.workArea;
  const w = Math.min(width, wa.width);
  const h = Math.min(height, wa.height);
  return { x: Math.round(wa.x + (wa.width - w) / 2), y: Math.round(wa.y + (wa.height - h) / 2), width: w, height: h };
}

function waitFor(win, event, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      win.removeListener(event, done);
      resolve();
    }
    win.once(event, done);
  });
}

async function setFullscreen(win, on) {
  if (win.isFullScreen() === on) return;
  const evt = on ? 'enter-full-screen' : 'leave-full-screen';
  const p = waitFor(win, evt);
  win.setFullScreen(on);
  await p;
  saveSettings({ fullscreen: on });
}

async function moveToDisplay(win, displayId, fullscreen) {
  const target = findDisplay(displayId);
  if (!target) return false;
  await setFullscreen(win, false);
  win.setBounds(centeredBounds(target));
  saveSettings({ displayId });
  if (fullscreen) await setFullscreen(win, true);
  return true;
}

// ---------- 창 ----------
let mainWindow = null;

function createWindow() {
  const settings = loadSettings();
  const display = findDisplay(settings.displayId) ?? screen.getPrimaryDisplay();

  mainWindow = new BrowserWindow({
    ...centeredBounds(display),
    title: 'Wakeline',
    backgroundColor: '#0b1220',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (settings.fullscreen) setFullscreen(mainWindow, true);
  });

  // F11: 전체화면 전환, F12: 개발자 도구
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') {
      event.preventDefault();
      setFullscreen(mainWindow, !mainWindow.isFullScreen()).then(notifyState);
    } else if (input.key === 'F12') {
      event.preventDefault();
      mainWindow.webContents.toggleDevTools();
    }
  });

  mainWindow.on('moved', notifyState);
  mainWindow.on('enter-full-screen', notifyState);
  mainWindow.on('leave-full-screen', notifyState);

  if (isDev) mainWindow.loadURL(DEV_URL);
  else mainWindow.loadURL('app://local/index.html');
}

function windowState() {
  if (!mainWindow) return null;
  return { fullscreen: mainWindow.isFullScreen(), displayId: displayOfWindow(mainWindow).id };
}

function notifyState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('window:state', windowState());
}

function notifyDisplays() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('displays:changed', describeDisplays(mainWindow));
}

// ---------- IPC ----------
ipcMain.handle('displays:list', () => describeDisplays(mainWindow));
ipcMain.handle('window:state', () => windowState());
ipcMain.handle('window:moveToDisplay', async (_e, displayId, fullscreen) => {
  const ok = await moveToDisplay(mainWindow, displayId, fullscreen);
  notifyState();
  return ok;
});
ipcMain.handle('window:setFullscreen', async (_e, on) => {
  await setFullscreen(mainWindow, Boolean(on));
  notifyState();
  return windowState();
});

// ---------- 시작 ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);

    // 빌드된 파일을 app://local/... 로 제공 (fetch, WASM, 카메라 모두 secure context에서 동작)
    protocol.handle('app', (request) => {
      const { pathname } = new URL(request.url);
      const rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
      const filePath = path.normalize(path.join(DIST_DIR, rel));
      if (!filePath.startsWith(DIST_DIR)) return new Response('Forbidden', { status: 403 });
      return net.fetch(pathToFileURL(filePath).toString());
    });

    // 카메라 권한 자동 허용 (영상은 저장/전송하지 않음)
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'media');
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');

    screen.on('display-added', notifyDisplays);
    screen.on('display-removed', notifyDisplays);
    screen.on('display-metrics-changed', notifyDisplays);

    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
