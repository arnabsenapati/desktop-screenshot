const dragHandle = document.getElementById('dragHandle') || document.querySelector('.drag-handle');
const singleBtn = document.getElementById('singleCaptureBtn');
const burstBtn = document.getElementById('burstCaptureBtn');
const configBtn = document.getElementById('configBtn');
const quitBtn = document.getElementById('quitBtn');
const inlineConfig = document.getElementById('inlineConfig');
const resetSettingsBtn = document.getElementById('resetSettingsBtn');
const captureSummary = document.getElementById('captureSummary');

const frameCountInput = document.getElementById('frameCountInput');
const frameIntervalInput = document.getElementById('frameIntervalInput');

function log(msg) {
  console.log('[RENDERER]', msg);
  if (window.electronAPI && window.electronAPI.logMessage) {
    window.electronAPI.logMessage(msg);
  }
}

log('Widget renderer initialized');

let isDragging = false;
let startX = 0;

// Horizontal Sliding (JS Mouse Tracking)
dragHandle.addEventListener('mousedown', (e) => {
  isDragging = true;
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
    window.electronAPI.moveWidgetHorizontal(dx);
  }
});

window.addEventListener('mouseup', () => {
  if (isDragging) {
    log('drag end');
    isDragging = false;
  }
});

// Single Screenshot Trigger
singleBtn.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  log('Single Screenshot button clicked');
  if (window.electronAPI && window.electronAPI.startCapture) {
    window.electronAPI.startCapture();
  }
});

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
  inlineConfig.classList.toggle('hidden', !open);
  configBtn.classList.toggle('active', open);
  window.electronAPI?.setWidgetConfigOpen?.(open).catch((error) => {
    console.error('Unable to resize frame settings panel:', error);
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
      await window.electronAPI.startBurstCapture({ count, intervalMs });
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
