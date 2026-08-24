// A compatibility layer to map Electron's API to Tauri APIs

(function() {
  function getInvoke() {
    if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
      return window.__TAURI__.core.invoke;
    }
    if (window.__TAURI__ && window.__TAURI__.invoke) {
      return window.__TAURI__.invoke;
    }
    if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
      return window.__TAURI_INTERNALS__.invoke;
    }
    return null;
  }

  function safeInvoke(cmd, args) {
    const inv = getInvoke();
    if (inv) {
      return inv(cmd, args);
    } else {
      console.error("[PRELOAD] Tauri invoke unavailable for command:", cmd);
      return Promise.reject("Invoke unavailable");
    }
  }

  window.electronAPI = {
    logMessage: (msg) => safeInvoke('log_message', { msg }),
    moveWidgetHorizontal: (dx) => safeInvoke('move_widget_horizontal', { dx }),
    quitApp: () => safeInvoke('quit_app'),
    getDisplays: () => safeInvoke('get_displays'),
    startCapture: (targetDisplay) => safeInvoke('start_capture', { targetDisplay: targetDisplay !== undefined ? targetDisplay : null }),
    startMarker: (targetDisplay) => safeInvoke('start_marker', { targetDisplay: targetDisplay !== undefined ? targetDisplay : null }),
    switchOverlayDisplay: (displayIdx, mode) => safeInvoke('switch_overlay_display', { displayIdx, mode: mode || 'screenshot' }),
    startBurstCapture: ({ count, intervalMs, targetDisplay }) => safeInvoke('start_burst_capture', { count: count || 3, intervalMs: intervalMs || 1000, targetDisplay: targetDisplay !== undefined ? targetDisplay : null }),
    captureRegionFrames: ({ x, y, width, height, count, intervalMs }) => safeInvoke('capture_region_frames', { x, y, width, height, count, intervalMs }),
    setWidgetConfigOpen: (open) => safeInvoke('set_widget_config_open', { open }),
    setWidgetExpanded: (expanded) => safeInvoke('set_widget_expanded', { expanded }),
    closeOverlay: () => safeInvoke('close_overlay'),
    saveScreenshot: (dataUrl) => safeInvoke('save_screenshot', { dataUrl }),
    copyScreenshot: (dataUrl) => safeInvoke('copy_screenshot', { dataUrl }),
    searchImage: (dataUrl) => safeInvoke('search_image', { dataUrl }),
    onScreenshotData: (callback) => {
      if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.listen('screenshot-data', (event) => callback(event.payload));
      }
    }
  };
})();
