// Renders the app's shell logo (an SVG) to PNG icons, each at its exact size so small icons stay sharp.
// usage: electron scripts/render-icon.js <svg> <out.png>:<px> [<out.png>:<px> ...]
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const [src, ...outputs] = process.argv.slice(2);
setTimeout(() => { console.error('timed out'); process.exit(1); }, 60000);

async function render(svg, outFile, size) {
  const w = new BrowserWindow({ width: size, height: size, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  const body = svg.replace('<svg ', `<svg width="${size}" height="${size}" style="display:block" `);
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<body style="margin:0;overflow:hidden;background:transparent">${body}</body>`));
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const img = await w.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
      if (!img.isEmpty()) {
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, img.resize({ width: size, height: size, quality: 'best' }).toPNG());
        console.log(`  ${outFile} (${size}x${size})`);
        break;
      }
    } catch { /* offscreen frame not ready yet; retry */ }
  }
  w.destroy();
}

app.on('window-all-closed', () => {}); // keep running between renders

app.whenReady().then(async () => {
  const svg = fs.readFileSync(src, 'utf8');
  for (const spec of outputs) {
    const i = spec.lastIndexOf(':');
    await render(svg, spec.slice(0, i), Number(spec.slice(i + 1)));
  }
  app.exit(0);
});
