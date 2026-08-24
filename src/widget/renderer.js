const dragHandle = document.getElementById('dragHandle') || document.querySelector('.drag-handle');
const singleBtn = document.getElementById('singleCaptureBtn');
const displayToggleBtn = document.getElementById('displayToggleBtn');
const displayBadgeNum = document.getElementById('displayBadgeNum');
const markerBtn = document.getElementById('markerBtn');
const burstBtn = document.getElementById('burstCaptureBtn');
const configBtn = document.getElementById('configBtn');
const quitBtn = document.getElementById('quitBtn');
const advancedControls = document.getElementById('advancedControls');
const inlineConfig = document.getElementById('inlineConfig');
const resetSettingsBtn = document.getElementById('resetSettingsBtn');
const captureSummary = document.getElementById('captureSummary');

const frameCountInput = document.getElementById('frameCountInput');
const frameIntervalInput = document.getElementById('frameIntervalInput');

// Target display: -2 = Auto (Cursor screen), 0 = Display 1 (Main), 1 = Display 2 (Secondary), -1 = All Screens
let targetDisplay = -2;
const displayOptions = [-2, 0, 1, -1];
const displayLabels = {
  '-2': 'Auto',
  '0': '1',
  '1': '2',
  '-1': 'All'
};

function setTargetDisplay(val) {
  targetDisplay = Number(val);
  if (displayBadgeNum) {
    displayBadgeNum.textContent = displayLabels[String(targetDisplay)] || 'Auto';
  }
  document.querySelectorAll('[data-disp-target]').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.dispTarget) === targetDisplay);
  });
  log(`Target display set to: ${targetDisplay} (${displayLabels[String(targetDisplay)]})`);
}

if (displayToggleBtn) {
  displayToggleBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const currentIdx = displayOptions.indexOf(targetDisplay);
    const nextIdx = (currentIdx + 1) % displayOptions.length;
    setTargetDisplay(displayOptions[nextIdx]);
  });
}

function getSelectedTargetDisplayParam() {
  return targetDisplay === -2 ? null : targetDisplay;
}

function log(msg) {
  console.log('[RENDERER]', msg);
  if (window.electronAPI && window.electronAPI.logMessage) {
    window.electronAPI.logMessage(msg);
  }
}

log('Widget renderer initialized');

let isDragging = false;
let startX = 0;
let dragMoved = false;
let advancedControlsVisible = false;

// Horizontal Sliding (JS Mouse Tracking)
dragHandle.addEventListener('mousedown', (e) => {
  isDragging = true;
  dragMoved = false;
  startX = e.screenX;
  log(`drag start at x=${startX}`);
  e.preventDefault();
  e.stopPropagation();
});

window.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  
  const dx = e.screenX - startX;
  startX = e.screenX;
  
  if (dx !== 0 && window.electronAPI && window.electronAPI.moveWidgetHorizontal) {
    dragMoved = true;
    window.electronAPI.moveWidgetHorizontal(dx);
  }
});

window.addEventListener('mouseup', () => {
  if (isDragging) {
    const wasClick = !dragMoved;
    log(wasClick ? 'advanced controls toggled' : 'drag end');
    isDragging = false;
    if (wasClick) {
      setAdvancedControlsVisible(!advancedControlsVisible);
    }
  }
});

// Single Screenshot Trigger
singleBtn.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  log(`Single Screenshot button clicked (target=${targetDisplay})`);
  if (window.electronAPI && window.electronAPI.startCapture) {
    window.electronAPI.startCapture(getSelectedTargetDisplayParam());
  }
});

// Marker Mode Trigger
if (markerBtn) {
  markerBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    log(`Marker button clicked (target=${targetDisplay})`);
    if (window.electronAPI && window.electronAPI.startMarker) {
      window.electronAPI.startMarker(getSelectedTargetDisplayParam());
    }
  });
}

function getFrameSettings() {
  const count = Math.min(60, Math.max(2, parseInt(frameCountInput.value, 10) || 3));
  const intervalMs = Math.min(5000, Math.max(100, parseInt(frameIntervalInput.value, 10) || 1000));
  frameCountInput.value = count;
  frameIntervalInput.value = intervalMs;
  return { count, intervalMs };
}

function updateSettingsUi() {
  const { count, intervalMs } = getFrameSettings();
  const seconds = intervalMs / 1000;
  const intervalLabel = seconds === 1 ? '1 second' : `${seconds} seconds`;
  captureSummary.textContent = `${count} ${count === 1 ? 'frame' : 'frames'}, ${intervalLabel} apart`;

  document.querySelectorAll('[data-interval]').forEach((preset) => {
    preset.classList.toggle('active', Number(preset.dataset.interval) === intervalMs);
  });
}

function setConfigOpen(open) {
  if (open && !advancedControlsVisible) {
    setAdvancedControlsVisible(true);
  }
  inlineConfig.classList.toggle('hidden', !open);
  configBtn.classList.toggle('active', open);
  window.electronAPI?.setWidgetConfigOpen?.(open).catch((error) => {
    console.error('Unable to resize frame settings panel:', error);
  });
}

function setAdvancedControlsVisible(visible) {
  if (!visible && !inlineConfig.classList.contains('hidden')) {
    inlineConfig.classList.add('hidden');
    configBtn.classList.remove('active');
    window.electronAPI?.setWidgetConfigOpen?.(false).catch((error) => {
      console.error('Unable to close frame settings panel:', error);
    });
  }

  advancedControlsVisible = visible;
  advancedControls.classList.toggle('hidden', !visible);
  dragHandle.classList.toggle('expanded', visible);
  window.electronAPI?.setWidgetExpanded?.(visible).catch((error) => {
    console.error('Unable to resize widget controls:', error);
  });
}

// Frame sequence capture trigger
burstBtn.addEventListener('click', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  const { count, intervalMs } = getFrameSettings();
  log(`Frame capture button clicked: count=${count}, intervalMs=${intervalMs}`);
  setConfigOpen(false);

  if (window.electronAPI?.startBurstCapture) {
    burstBtn.disabled = true;
    burstBtn.classList.add('capturing');
    burstBtn.title = 'Capturing frames…';
    try {
      await window.electronAPI.startBurstCapture({ count, intervalMs, targetDisplay: getSelectedTargetDisplayParam() });
    } catch (error) {
      console.error('Frame capture failed:', error);
      alert(`Frame capture failed: ${error}`);
    } finally {
      burstBtn.disabled = false;
      burstBtn.classList.remove('capturing');
      burstBtn.title = 'Capture animation frames';
    }
  }
});

// Quit App Trigger
quitBtn.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  log('Quit button clicked');
  if (window.electronAPI && window.electronAPI.quitApp) {
    window.electronAPI.quitApp();
  }
});

// Frame settings panel
configBtn.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  const opening = inlineConfig.classList.contains('hidden');
  log(`Frame settings ${opening ? 'opened' : 'closed'}`);
  setConfigOpen(opening);
});

inlineConfig.addEventListener('click', (e) => {
  e.stopPropagation();
});

document.querySelectorAll('[data-disp-target]').forEach((button) => {
  button.addEventListener('click', () => {
    setTargetDisplay(button.dataset.dispTarget);
  });
});

document.querySelectorAll('.stepper-btn').forEach((button) => {
  button.addEventListener('click', () => {
    const input = document.getElementById(button.dataset.target);
    const next = (parseInt(input.value, 10) || Number(input.min)) + Number(button.dataset.step);
    input.value = Math.min(Number(input.max), Math.max(Number(input.min), next));
    updateSettingsUi();
  });
});

document.querySelectorAll('[data-interval]').forEach((button) => {
  button.addEventListener('click', () => {
    frameIntervalInput.value = button.dataset.interval;
    updateSettingsUi();
  });
});

[frameCountInput, frameIntervalInput].forEach((input) => {
  input.addEventListener('change', updateSettingsUi);
  input.addEventListener('input', updateSettingsUi);
});

resetSettingsBtn.addEventListener('click', () => {
  frameCountInput.value = 3;
  frameIntervalInput.value = 1000;
  updateSettingsUi();
});

updateSettingsUi();
