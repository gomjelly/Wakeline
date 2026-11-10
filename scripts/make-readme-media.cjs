// README용 미디어 만들기 (Electron으로 실행). ffmpeg 없이 Chromium으로 영상을 읽는다.
//
//   npx electron scripts/make-readme-media.cjs info  <영상>
//   npx electron scripts/make-readme-media.cjs frames <영상> <출력폴더> <간격초> [폭]
//   npx electron scripts/make-readme-media.cjs frame <영상> <초> <출력.png> [폭] [crop x,y,w,h]
//   npx electron scripts/make-readme-media.cjs gif <영상> <시작초> <끝초> <fps> <폭> <출력.gif> [crop x,y,w,h]

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const [cmd, ...rest] = process.argv.slice(2).filter((a) => !a.startsWith('--'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { webSecurity: false, offscreen: false } });
  await win.loadURL(pathToFileURL(path.join(__dirname, 'media-tool.html')).toString());
  for (let i = 0; i < 50 && !(await win.webContents.executeJavaScript('!!window.mediaReady')); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const js = (s) => win.webContents.executeJavaScript(s);
  const url = (p) => JSON.stringify(pathToFileURL(path.resolve(p)).toString());
  const crop = (s) => (s ? JSON.stringify(s.split(',').map(Number)) : 'undefined');
  const savePng = (dataUrl, out) => {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
  };

  try {
    if (cmd === 'info') {
      console.log(JSON.stringify(await js(`mediaInfo(${url(rest[0])})`)));
    } else if (cmd === 'frames') {
      const [src, outDir, every, width] = rest;
      const info = await js(`mediaInfo(${url(src)})`);
      for (let t = 0.2; t < info.duration; t += Number(every)) {
        const out = path.join(outDir, `t${t.toFixed(1).padStart(5, '0')}.png`);
        savePng(await js(`mediaFrame(${url(src)}, ${t}, ${Number(width) || 640})`), out);
      }
      console.log(`frames → ${outDir} (${info.duration.toFixed(1)}s)`);
    } else if (cmd === 'frame') {
      const [src, t, out, width, c] = rest;
      const fmt = out.endsWith('.webp') ? "'webp'" : "'png'";
      savePng(await js(`mediaFrame(${url(src)}, ${Number(t)}, ${Number(width) || 'undefined'}, ${crop(c)}, ${fmt})`), out);
      console.log(`frame → ${out}`);
    } else if (cmd === 'gif') {
      const [src, start, end, fps, width, out, c] = rest;
      const r = await js(`mediaGif(${url(src)}, ${start}, ${end}, ${fps}, ${width}, ${crop(c)})`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(r.b64, 'base64'));
      console.log(`gif → ${out} (${r.frames} frames, ${r.width}x${r.height}, ${(fs.statSync(out).size / 1e6).toFixed(2)} MB)`);
    } else {
      console.log('사용법은 파일 위쪽 주석을 보세요.');
    }
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
  app.quit();
});
