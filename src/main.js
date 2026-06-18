'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell } = require('electron');

const { Config } = require('./config');
const { SightingStore } = require('./services/store');
const { Pipeline } = require('./services/pipeline');
const { demoFetchPosts, DemoLlmClient } = require('./services/demo');

let mainWindow = null;
let config = null;
let store = null;
let pipeline = null;

function buildPipeline() {
  // Tear down any previous pipeline (e.g. after a settings change).
  if (pipeline) {
    pipeline.stop();
    pipeline.removeAllListeners();
  }

  const overrides = {};
  if (config.get('demo')) {
    overrides.fetchPosts = demoFetchPosts;
    overrides.llm = new DemoLlmClient();
  }

  pipeline = new Pipeline({ config, store, overrides });

  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  };

  pipeline.on('status', (s) => send('pipeline:status', s));
  pipeline.on('sighting', ({ sighting }) => send('pipeline:sighting', sighting));
  pipeline.on('post', (p) =>
    send('pipeline:post', {
      id: p.post.id,
      link: p.post.link,
      text: p.post.text,
      date: p.post.date,
      isRelevant: p.extraction.isRelevant,
      summary: p.extraction.summary,
      sightingCount: p.extraction.sightings.length,
    })
  );
  pipeline.on('error', (err) => send('pipeline:error', { message: err.message }));
  pipeline.on('tick', (t) => send('pipeline:tick', t));

  return pipeline;
}

function registerIpc() {
  ipcMain.handle('app:bootstrap', () => ({
    config: config.publicView(),
    sightings: store.all(),
  }));

  ipcMain.handle('monitor:start', () => {
    if (!config.get('demo') && !config.get('openrouterApiKey')) {
      return { ok: false, error: 'No OpenRouter API key set. Add one in Settings or enable Demo mode.' };
    }
    buildPipeline();
    pipeline.start();
    return { ok: true };
  });

  ipcMain.handle('monitor:stop', () => {
    if (pipeline) pipeline.stop();
    return { ok: true };
  });

  ipcMain.handle('monitor:pollOnce', async () => {
    if (!pipeline) buildPipeline();
    const res = await pipeline.pollOnce();
    return { ok: true, ...res };
  });

  ipcMain.handle('settings:get', () => config.publicView());

  ipcMain.handle('settings:update', (_e, patch) => {
    const view = config.update(patch || {});
    // Rebuild pipeline so new settings (key, model, demo, channel) take effect.
    const wasRunning = pipeline && pipeline.running;
    buildPipeline();
    if (wasRunning) pipeline.start();
    return view;
  });

  ipcMain.handle('sightings:all', () => store.all());

  ipcMain.handle('sightings:clear', () => {
    store.clear();
    return { ok: true };
  });

  ipcMain.handle('app:openExternal', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
    return { ok: true };
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b1622',
    title: 'The Big Drone Detector',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Open external links (Telegram, etc.) in the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  const userDataDir = app.getPath('userData');
  config = new Config({ rootDir: path.join(__dirname, '..'), userDataDir });
  store = new SightingStore({
    filePath: path.join(userDataDir, 'sightings.json'),
    retentionHours: config.get('retentionHours'),
  });

  registerIpc();
  buildPipeline();
  createWindow();

  // Dev/QA hook: render a populated demo screenshot, then exit.
  if (process.env.DDX_SCREENSHOT) {
    runScreenshot(process.env.DDX_SCREENSHOT);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

async function runScreenshot(outPath) {
  try {
    config.update({ demo: true });
    buildPipeline();
    await new Promise((r) => setTimeout(r, 1500));
    await pipeline.pollOnce();
    await new Promise((r) => setTimeout(r, 2000));
    const img = await mainWindow.webContents.capturePage();
    fs.writeFileSync(outPath, img.toPNG());
    console.log('[screenshot] written to', outPath);
  } catch (err) {
    console.error('[screenshot] failed:', err);
  } finally {
    app.quit();
  }
}

app.on('window-all-closed', () => {
  if (pipeline) pipeline.stop();
  if (process.platform !== 'darwin') app.quit();
});
