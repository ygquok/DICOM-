'use strict';

/**
 * Renders llm-principle.svg to llm-principle.png using Electron's offscreen
 * capture. Run:  electron render-png.cjs   (or: npx electron render-png.cjs)
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const INPUT = path.join(__dirname, 'llm-principle.svg');
const OUTPUT = path.join(__dirname, 'llm-principle.png');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 920,
      useContentSize: true,
      paintWhenInitiallyHidden: true,
      backgroundColor: '#f5f7fb',
      webPreferences: { offscreen: false },
    });

    await win.loadFile(INPUT);
    await delay(600); // let fonts/layout settle

    const size = await win.webContents.executeJavaScript(
      '({ w: Math.max(1280, document.documentElement.scrollWidth), h: Math.max(920, document.documentElement.scrollHeight) })',
    );
    win.setContentSize(size.w, size.h);
    await delay(300);

    const image = await win.webContents.capturePage();
    fs.writeFileSync(OUTPUT, image.toPNG());
    console.log('OK ' + OUTPUT + '  ' + size.w + 'x' + size.h + '  ' + image.getSize().width + 'x' + image.getSize().height);
  } catch (e) {
    console.error('FAILED:', e && e.message ? e.message : e);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
