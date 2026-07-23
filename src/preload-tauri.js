// A compatibility layer to map Electron's API to Tauri APIs

(function() {
  if (window.__TAURI__) {
    const { invoke } = window.__TAURI__.core;
    const { listen } = window.__TAURI__.event;
    const { getCurrentWindow } = window.__TAURI__.window;

    window.electronAPI = {
      dragWidget: async () => {
        try {
          await getCurrentWindow().startDragging();
        } catch (e) {
          console.error("Window drag failed:", e);
        }
      },
      
      startCapture: () => {
        invoke('start_capture');
      },
      
      closeOverlay: () => {
        invoke('close_overlay');
      },
      
      saveScreenshot: (dataUrl) => {
        return invoke('save_screenshot', { dataUrl });
      },
      
      copyScreenshot: (dataUrl) => {
        return invoke('copy_screenshot', { dataUrl });
      },
      
      searchImage: (dataUrl) => {
        return invoke('search_image', { dataUrl });
      },
      
      onScreenshotData: (callback) => {
        let unlistenFn = null;
        listen('screenshot-data', (event) => {
          callback(event.payload);
        }).then(fn => {
          unlistenFn = fn;
        });
        
        return () => {
          if (unlistenFn) {
            unlistenFn();
          }
        };
      }
    };
  } else {
    console.error("Tauri global API not found. Please ensure 'withGlobalTauri' is enabled in tauri.conf.json.");
  }
})();
