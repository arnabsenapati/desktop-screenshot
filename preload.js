const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  dragWidget: (delta) => ipcRenderer.send('drag-widget', delta),
  startCapture: () => ipcRenderer.send('start-capture'),
  startMarker: () => ipcRenderer.send('start-marker'),
  closeOverlay: () => ipcRenderer.send('close-overlay'),
  
  saveScreenshot: (dataUrl) => ipcRenderer.invoke('save-screenshot', dataUrl),
  copyScreenshot: (dataUrl) => ipcRenderer.invoke('copy-screenshot', dataUrl),
  searchImage: (dataUrl) => ipcRenderer.invoke('search-image', dataUrl),
  
  onScreenshotData: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on('screenshot-data', subscription);
    return () => ipcRenderer.removeListener('screenshot-data', subscription);
  }
});
