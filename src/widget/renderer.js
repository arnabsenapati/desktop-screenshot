const dragHandle = document.querySelector('.drag-handle');
const captureBtn = document.getElementById('captureBtn');

let isDragging = false;
let startX = 0;
let startY = 0;

dragHandle.addEventListener('mousedown', (e) => {
  if (window.__TAURI__) {
    window.electronAPI.dragWidget();
  } else {
    isDragging = true;
    startX = e.screenX;
    startY = e.screenY;
  }
  
  // Prevent default text selection behavior
  e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  
  const dx = e.screenX - startX;
  const dy = e.screenY - startY;
  
  startX = e.screenX;
  startY = e.screenY;
  
  window.electronAPI.dragWidget({ dx, dy });
});

window.addEventListener('mouseup', () => {
  isDragging = false;
});

window.addEventListener('mouseleave', () => {
  isDragging = false;
});

captureBtn.addEventListener('click', () => {
  window.electronAPI.startCapture();
});
