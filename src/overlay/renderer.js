const canvas = document.getElementById('screenshotCanvas');
const ctx = canvas.getContext('2d');
const sizeBadge = document.getElementById('sizeBadge');
const drawingToolbar = document.getElementById('drawingToolbar');
const actionToolbar = document.getElementById('actionToolbar');
const displaySwitcher = document.getElementById('displaySwitcher');
const displayPills = document.getElementById('displayPills');

// Tool buttons
const toolButtons = document.querySelectorAll('.tool-btn');
const undoBtn = document.getElementById('undoBtn');
const clearBtn = document.getElementById('clearBtn');

// Action buttons
const searchBtn = document.getElementById('searchBtn');
const copyBtn = document.getElementById('copyBtn');
const saveBtn = document.getElementById('saveBtn');
const closeBtn = document.getElementById('closeBtn');
const captureFramesBtn = document.getElementById('captureFramesBtn');

// Color picker elements
const colorPreview = document.getElementById('colorPreview');
const colorPopover = document.getElementById('colorPopover');
const colorSwatches = document.querySelectorAll('.color-swatch');
const customColorInput = document.getElementById('customColorInput');

// Brush size elements
const sizeBtn = document.getElementById('sizeBtn');
const sizePopover = document.getElementById('sizePopover');
const sizeSlider = document.getElementById('sizeSlider');
const sizeValue = document.getElementById('sizeValue');
const sizePresetDots = document.querySelectorAll('.size-preset-dot');
const brushCursor = document.getElementById('brushCursor');
const brushSizeTooltip = document.getElementById('brushSizeTooltip');

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
let currentTool = 'pen'; // pen default (select, pen, line, arrow, rect, highlight, text, eraser)
let currentColor = '#ef4444'; // Red default
let currentWidth = 2.5;
let eraserWidth = 28;
let highlightWidth = 14;
let sizeTooltipTimeout = null;
let lastPointerPos = { x: -100, y: -100 };
let isMarkerMode = false;

let displaysList = [];
let activeDisplayIndex = 0;

let drawingActions = []; // stack of committed shapes
let activeShape = null; // shape in progress
let annotationCanvas = null; // offscreen layer for clean erasing without touching screenshot

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
let frameCaptureSettings = null;
let isAllDisplaysMode = false;

function updateDisplaySwitcher() {
  if (!displaySwitcher || !displayPills) return;

  if (displaysList.length <= 1 || isMarkerMode) {
    displaySwitcher.classList.add('hidden');
    return;
  }

  displaySwitcher.classList.remove('hidden');
  displayPills.innerHTML = '';

  // "All Screens" pill
  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = 'display-pill-btn';
  if (isAllDisplaysMode) allBtn.classList.add('active');
  allBtn.innerHTML = `<span>All Screens</span>`;
  allBtn.title = 'Switch overlay to span all connected screens';
  allBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!isAllDisplaysMode && window.electronAPI.switchOverlayDisplay) {
      window.electronAPI.switchOverlayDisplay(-1, isMarkerMode ? 'marker' : 'screenshot');
    } else {
      selectDisplayBounds(0, 0, logicalWidth, logicalHeight);
      setActiveDisplayPill(allBtn);
    }
  });
  displayPills.appendChild(allBtn);

  // Each connected monitor pill
  displaysList.forEach((d, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'display-pill-btn';
    if (!isAllDisplaysMode && activeDisplayIndex === idx) {
      btn.classList.add('active');
    }
    const shortName = d.isPrimary ? `Display ${idx + 1} (Main)` : `Display ${idx + 1} (Secondary)`;
    btn.innerHTML = `<span>${shortName}</span> <span class="pill-badge">${Math.round(d.width)}×${Math.round(d.height)}</span>`;
    btn.title = `Switch overlay to ${d.name} (${Math.round(d.width)}×${Math.round(d.height)})`;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!isAllDisplaysMode && activeDisplayIndex !== idx && window.electronAPI.switchOverlayDisplay) {
        window.electronAPI.switchOverlayDisplay(idx, isMarkerMode ? 'marker' : 'screenshot');
      } else {
        selectDisplayBounds(d.x, d.y, d.width, d.height);
        setActiveDisplayPill(btn);
      }
    });
    displayPills.appendChild(btn);
  });
}

function setActiveDisplayPill(targetBtn) {
  if (!displayPills) return;
  displayPills.querySelectorAll('.display-pill-btn').forEach(btn => {
    btn.classList.toggle('active', btn === targetBtn);
  });
}

function selectDisplayBounds(x, y, w, h) {
  if (isEditingText) commitText();
  selection = {
    x: Math.max(0, x),
    y: Math.max(0, y),
    w: Math.min(logicalWidth - x, w),
    h: Math.min(logicalHeight - y, h)
  };
  hasSelection = true;
  if (frameCaptureSettings) {
    setTool('select');
  } else {
    setTool('pen');
  }
  startMarchingAnts();
  updateOverlays();
  draw();
}

// Initialize
window.electronAPI.onScreenshotData((data) => {
  isMarkerMode = data.mode === 'marker';
  isAllDisplaysMode = data.isAllDisplays === true;
  frameCaptureSettings = data.mode === 'frame-selection'
    ? { count: data.frameCount, intervalMs: data.frameIntervalMs }
    : null;

  displaysList = Array.isArray(data.displays) ? data.displays : [];
  activeDisplayIndex = typeof data.activeDisplayIndex === 'number' ? data.activeDisplayIndex : 0;

  document.body.classList.toggle('frame-capture-mode', frameCaptureSettings !== null);
  document.body.classList.toggle('marker-mode', isMarkerMode);

  if (frameCaptureSettings) {
    captureFramesBtn.querySelector('span').textContent = `Copy ${frameCaptureSettings.count} frames`;
    captureFramesBtn.title = `Copies the first frame immediately, then ${frameCaptureSettings.count - 1} more ${frameCaptureSettings.intervalMs} ms apart`;
  }

  logicalWidth = data.width;
  logicalHeight = data.height;

  if (isMarkerMode) {
    selection = { x: 0, y: 0, w: data.width, h: data.height };
    hasSelection = true;
    setTool('pen');
  } else {
    selection = { x: 0, y: 0, w: 0, h: 0 };
    hasSelection = false;
    if (frameCaptureSettings) {
      setTool('select');
    } else {
      setTool('pen');
    }
  }

  drawingActions = [];
  activeShape = null;
  stopMarchingAnts();
  updateDisplaySwitcher();
  updateOverlays();
  updateBrushCursor();

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
  updateBrushCursor();
}

// Color Picker Popover Toggle
colorPreview.addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = colorPopover.style.display === 'grid';
  colorPopover.style.display = isOpen ? 'none' : 'grid';
  if (!isOpen) {
    sizePopover.style.display = 'none'; // Close size picker when color is opened
  }
});

// Brush Size Popover Toggle
sizeBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = sizePopover.style.display === 'flex';
  sizePopover.style.display = isOpen ? 'none' : 'flex';
  if (!isOpen) {
    colorPopover.style.display = 'none'; // Close color picker when size is opened
  }
});

document.addEventListener('click', () => {
  colorPopover.style.display = 'none';
  sizePopover.style.display = 'none';
});

colorPopover.addEventListener('click', (e) => {
  e.stopPropagation();
});

sizePopover.addEventListener('click', (e) => {
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

// Update Brush Size Helper
function updateBrushSize(size, updateSlider = true) {
  currentWidth = size;
  sizeValue.textContent = `${size}px`;
  
  if (updateSlider) {
    sizeSlider.value = size;
  }
  
  sizePresetDots.forEach(dot => {
    const dotSize = parseFloat(dot.dataset.size);
    if (Math.abs(dotSize - size) < 0.1) {
      dot.classList.add('active');
    } else {
      dot.classList.remove('active');
    }
  });
  updateBrushCursor();
}

// Preset dots event listeners
sizePresetDots.forEach(dot => {
  dot.addEventListener('click', () => {
    const size = parseFloat(dot.dataset.size);
    updateBrushSize(size);
  });
});

// Slider event listeners
sizeSlider.addEventListener('input', (e) => {
  const size = parseFloat(e.target.value);
  updateBrushSize(size, false);
});

// Dynamic Cursor Update
function updateBrushCursor(x, y) {
  if (x !== undefined && y !== undefined) {
    lastPointerPos = { x, y };
  } else {
    x = lastPointerPos.x;
    y = lastPointerPos.y;
  }

  // When actively selecting a region or before selection is established, show crosshair
  if (isSelecting || (!hasSelection && !isMarkerMode)) {
    if (brushCursor) brushCursor.classList.add('hidden');
    canvas.style.cursor = 'crosshair';
    return;
  }

  // If select or text tool is active, or cursor is offscreen, hide cursor ring
  if (!['pen', 'eraser', 'highlight', 'line', 'arrow', 'rect'].includes(currentTool) || x < 0 || y < 0) {
    if (brushCursor) brushCursor.classList.add('hidden');
    if (currentTool === 'text') {
      canvas.style.cursor = 'text';
    } else if (currentTool === 'select') {
      canvas.style.cursor = isInsideSelection(x, y) ? 'move' : 'crosshair';
    } else {
      canvas.style.cursor = 'crosshair';
    }
    return;
  }

  // If drawing tool is active but pointer is outside selection (in screenshot mode)
  if (!isMarkerMode && !isInsideSelection(x, y)) {
    if (brushCursor) brushCursor.classList.add('hidden');
    canvas.style.cursor = 'default';
    return;
  }

  if (!brushCursor) return;

  canvas.style.cursor = 'none';
  brushCursor.classList.remove('hidden');
  brushCursor.style.left = `${x}px`;
  brushCursor.style.top = `${y}px`;

  brushCursor.className = 'brush-cursor';

  if (currentTool === 'eraser') {
    brushCursor.classList.add('eraser-cursor');
    brushCursor.style.width = `${eraserWidth}px`;
    brushCursor.style.height = `${eraserWidth}px`;
    brushCursor.style.backgroundColor = '';
    brushCursor.style.borderColor = '';
  } else if (currentTool === 'highlight') {
    brushCursor.classList.add('highlight-cursor');
    brushCursor.style.width = `${highlightWidth}px`;
    brushCursor.style.height = `${highlightWidth}px`;
    brushCursor.style.backgroundColor = currentColor;
    brushCursor.style.borderColor = currentColor;
  } else if (currentTool === 'pen') {
    brushCursor.classList.add('pen-cursor');
    const diameter = Math.max(4, currentWidth);
    brushCursor.style.width = `${diameter}px`;
    brushCursor.style.height = `${diameter}px`;
    brushCursor.style.backgroundColor = currentColor;
    brushCursor.style.borderColor = '#ffffff';
  } else {
    // line, arrow, rect
    brushCursor.classList.add('shape-cursor');
    const diameter = Math.max(6, currentWidth);
    brushCursor.style.width = `${diameter}px`;
    brushCursor.style.height = `${diameter}px`;
    brushCursor.style.backgroundColor = '';
    brushCursor.style.borderColor = currentColor;
  }
}

function showSizeTooltip(text, x, y) {
  if (!brushSizeTooltip) return;
  brushSizeTooltip.textContent = text;
  brushSizeTooltip.style.left = `${x}px`;
  brushSizeTooltip.style.top = `${y}px`;
  brushSizeTooltip.classList.remove('hidden');
  
  if (sizeTooltipTimeout) clearTimeout(sizeTooltipTimeout);
  sizeTooltipTimeout = setTimeout(() => {
    brushSizeTooltip.classList.add('hidden');
  }, 850);
}

function setTool(tool) {
  if (isEditingText) commitText();
  if (tool) {
    currentTool = tool;
    document.querySelector('.tool-btn.active')?.classList.remove('active');
    document.querySelector(`.tool-btn[data-tool="${tool}"]`)?.classList.add('active');
    
    // Close setting popovers when switching tools
    colorPopover.style.display = 'none';
    sizePopover.style.display = 'none';
    
    updateBrushCursor();
  }
}

// Tool Selection
toolButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.classList.contains('disabled')) return;
    const tool = btn.dataset.tool;
    if (tool) {
      setTool(tool);
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
      if (!shape.points || shape.points.length === 0) return;
      if (shape.points.length === 1) {
        c.beginPath();
        c.arc(shape.points[0].x, shape.points[0].y, Math.max(1, shape.width / 2), 0, Math.PI * 2);
        c.fill();
        return;
      }
      c.beginPath();
      c.moveTo(shape.points[0].x, shape.points[0].y);
      for(let i = 1; i < shape.points.length; i++) {
        c.lineTo(shape.points[i].x, shape.points[i].y);
      }
      c.stroke();
      break;
      
    case 'highlight':
      if (!shape.points || shape.points.length === 0) return;
      c.save();
      c.globalAlpha = 0.45;
      if (shape.points.length === 1) {
        c.beginPath();
        c.arc(shape.points[0].x, shape.points[0].y, 7, 0, Math.PI * 2);
        c.fill();
        c.restore();
        return;
      }
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
      
    case 'eraser':
      if (!shape.points || shape.points.length === 0) return;
      c.save();
      c.globalCompositeOperation = 'destination-out';
      c.lineWidth = shape.width || 24;
      c.lineCap = 'round';
      c.lineJoin = 'round';
      if (shape.points.length === 1) {
        c.beginPath();
        c.arc(shape.points[0].x, shape.points[0].y, (shape.width || 24) / 2, 0, Math.PI * 2);
        c.fill();
      } else {
        c.beginPath();
        c.moveTo(shape.points[0].x, shape.points[0].y);
        for (let i = 1; i < shape.points.length; i++) {
          c.lineTo(shape.points[i].x, shape.points[i].y);
        }
        c.stroke();
      }
      c.restore();
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
  if (!isMarkerMode) {
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

      // Draw subtle display boundaries & labels if multi-monitor
      if (displaysList.length > 1) {
        displaysList.forEach((d) => {
          ctx.save();
          ctx.strokeStyle = 'rgba(167, 139, 250, 0.35)';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([6, 6]);
          ctx.strokeRect(d.x + 1, d.y + 1, d.width - 2, d.height - 2);
          
          // Display indicator tag
          const badgeText = `${d.name} (${Math.round(d.width)} × ${Math.round(d.height)})`;
          ctx.font = '500 13px Outfit, sans-serif';
          const textWidth = ctx.measureText(badgeText).width;
          
          ctx.fillStyle = 'rgba(15, 17, 23, 0.85)';
          ctx.beginPath();
          ctx.roundRect(d.x + 20, d.y + 20, textWidth + 24, 28, 8);
          ctx.fill();
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
          ctx.setLineDash([]);
          ctx.stroke();
          
          ctx.fillStyle = '#ffffff';
          ctx.textBaseline = 'middle';
          ctx.fillText(badgeText, d.x + 32, d.y + 34);
          ctx.restore();
        });
      }
    }
  }
  
  // 3. Render annotations layer (allows eraser destination-out without affecting screenshot)
  if (hasSelection && (drawingActions.length > 0 || activeShape)) {
    if (!annotationCanvas) {
      annotationCanvas = document.createElement('canvas');
    }
    if (annotationCanvas.width !== canvas.width || annotationCanvas.height !== canvas.height) {
      annotationCanvas.width = canvas.width;
      annotationCanvas.height = canvas.height;
    }
    
    const aCtx = annotationCanvas.getContext('2d');
    aCtx.clearRect(0, 0, annotationCanvas.width, annotationCanvas.height);
    aCtx.save();
    aCtx.scale(scaleFactor, scaleFactor);
    
    if (!isMarkerMode) {
      aCtx.beginPath();
      aCtx.rect(selection.x, selection.y, selection.w, selection.h);
      aCtx.clip();
    }
    
    drawingActions.forEach(action => drawShapeOnCtx(aCtx, action));
    
    if (activeShape) {
      drawShapeOnCtx(aCtx, activeShape);
    }
    
    aCtx.restore();
    
    // Draw the annotated layer onto the main canvas
    ctx.drawImage(annotationCanvas, 0, 0, logicalWidth, logicalHeight);
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
  if (isMarkerMode) {
    sizeBadge.style.display = 'none';
    drawingToolbar.style.display = 'flex';
    actionToolbar.style.display = 'flex';
    Object.values(resizeHandles).forEach(h => h.style.display = 'none');
    return;
  }

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
    x: (e.clientX - rect.left) * (logicalWidth / (rect.width || 1)),
    y: (e.clientY - rect.top) * (logicalHeight / (rect.height || 1))
  };
}

// Selection Helper: checks if coordinates are inside selection
function isInsideSelection(x, y) {
  if (isMarkerMode) return true;
  return x >= selection.x && x <= selection.x + selection.w &&
         y >= selection.y && y <= selection.y + selection.h;
}

// Unified Pointer & Mouse Event Handlers
function onPointerDown(e) {
  if (e.button !== undefined && e.button !== 0) return;
  const pos = getMousePos(e);
  
  // If editing text, click outside commits text
  if (isEditingText) {
    commitText();
    return;
  }
  
  if (!hasSelection && !isMarkerMode) {
    // Start drawing a fresh selection
    isSelecting = true;
    mouseStart = pos;
    selection = { x: pos.x, y: pos.y, w: 0, h: 0 };
    hasSelection = true;
    setActiveDisplayPill(null);
    stopMarchingAnts();
    draw();
  } else {
    // We already have a selection or are in marker mode
    if (currentTool === 'select' && !isMarkerMode) {
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
        setActiveDisplayPill(null);
        updateOverlays();
        stopMarchingAnts();
        draw();
      }
    } else {
      // Drawing shapes inside selection (or anywhere in marker mode)
      if (isInsideSelection(pos.x, pos.y)) {
        if (currentTool === 'text') {
          spawnTextInput(pos.x, pos.y);
        } else {
          // Drawing active shape (pen, line, arrow, rect, highlight, eraser)
          activeShape = {
            type: currentTool,
            color: currentColor,
            width: currentTool === 'eraser' ? eraserWidth : (currentTool === 'highlight' ? highlightWidth : currentWidth)
          };
          
          if (currentTool === 'pen' || currentTool === 'highlight' || currentTool === 'eraser') {
            activeShape.points = [pos];
          } else {
            activeShape.start = pos;
            activeShape.end = pos;
          }
          draw();
        }
      }
    }
  }
}

function onPointerMove(e) {
  const pos = getMousePos(e);
  updateBrushCursor(e.clientX, e.clientY);
  
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
    if (isMarkerMode || isInsideSelection(pos.x, pos.y) || activeShape.points) {
      if (activeShape.type === 'pen' || activeShape.type === 'highlight' || activeShape.type === 'eraser') {
        activeShape.points.push(pos);
      } else {
        activeShape.end = pos;
      }
      draw();
    }
  }
}

function onPointerUp() {
  if (isSelecting) {
    isSelecting = false;
    if (selection.w > 5 && selection.h > 5) {
      hasSelection = true;
      if (frameCaptureSettings) {
        setTool('select');
      } else {
        setTool('pen');
      }
      updateOverlays();
      startMarchingAnts();
    } else {
      hasSelection = false;
      selection = { x: 0, y: 0, w: 0, h: 0 };
      if (!frameCaptureSettings) {
        setTool('pen');
      }
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
}

// Bind Pointer Events (drawing tablets, stylus, touch, mouse)
if (window.PointerEvent) {
  canvas.addEventListener('pointerdown', (e) => {
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    onPointerDown(e);
  });
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', (e) => {
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    onPointerUp();
  });
  window.addEventListener('pointercancel', onPointerUp);
}

// Double click to auto-snap selection to clicked display (or full canvas)
canvas.addEventListener('dblclick', (e) => {
  if (isMarkerMode) return;
  const pos = getMousePos(e);
  const matched = displaysList.find(d => 
    pos.x >= d.x && pos.x < d.x + d.width &&
    pos.y >= d.y && pos.y < d.y + d.height
  );
  if (matched) {
    selectDisplayBounds(matched.x, matched.y, matched.width, matched.height);
    const pills = displayPills ? displayPills.querySelectorAll('.display-pill-btn') : [];
    if (pills[matched.index + 1]) {
      setActiveDisplayPill(pills[matched.index + 1]);
    }
  } else {
    selectDisplayBounds(0, 0, logicalWidth, logicalHeight);
    const firstPill = displayPills ? displayPills.querySelector('.display-pill-btn') : null;
    if (firstPill) setActiveDisplayPill(firstPill);
  }
});

// Mouse Wheel Size Adjustment (Pen, Eraser, Highlighter, Shapes)
window.addEventListener('wheel', (e) => {
  if (isEditingText || e.target.closest('.toolbar') || e.target.closest('.color-popover') || e.target.closest('.size-popover')) {
    return;
  }

  if (['pen', 'eraser', 'highlight', 'line', 'arrow', 'rect'].includes(currentTool)) {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1 : -1;

    if (currentTool === 'eraser') {
      eraserWidth = Math.max(6, Math.min(160, eraserWidth + delta * 4));
      showSizeTooltip(`Eraser: ${Math.round(eraserWidth)}px`, e.clientX, e.clientY);
    } else if (currentTool === 'highlight') {
      highlightWidth = Math.max(6, Math.min(90, highlightWidth + delta * 2));
      showSizeTooltip(`Highlighter: ${Math.round(highlightWidth)}px`, e.clientX, e.clientY);
    } else {
      const step = currentWidth < 4 ? 0.5 : (currentWidth < 12 ? 1 : 2);
      const next = Math.max(1, Math.min(50, Math.round((currentWidth + delta * step) * 2) / 2));
      updateBrushSize(next);
      showSizeTooltip(`Size: ${next}px`, e.clientX, e.clientY);
    }

    updateBrushCursor(e.clientX, e.clientY);
  }
}, { passive: false });

// Hide brush cursor when hovering over UI toolbars and settings popovers
document.querySelectorAll('.toolbar, .color-popover, .size-popover').forEach(el => {
  el.addEventListener('pointerenter', () => {
    if (brushCursor) brushCursor.classList.add('hidden');
  });
  el.addEventListener('pointerleave', () => {
    updateBrushCursor();
  });
});

canvas.addEventListener('pointerleave', () => {
  if (brushCursor) brushCursor.classList.add('hidden');
});
canvas.addEventListener('pointerenter', (e) => {
  updateBrushCursor(e.clientX, e.clientY);
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

// Clear All Marks Action
function clearCanvas() {
  if (isEditingText) cancelText();
  drawingActions = [];
  activeShape = null;
  updateUndoState();
  draw();
}

if (clearBtn) {
  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    clearCanvas();
  });
}

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
  
  // Draw committed annotations on clean layer
  const annotCanvas = document.createElement('canvas');
  annotCanvas.width = exportCanvas.width;
  annotCanvas.height = exportCanvas.height;
  const aCtx = annotCanvas.getContext('2d');
  
  aCtx.save();
  aCtx.scale(scaleFactor, scaleFactor);
  aCtx.translate(-selection.x, -selection.y);
  
  drawingActions.forEach(action => {
    drawShapeOnCtx(aCtx, action);
  });
  aCtx.restore();
  
  exportCtx.drawImage(annotCanvas, 0, 0);
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

captureFramesBtn.addEventListener('click', async () => {
  if (!frameCaptureSettings || !hasSelection) return;

  captureFramesBtn.classList.add('disabled');
  captureFramesBtn.querySelector('span').textContent = 'Capturing…';
  try {
    await window.electronAPI.captureRegionFrames({
      x: selection.x,
      y: selection.y,
      width: selection.w,
      height: selection.h,
      count: frameCaptureSettings.count,
      intervalMs: frameCaptureSettings.intervalMs
    });
    stopMarchingAnts();
  } catch (error) {
    console.error('Frame capture failed:', error);
    alert(`Frame capture failed: ${error}`);
  } finally {
    captureFramesBtn.classList.remove('disabled');
    captureFramesBtn.querySelector('span').textContent = frameCaptureSettings
      ? `Copy ${frameCaptureSettings.count} frames`
      : 'Copy frames';
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
  } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'c') {
      clearCanvas();
    } else if (k === 'p') {
      setTool('pen');
    } else if (k === 'e') {
      setTool('eraser');
    } else if (k === 'h') {
      setTool('highlight');
    } else if (k === 'a') {
      setTool('arrow');
    } else if (k === 'r') {
      setTool('rect');
    } else if (k === 'l') {
      setTool('line');
    } else if (k === 't') {
      setTool('text');
    } else if (k === 'v' || k === 'm') {
      setTool('select');
    } else if (e.key === '1') {
      setColor('#ef4444');
    } else if (e.key === '2') {
      setColor('#f97316');
    } else if (e.key === '3') {
      setColor('#eab308');
    } else if (e.key === '4') {
      setColor('#22c55e');
    } else if (e.key === '5') {
      setColor('#06b6d4');
    } else if (e.key === '6') {
      setColor('#3b82f6');
    } else if (e.key === '7') {
      setColor('#a855f7');
    } else if (e.key === '8') {
      setColor('#ec4899');
    } else if (e.key === '9') {
      setColor('#ffffff');
    }
  }
});
