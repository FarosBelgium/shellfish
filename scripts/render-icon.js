// Renders the app's shell logo (src/renderer/assets/shell.svg) to the PNG icons.
// usage: npm run icons
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const [src, outFile, sizeArg, bg] = process.argv.slice(2); // svg, png, px, background
const size = +sizeArg;
setTimeout(() => process.exit(1), 20000);
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: size, height: size, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  const raw = fs.readFileSync(src, 'utf8');
  const body = src.endsWith('.svg') ? raw.replace('<svg ', `<svg width="${size}" height="${size}" style="display:block" `) : raw;
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<body style="margin:0;overflow:hidden;background:${bg || 'transparent'}">${body}</body>`));
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 400));
    try {
      const img = await w.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
      if (!img.isEmpty()) { fs.writeFileSync(outFile, img.resize({ width: size, height: size }).toPNG()); break; }
    } catch (e) { console.error('retry', e.message); }
  }
  app.exit(0);
});
