const canvas = document.getElementById('screenshotCanvas');
const ctx = canvas.getContext('2d');
const sizeBadge = document.getElementById('sizeBadge');
const drawingToolbar = document.getElementById('drawingToolbar');
const actionToolbar = document.getElementById('actionToolbar');

// Tool buttons
const toolButtons = document.querySelectorAll('.tool-btn');
const undoBtn = document.getElementById('undoBtn');

// Action buttons
const searchBtn = document.getElementById('searchBtn');
const copyBtn = document.getElementById('copyBtn');
const saveBtn = document.getElementById('saveBtn');
const closeBtn = document.getElementById('closeBtn');

// Color picker elements
const colorPreview = document.getElementById('colorPreview');
const colorPopover = document.getElementById('colorPopover');
const colorSwatches = document.querySelectorAll('.color-swatch');
const customColorInput = document.getElementById('customColorInput');

// Resize handle elements
const resizeHandles = {
  'top-left': document.querySelector('.resize-handle.top-left'),
  'top': document.querySelector('.resize-handle.top'),
  'top-right': document.querySelector('.resize-handle.top-right'),
  'right': document.querySelector('.resize-handle.right'),
  'bottom-right': document.querySelector('.resize-handle.bottom-right'),
  'bottom': document.querySelector('.resize-handle.bottom'),
  'bottom-left': document.querySelector('.resize-handle.bottom-left'),
  'left': document.querySelector('.resize-handle.left')
};

// Application State
let selection = { x: 0, y: 0, w: 0, h: 0 };
let hasSelection = false;
let currentTool = 'select'; // select, pen, line, arrow, rect, highlight, text
let currentColor = '#ef4444'; // Red default
let currentWidth = 2.5;

let drawingActions = []; // stack of committed shapes
let activeShape = null; // shape in progress

let screenshotImg = new Image();
let scaleFactor = 1;
let logicalWidth = 1920;
let logicalHeight = 1080;

let isSelecting = false;
let isMoving = false;
let isResizing = false;
let activeHandle = null;

let mouseStart = { x: 0, y: 0 };
let moveOffset = { x: 0, y: 0 };
let selectionStart = { x: 0, y: 0, w: 0, h: 0 };

let dashOffset = 0;
let antsInterval = null;

// Text tool state
let isEditingText = false;
let activeTextarea = null;

// Initialize
window.electronAPI.onScreenshotData((data) => {
  logicalWidth = data.width;
  logicalHeight = data.height;
  
  screenshotImg.onload = () => {
    scaleFactor = screenshotImg.naturalWidth / logicalWidth;
    
    // Set canvas resolution for high-DPI displays
    canvas.width = logicalWidth * scaleFactor;
    canvas.height = logicalHeight * scaleFactor;
    canvas.style.width = `${logicalWidth}px`;
    canvas.style.height = `${logicalHeight}px`;
    
    // Draw initial state
    draw();
  };
  screenshotImg.src = data.dataUrl;
});

// Update Color
function setColor(color) {
  currentColor = color;
  colorPreview.style.backgroundColor = color;
  customColorInput.value = color;
  if (activeTextarea) {
    activeTextarea.element.style.color = color;
  }
}

// Color Picker Popover Toggle
colorPreview.addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = colorPopover.style.display === 'grid';
  colorPopover.style.display = isOpen ? 'none' : 'grid';
});

document.addEventListener('click', () => {
  colorPopover.style.display = 'none';
});

colorPopover.addEventListener('click', (e) => {
  e.stopPropagation();
});

colorSwatches.forEach(swatch => {
  swatch.addEventListener('click', () => {
    setColor(swatch.dataset.color);
    colorPopover.style.display = 'none';
  });
});

customColorInput.addEventListener('input', (e) => {
  setColor(e.target.value);
});

customColorInput.addEventListener('change', () => {
  colorPopover.style.display = 'none';
});

// Tool Selection
toolButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.classList.contains('disabled')) return;
    
    // Commit text if we click another tool
    if (isEditingText) commitText();
    
    const tool = btn.dataset.tool;
    if (tool) {
      currentTool = tool;
      document.querySelector('.tool-btn.active')?.classList.remove('active');
      btn.classList.add('active');
      
      // Update cursor based on tool
      if (currentTool === 'select') {
        canvas.style.cursor = 'crosshair';
      } else {
        canvas.style.cursor = 'crosshair';
      }
    }
  });
});

// Drawing Engine shapes drawer
function drawShapeOnCtx(c, shape) {
  c.strokeStyle = shape.color;
  c.fillStyle = shape.color;
  c.lineWidth = shape.width;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  
  switch(shape.type) {
    case 'pen':
      if (shape.points.length < 2) return;
      c.beginPath();
      c.moveTo(shape.points[0].x, shape.points[0].y);
      for(let i = 1; i < shape.points.length; i++) {
        c.lineTo(shape.points[i].x, shape.points[i].y);
      }
      c.stroke();
      break;
      
    case 'highlight':
      if (shape.points.length < 2) return;
      c.save();
      c.globalAlpha = 0.45;
      c.lineWidth = 14;
      c.beginPath();
      c.moveTo(shape.points[0].x, shape.points[0].y);
      for(let i = 1; i < shape.points.length; i++) {
        c.lineTo(shape.points[i].x, shape.points[i].y);
      }
      c.stroke();
      c.restore();
      break;
      
    case 'line':
      c.beginPath();
      c.moveTo(shape.start.x, shape.start.y);
      c.lineTo(shape.end.x, shape.end.y);
      c.stroke();
      break;
      
    case 'rect':
      c.beginPath();
      c.rect(shape.start.x, shape.start.y, shape.end.x - shape.start.x, shape.end.y - shape.start.y);
      c.stroke();
      break;
      
    case 'arrow':
      const dx = shape.end.x - shape.start.x;
      const dy = shape.end.y - shape.start.y;
      const angle = Math.atan2(dy, dx);
      const headLength = 14;
      
      c.beginPath();
      c.moveTo(shape.start.x, shape.start.y);
      c.lineTo(shape.end.x, shape.end.y);
      c.stroke();
      
      c.beginPath();
      c.moveTo(shape.end.x, shape.end.y);
      c.lineTo(shape.end.x - headLength * Math.cos(angle - Math.PI / 6), shape.end.y - headLength * Math.sin(angle - Math.PI / 6));
      c.lineTo(shape.end.x - headLength * Math.cos(angle + Math.PI / 6), shape.end.y - headLength * Math.sin(angle + Math.PI / 6));
      c.closePath();
      c.fill();
      break;
      
    case 'text':
      c.font = '500 16px Outfit, sans-serif';
      c.textBaseline = 'top';
      const lines = shape.text.split('\n');
      let currentY = shape.y;
      lines.forEach(line => {
        c.fillText(line, shape.x, currentY);
        currentY += 22;
      });
      break;
  }
}

// Redraw Loop
function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  ctx.save();
  ctx.scale(scaleFactor, scaleFactor);
  
  // 1. Desktop background screenshot
  if (screenshotImg.complete && screenshotImg.naturalWidth > 0) {
    ctx.drawImage(screenshotImg, 0, 0, logicalWidth, logicalHeight);
  }
  
  // 2. Dimmed overlay mask
  if (hasSelection) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    // Top
    ctx.fillRect(0, 0, logicalWidth, selection.y);
    // Bottom
    ctx.fillRect(0, selection.y + selection.h, logicalWidth, logicalHeight - (selection.y + selection.h));
    // Left
    ctx.fillRect(0, selection.y, selection.x, selection.h);
    // Right
    ctx.fillRect(selection.x + selection.w, selection.y, logicalWidth - (selection.x + selection.w), selection.h);
    
    // Draw marching ants border
    ctx.strokeStyle = '#8b5cf6';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.lineDashOffset = dashOffset;
    ctx.strokeRect(selection.x, selection.y, selection.w, selection.h);
    ctx.setLineDash([]);
  } else {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(0, 0, logicalWidth, logicalHeight);
  }
  
  // 3. Render annotations clipped to selection
  if (hasSelection) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(selection.x, selection.y, selection.w, selection.h);
    ctx.clip();
    
    drawingActions.forEach(action => drawShapeOnCtx(ctx, action));
    
    if (activeShape) {
      drawShapeOnCtx(ctx, activeShape);
    }
    
    ctx.restore();
  }
  
  ctx.restore();
}

// Marching Ants Loop
function startMarchingAnts() {
  if (antsInterval) return;
  antsInterval = setInterval(() => {
    dashOffset = (dashOffset - 0.25) % 12;
    draw();
  }, 1000 / 60); // 60 FPS
}

function stopMarchingAnts() {
  if (antsInterval) {
    clearInterval(antsInterval);
    antsInterval = null;
  }
}

// Text Input Component
function spawnTextInput(x, y) {
  if (activeTextarea) {
    commitText();
  }
  
  isEditingText = true;
  
  const textarea = document.createElement('textarea');
  textarea.className = 'canvas-text-input';
  textarea.style.left = `${x}px`;
  textarea.style.top = `${y}px`;
  textarea.style.color = currentColor;
  textarea.style.font = '500 16px Outfit, sans-serif';
  textarea.style.width = '150px';
  textarea.style.height = '24px';
  
  document.body.appendChild(textarea);
  setTimeout(() => textarea.focus(), 10);
  
  activeTextarea = {
    element: textarea,
    x: x,
    y: y
  };
  
  textarea.addEventListener('input', () => {
    textarea.style.width = 'auto';
    textarea.style.width = `${Math.max(150, textarea.scrollWidth + 10)}px`;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  });
  
  textarea.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });
  
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commitText();
    } else if (e.key === 'Escape') {
      cancelText();
    }
  });
}

function commitText() {
  if (!activeTextarea) return;
  
  const text = activeTextarea.element.value.trim();
  if (text) {
    drawingActions.push({
      type: 'text',
      x: activeTextarea.x,
      y: activeTextarea.y,
      text: text,
      color: currentColor
    });
    updateUndoState();
  }
  
  document.body.removeChild(activeTextarea.element);
  activeTextarea = null;
  isEditingText = false;
  draw();
}

function cancelText() {
  if (!activeTextarea) return;
  document.body.removeChild(activeTextarea.element);
  activeTextarea = null;
  isEditingText = false;
  draw();
}

// Layout Position of Toolbars and Handles
function updateOverlays() {
  if (!hasSelection) {
    sizeBadge.style.display = 'none';
    drawingToolbar.style.display = 'none';
    actionToolbar.style.display = 'none';
    Object.values(resizeHandles).forEach(h => h.style.display = 'none');
    return;
  }
  
  // 1. Sizing Badge
  sizeBadge.textContent = `${Math.round(selection.w)} × ${Math.round(selection.h)}`;
  sizeBadge.style.display = 'block';
  sizeBadge.style.left = `${selection.x}px`;
  sizeBadge.style.top = `${selection.y}px`;
  
  // 2. Resize Handles
  const r = resizeHandles;
  const x = selection.x;
  const y = selection.y;
  const w = selection.w;
  const h = selection.h;
  
  r['top-left'].style.left = `${x}px`;
  r['top-left'].style.top = `${y}px`;
  
  r['top'].style.left = `${x + w/2}px`;
  r['top'].style.top = `${y}px`;
  
  r['top-right'].style.left = `${x + w}px`;
  r['top-right'].style.top = `${y}px`;
  
  r['right'].style.left = `${x + w}px`;
  r['right'].style.top = `${y + h/2}px`;
  
  r['bottom-right'].style.left = `${x + w}px`;
  r['bottom-right'].style.top = `${y + h}px`;
  
  r['bottom'].style.left = `${x + w/2}px`;
  r['bottom'].style.top = `${y + h}px`;
  
  r['bottom-left'].style.left = `${x}px`;
  r['bottom-left'].style.top = `${y + h}px`;
  
  r['left'].style.left = `${x}px`;
  r['left'].style.top = `${y + h/2}px`;
  
  Object.values(r).forEach(handle => handle.style.display = 'block');
  
  // 3. Toolbars
  drawingToolbar.style.display = 'flex';
  actionToolbar.style.display = 'flex';
  
  // Measure toolbars
  const drawRect = drawingToolbar.getBoundingClientRect();
  const actionRect = actionToolbar.getBoundingClientRect();
  
  const gap = 8;
  
  // Position Vertical Drawing Toolbar (default: right side of selection)
  let drawLeft = x + w + gap;
  let drawTop = y;
  
  if (drawLeft + drawRect.width > logicalWidth) {
    // Put on the left of selection if overflows right
    drawLeft = x - drawRect.width - gap;
  }
  
  if (drawLeft < 0) {
    // Put inside selection on the right edge if overflows both
    drawLeft = x + w - drawRect.width - gap;
  }
  
  // Clamp vertical toolbar within viewport height
  if (drawTop + drawRect.height > logicalHeight) {
    drawTop = logicalHeight - drawRect.height - gap;
  }
  if (drawTop < gap) drawTop = gap;
  
  drawingToolbar.style.left = `${drawLeft}px`;
  drawingToolbar.style.top = `${drawTop}px`;
  
  // Position Horizontal Action Toolbar (default: bottom-right of selection)
  let actionLeft = x + w - actionRect.width;
  let actionTop = y + h + gap;
  
  if (actionLeft < gap) {
    actionLeft = gap;
  }
  
  if (actionTop + actionRect.height > logicalHeight) {
    // Put above selection if overflows bottom
    actionTop = y - actionRect.height - gap;
  }
  
  if (actionTop < 0) {
    // Put inside selection on the bottom edge if overflows both
    actionTop = y + h - actionRect.height - gap;
  }
  
  actionToolbar.style.left = `${actionLeft}px`;
  actionToolbar.style.top = `${actionTop}px`;
}

// Mouse Event Coordinates Helper
function getMousePos(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top
  };
}

// Selection Helper: checks if coordinates are inside selection
function isInsideSelection(x, y) {
  return x >= selection.x && x <= selection.x + selection.w &&
         y >= selection.y && y <= selection.y + selection.h;
}

// Mouse Event Handlers
canvas.addEventListener('mousedown', (e) => {
  const pos = getMousePos(e);
  
  // If editing text, click outside commits text
  if (isEditingText) {
    commitText();
    return;
  }
  
  if (!hasSelection) {
    // Start drawing a fresh selection
    isSelecting = true;
    mouseStart = pos;
    selection = { x: pos.x, y: pos.y, w: 0, h: 0 };
    hasSelection = true;
    currentTool = 'select'; // Reset tool to select during creation
    document.querySelector('.tool-btn.active')?.classList.remove('active');
    document.querySelector('.tool-btn[data-tool="select"]')?.classList.add('active');
    
    stopMarchingAnts();
    draw();
  } else {
    // We already have a selection
    if (currentTool === 'select') {
      if (isInsideSelection(pos.x, pos.y)) {
        // Start moving selection
        isMoving = true;
        moveOffset = {
          x: pos.x - selection.x,
          y: pos.y - selection.y
        };
      } else {
        // Clicked outside: start drawing new selection
        isSelecting = true;
        mouseStart = pos;
        selection = { x: pos.x, y: pos.y, w: 0, h: 0 };
        hasSelection = false;
        updateOverlays();
        stopMarchingAnts();
        draw();
      }
    } else {
      // Drawing shapes inside selection
      if (isInsideSelection(pos.x, pos.y)) {
        if (currentTool === 'text') {
          spawnTextInput(pos.x, pos.y);
        } else {
          // Drawing active shape (pen, line, arrow, rect, highlight)
          activeShape = {
            type: currentTool,
            color: currentColor,
            width: currentTool === 'highlight' ? 14 : currentWidth
          };
          
          if (currentTool === 'pen' || currentTool === 'highlight') {
            activeShape.points = [pos];
          } else {
            activeShape.start = pos;
            activeShape.end = pos;
          }
        }
      }
    }
  }
});

canvas.addEventListener('mousemove', (e) => {
  const pos = getMousePos(e);
  
  if (isSelecting) {
    const x = Math.min(mouseStart.x, pos.x);
    const y = Math.min(mouseStart.y, pos.y);
    const w = Math.abs(pos.x - mouseStart.x);
    const h = Math.abs(pos.y - mouseStart.y);
    
    // Clamp within viewport boundary
    selection.x = Math.max(0, x);
    selection.y = Math.max(0, y);
    selection.w = Math.min(logicalWidth - selection.x, w);
    selection.h = Math.min(logicalHeight - selection.y, h);
    
    draw();
  } else if (isMoving) {
    let nx = pos.x - moveOffset.x;
    let ny = pos.y - moveOffset.y;
    
    // Clamp selection inside boundary while moving
    nx = Math.max(0, Math.min(logicalWidth - selection.w, nx));
    ny = Math.max(0, Math.min(logicalHeight - selection.h, ny));
    
    selection.x = nx;
    selection.y = ny;
    
    draw();
    updateOverlays();
  } else if (isResizing) {
    const dx = pos.x - mouseStart.x;
    const dy = pos.y - mouseStart.y;
    const s = selectionStart;
    
    let x1 = s.x;
    let y1 = s.y;
    let x2 = s.x + s.w;
    let y2 = s.y + s.h;
    
    const minSize = 15;
    
    if (activeHandle.includes('left')) {
      x1 = Math.min(s.x + s.w - minSize, Math.max(0, s.x + dx));
    }
    if (activeHandle.includes('right')) {
      x2 = Math.max(s.x + minSize, Math.min(logicalWidth, s.x + s.w + dx));
    }
    if (activeHandle.includes('top')) {
      y1 = Math.min(s.y + s.h - minSize, Math.max(0, s.y + dy));
    }
    if (activeHandle.includes('bottom')) {
      y2 = Math.max(s.y + minSize, Math.min(logicalHeight, s.y + s.h + dy));
    }
    
    selection = {
      x: x1,
      y: y1,
      w: x2 - x1,
      h: y2 - y1
    };
    
    draw();
    updateOverlays();
  } else if (activeShape) {
    // We are currently drawing a shape
    if (isInsideSelection(pos.x, pos.y)) {
      if (activeShape.type === 'pen' || activeShape.type === 'highlight') {
        activeShape.points.push(pos);
      } else {
        activeShape.end = pos;
      }
      draw();
    }
  }
});

canvas.addEventListener('mouseup', () => {
  if (isSelecting) {
    isSelecting = false;
    if (selection.w > 5 && selection.h > 5) {
      hasSelection = true;
      updateOverlays();
      startMarchingAnts();
    } else {
      hasSelection = false;
      updateOverlays();
      draw();
    }
  } else if (isMoving) {
    isMoving = false;
  } else if (isResizing) {
    isResizing = false;
    activeHandle = null;
    startMarchingAnts();
  } else if (activeShape) {
    // Commit the active drawing shape
    drawingActions.push(activeShape);
    activeShape = null;
    updateUndoState();
    draw();
  }
});

// Resize handles mousedown listener
Object.entries(resizeHandles).forEach(([name, handle]) => {
  handle.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    isResizing = true;
    activeHandle = name;
    mouseStart = { x: e.clientX, y: e.clientY };
    selectionStart = { ...selection };
    stopMarchingAnts();
  });
});

// Update Undo Button enabled/disabled
function updateUndoState() {
  if (drawingActions.length > 0) {
    undoBtn.classList.remove('disabled');
  } else {
    undoBtn.classList.add('disabled');
  }
}

// Undo Action
undoBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (drawingActions.length > 0) {
    drawingActions.pop();
    updateUndoState();
    draw();
  }
});

// Generate Cropped High Resolution Canvas
function getCroppedCanvas() {
  if (!hasSelection) return null;
  
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = selection.w * scaleFactor;
  exportCanvas.height = selection.h * scaleFactor;
  
  const exportCtx = exportCanvas.getContext('2d');
  
  // Crop background screenshot
  const sx = selection.x * scaleFactor;
  const sy = selection.y * scaleFactor;
  const sw = selection.w * scaleFactor;
  const sh = selection.h * scaleFactor;
  
  exportCtx.drawImage(
    screenshotImg,
    sx, sy, sw, sh, // Source crop
    0, 0, sw, sh   // Destination
  );
  
  // Draw committed annotations
  exportCtx.save();
  exportCtx.scale(scaleFactor, scaleFactor);
  exportCtx.translate(-selection.x, -selection.y);
  
  drawingActions.forEach(action => {
    drawShapeOnCtx(exportCtx, action);
  });
  
  exportCtx.restore();
  return exportCanvas;
}

// Action Button Listeners
closeBtn.addEventListener('click', () => {
  if (isEditingText) cancelText();
  stopMarchingAnts();
  window.electronAPI.closeOverlay();
});

copyBtn.addEventListener('click', async () => {
  if (isEditingText) commitText();
  const cCanvas = getCroppedCanvas();
  if (cCanvas) {
    const dataUrl = cCanvas.toDataURL('image/png');
    const success = await window.electronAPI.copyScreenshot(dataUrl);
    if (success) {
      stopMarchingAnts();
      window.electronAPI.closeOverlay();
    } else {
      alert('Failed to copy image to clipboard.');
    }
  }
});

saveBtn.addEventListener('click', async () => {
  if (isEditingText) commitText();
  const cCanvas = getCroppedCanvas();
  if (cCanvas) {
    const dataUrl = cCanvas.toDataURL('image/png');
    const success = await window.electronAPI.saveScreenshot(dataUrl);
    if (success) {
      stopMarchingAnts();
      window.electronAPI.closeOverlay();
    }
  }
});

searchBtn.addEventListener('click', async () => {
  if (isEditingText) commitText();
  const cCanvas = getCroppedCanvas();
  if (cCanvas) {
    const dataUrl = cCanvas.toDataURL('image/png');
    
    // Disable buttons during upload
    searchBtn.classList.add('disabled');
    searchBtn.querySelector('span').textContent = 'Searching...';
    
    const success = await window.electronAPI.searchImage(dataUrl);
    
    searchBtn.classList.remove('disabled');
    searchBtn.querySelector('span').textContent = 'Search';
    
    if (success) {
      stopMarchingAnts();
      window.electronAPI.closeOverlay();
    } else {
      alert('Google Image Search failed. Please check your internet connection.');
    }
  }
});

// Key bindings
window.addEventListener('keydown', (e) => {
  if (isEditingText) return; // Ignore hotkeys during text writing
  
  if (e.key === 'Escape') {
    closeBtn.click();
  } else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
    undoBtn.click();
  } else if (e.key === 'c' && (e.ctrlKey || e.metaKey)) {
    copyBtn.click();
  } else if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
    saveBtn.click();
  }
});
