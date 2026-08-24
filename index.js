const { app, BrowserWindow, ipcMain, screen, desktopCapturer, dialog, clipboard, nativeImage, shell, globalShortcut, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

let widgetWin = null;
let overlayWin = null;
const isInstantMode = process.argv.includes('--instant') || process.argv.includes('--capture');

function createWidgetWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
  
  // Design size of the widget (sleek capsule)
  const widgetWidth = 85;
  const widgetHeight = 45;

  widgetWin = new BrowserWindow({
    width: widgetWidth,
    height: widgetHeight,
    x: screenWidth - widgetWidth - 40, // 40px padding from right
    y: 60, // 60px from top
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  widgetWin.loadFile(path.join(__dirname, 'src/widget/index.html'));

  // Handle right-click context menu to quit
  widgetWin.webContents.on('context-menu', () => {
    const menu = Menu.buildFromTemplate([
      { label: 'Quit App', click: () => app.quit() }
    ]);
    menu.popup();
  });

  // Ensure it stays on top even over full screen windows
  widgetWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  widgetWin.setAlwaysOnTop(true, 'screen-saver');

  widgetWin.on('closed', () => {
    widgetWin = null;
  });
}

async function captureScreenAndOpenOverlay(mode = 'screenshot') {
  try {
    // Hide the widget window first so it's not captured in the screenshot
    if (widgetWin && !widgetWin.isDestroyed()) {
      widgetWin.hide();
    }
    
    // Give the OS window manager a brief moment to finish hiding the window
    await new Promise(resolve => setTimeout(resolve, 150));

    // Get all displays
    const displays = screen.getAllDisplays();
    const cursorPoint = screen.getCursorScreenPoint();
    const activeDisplay = screen.getDisplayNearestPoint(cursorPoint);
    const activeIndex = displays.findIndex(d => d.id === activeDisplay.id);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    displays.forEach(d => {
      minX = Math.min(minX, d.bounds.x);
      minY = Math.min(minY, d.bounds.y);
      maxX = Math.max(maxX, d.bounds.x + d.bounds.width);
      maxY = Math.max(maxY, d.bounds.y + d.bounds.height);
    });

    const totalWidth = maxX - minX;
    const totalHeight = maxY - minY;

    const displayMeta = displays.map((d, idx) => ({
      index: idx,
      id: d.id,
      name: d.id === screen.getPrimaryDisplay().id ? `Display ${idx + 1} (Primary)` : `Display ${idx + 1}`,
      isPrimary: d.id === screen.getPrimaryDisplay().id,
      x: d.bounds.x - minX,
      y: d.bounds.y - minY,
      width: d.bounds.width,
      height: d.bounds.height,
      scaleFactor: d.scaleFactor
    }));

    // Scale factor for active display
    const scale = activeDisplay.scaleFactor;
    const bounds = activeDisplay.bounds;
    
    // Capture the screen
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: bounds.width * scale,
        height: bounds.height * scale
      }
    });
    
    // Find matching source
    let targetSource = sources.find(s => s.display_id === activeDisplay.id.toString())
      || sources.find(s => s.display_id && String(s.display_id) === String(activeDisplay.id))
      || (activeIndex !== -1 && sources[activeIndex] ? sources[activeIndex] : sources[0]);
    
    if (targetSource) {
      const dataUrl = targetSource.thumbnail.toDataURL();
      createOverlayWindow(dataUrl, bounds, mode, displayMeta, activeIndex >= 0 ? activeIndex : 0);
    }
  } catch (err) {
    console.error('Failed to capture screen:', err);
    // Restore widget window if capture failed
    if (widgetWin && !widgetWin.isDestroyed()) {
      widgetWin.show();
    } else if (isInstantMode) {
      dialog.showErrorBox('Capture Error', 'Failed to capture screen: ' + err.message);
      app.quit();
    }
  }
}

function createOverlayWindow(dataUrl, bounds, mode = 'screenshot', displayMeta = [], activeDisplayIndex = 0) {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.destroy();
  }

  overlayWin = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    movable: false,
    enableLargerThanScreen: true,
    fullscreen: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  overlayWin.loadFile(path.join(__dirname, 'src/overlay/index.html'));
  
  // Make it show on top of everything
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');

  overlayWin.webContents.once('did-finish-load', () => {
    overlayWin.webContents.send('screenshot-data', {
      dataUrl,
      width: bounds.width,
      height: bounds.height,
      mode,
      displays: displayMeta,
      activeDisplayIndex
    });
  });

  overlayWin.on('closed', () => {
    overlayWin = null;
    // Restore widget window when overlay closes
    if (isInstantMode) {
      app.quit();
    } else if (widgetWin && !widgetWin.isDestroyed()) {
      widgetWin.show();
    }
  });
}

// IPC Handlers
ipcMain.on('drag-widget', (event, { dx, dy }) => {
  if (widgetWin) {
    const [x, y] = widgetWin.getPosition();
    widgetWin.setPosition(x + dx, y + dy);
  }
});

ipcMain.on('start-capture', () => {
  captureScreenAndOpenOverlay('screenshot');
});

ipcMain.on('start-marker', () => {
  captureScreenAndOpenOverlay('marker');
});

ipcMain.on('close-overlay', () => {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.close();
  }
});

ipcMain.handle('save-screenshot', async (event, dataUrl) => {
  if (!dataUrl) return false;
  
  // Convert Data URL to buffer
  const base64Data = dataUrl.replace(/^data:image\/png;base64,/, "");
  const buffer = Buffer.from(base64Data, 'base64');
  
  const { filePath } = await dialog.showSaveDialog({
    title: 'Save Screenshot',
    defaultPath: `Screenshot_${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
    filters: [
      { name: 'PNG Images', extensions: ['png'] }
    ]
  });
  
  if (filePath) {
    try {
      fs.writeFileSync(filePath, buffer);
      return true;
    } catch (err) {
      console.error('Failed to save file:', err);
      return false;
    }
  }
  return false;
});

ipcMain.handle('copy-screenshot', async (event, dataUrl) => {
  if (!dataUrl) return false;
  
  try {
    const base64Data = dataUrl.replace(/^data:image\/png;base64,/, "");
    const buffer = Buffer.from(base64Data, 'base64');
    const image = nativeImage.createFromBuffer(buffer);
    clipboard.writeImage(image);
    return true;
  } catch (err) {
    console.error('Failed to copy to clipboard:', err);
    return false;
  }
});

ipcMain.handle('search-image', async (event, dataUrl) => {
  if (!dataUrl) return false;
  
  try {
    const base64Data = dataUrl.replace(/^data:image\/png;base64,/, "");
    const buffer = Buffer.from(base64Data, 'base64');
    
    // Google Images Search by Image Upload endpoint
    const formData = new FormData();
    formData.append('encoded_image', new Blob([buffer], { type: 'image/png' }), 'screenshot.png');
    formData.append('image_url', '');
    formData.append('sbisrc', 'cr_1_9_0');
    
    const response = await fetch('https://images.google.com/searchbyimage/upload', {
      method: 'POST',
      body: formData,
      redirect: 'manual' // We manually intercept the redirect URL
    });
    
    // Redirect Location contains search page
    const redirectUrl = response.headers.get('location');
    if (redirectUrl) {
      shell.openExternal(redirectUrl);
      return true;
    }
    return false;
  } catch (err) {
    console.error('Google Image Search failed:', err);
    return false;
  }
});

// App Lifecycle
app.whenReady().then(() => {
  if (isInstantMode) {
    captureScreenAndOpenOverlay();
  } else {
    createWidgetWindow();
    
    // Register PrintScreen global shortcut
    globalShortcut.register('PrintScreen', () => {
      captureScreenAndOpenOverlay();
    });
    
    // Register alternative shortcut: Ctrl+Shift+S
    globalShortcut.register('CommandOrControl+Shift+S', () => {
      captureScreenAndOpenOverlay();
    });
    
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWidgetWindow();
      }
    });
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
