// 로잉 테스트 영상 만들기 (Electron으로 실행).
//   npm run make:video
//   npx electron scripts/make-rower-video.cjs --seconds=30 --spm=24 --cam=side-rear --out=test-videos/rower-side-rear.webm
// dist/tools/rower-video/ 페이지를 띄워 3D 장면을 녹화하고 webm 파일로 저장한다.

const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const arg = (name, fallback) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : fallback;
};
const seconds = Number(arg('seconds', '30'));
const spm = Number(arg('spm', '24'));
const cam = arg('cam', 'side-rear');
const root = path.join(__dirname, '..');
const out = path.resolve(root, arg('out', `test-videos/rower-${cam}-${spm}spm.webm`));
const DIST = path.join(root, 'dist');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

app.whenReady().then(async () => {
  protocol.handle('app', (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(DIST, rel.endsWith('/') ? `${rel}index.html` : rel));
    if (!file.startsWith(DIST)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  if (!fs.existsSync(path.join(DIST, 'tools', 'rower-video', 'index.html'))) {
    console.error('dist/tools/rower-video 가 없습니다. 먼저 npm run build 를 실행하세요.');
    app.exit(1);
    return;
  }

  // 1280×720 영상. 녹화 중 화면이 멈추지 않도록 창을 띄워 둔다.
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    useContentSize: true,
    title: 'Wakeline 테스트 영상 녹화 중…',
    autoHideMenuBar: true,
    webPreferences: { backgroundThrottling: false },
  });
  await win.loadURL(`app://local/tools/rower-video/index.html?spm=${spm}&cam=${cam}`);
  await new Promise((r) => setTimeout(r, 800));

  console.log(`녹화 중: ${seconds}초, ${spm}SPM, ${cam} …`);
  const b64 = await win.webContents.executeJavaScript(`window.__record(${seconds})`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const buf = Buffer.from(b64, 'base64');
  fs.writeFileSync(out, buf);
  console.log(`저장: ${out} (${(buf.length / 1e6).toFixed(1)} MB)`);
  app.quit();
});
