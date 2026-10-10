// ===== Popup:与 content script 通信(多窗口 + 方案) =====

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const selectBtn = $('selectBtn');
const schemeSelect = $('schemeSelect');
const schemeName = $('schemeName');
const saveSchemeBtn = $('saveSchemeBtn');
const newSchemeBtn = $('newSchemeBtn');
const deleteSchemeBtn = $('deleteSchemeBtn');
const zoomSlider = $('zoom');
const zoomVal = $('zoomVal');
const showToggle = $('showToggle');
const clearBtn = $('clearBtn');

let lastSchemeKey = ''; // 方案列表没变时不重建下拉框,避免打断用户操作
let lastStatus = null;

async function send(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('no active tab');
  return chrome.tabs.sendMessage(tab.id, msg);
}

function showError(text) {
  statusEl.className = 'err';
  statusEl.textContent = text || '操作失败';
}

// 自动命名:方案 N,已存在则递增
function autoName(names = []) {
  let i = (names.length || 0) + 1;
  let name = `方案 ${i}`;
  while (names.includes(name)) name = `方案 ${++i}`;
  return name;
}

function setControlsEnabled(on) {
  selectBtn.disabled = !on;
  zoomSlider.disabled = !on;
  saveSchemeBtn.disabled = !on;
  newSchemeBtn.disabled = !on;
  schemeSelect.disabled = !on;
}

function renderSchemes(s) {
  const key = JSON.stringify([s.schemeNames, s.activeScheme]);
  if (key === lastSchemeKey) return;
  lastSchemeKey = key;
  schemeSelect.innerHTML = '';
  if (!s.schemeNames.length) {
    const opt = document.createElement('option');
    opt.textContent = '（暂无方案）';
    opt.disabled = true;
    opt.selected = true;
    schemeSelect.appendChild(opt);
  } else {
    for (const name of s.schemeNames) {
      const opt = document.createElement('option');
      opt.value = opt.textContent = name;
      if (name === s.activeScheme) opt.selected = true;
      schemeSelect.appendChild(opt);
    }
  }
}

function renderStatus(s) {
  lastStatus = s;
  if (!s) {
    statusEl.className = 'err';
    statusEl.textContent = '当前页面不可用(请在斗鱼/虎牙/B站直播/YouTube/Twitch 的直播页打开)';
    setControlsEnabled(false);
    deleteSchemeBtn.disabled = true;
    return;
  }
  if (!s.found) {
    statusEl.className = 'err';
    statusEl.textContent = '未检测到正在播放的视频,等视频开始播放后再试';
  } else if (s.windowCount > 0) {
    statusEl.className = 'ok';
    statusEl.textContent = `已找到视频 · 方案「${s.activeScheme || '—'}」 · ${s.windowCount} 个窗口`;
  } else {
    statusEl.className = '';
    statusEl.textContent = '已找到视频,点击框选按钮添加放大窗口';
  }
  setControlsEnabled(s.found);
  deleteSchemeBtn.disabled = !s.activeScheme;

  renderSchemes(s);

  // 滑条正被拖动时不回写,避免打架
  if (document.activeElement !== zoomSlider) {
    if (s.zoom != null) {
      zoomSlider.value = s.zoom;
      zoomVal.textContent = `×${s.zoom}`;
    }
  }
  showToggle.checked = s.windowCount > 0;
}

async function refresh() {
  try {
    renderStatus(await send({ type: 'getStatus' }));
  } catch {
    renderStatus(null);
  }
}

selectBtn.addEventListener('click', async () => {
  try {
    const res = await send({ type: 'startSelection' });
    if (!res?.ok) {
      statusEl.className = 'err';
      statusEl.textContent = res?.error || '操作失败';
      return;
    }
    statusEl.className = 'ok';
    statusEl.textContent = '请回到页面,拖动鼠标框选区域( Esc 取消 )';
    window.close();
  } catch {
    renderStatus(null);
  }
});

schemeSelect.addEventListener('change', async () => {
  try {
    await send({ type: 'applyScheme', name: schemeSelect.value });
  } catch {
    /* ignore */
  }
  refresh();
});

saveSchemeBtn.addEventListener('click', async () => {
  const name = schemeName.value.trim() || autoName(lastStatus?.schemeNames);
  try {
    const res = await send({ type: 'saveSchemeAs', name });
    if (res?.ok) {
      schemeName.value = '';
      lastSchemeKey = ''; // 强制重建下拉框
    } else {
      showError(res?.error);
    }
  } catch {
    renderStatus(null);
    return;
  }
  refresh();
});

newSchemeBtn.addEventListener('click', async () => {
  const name = schemeName.value.trim() || autoName(lastStatus?.schemeNames);
  try {
    const res = await send({ type: 'newScheme', name });
    if (res?.ok) {
      schemeName.value = '';
      lastSchemeKey = '';
    } else {
      showError(res?.error);
    }
  } catch {
    renderStatus(null);
    return;
  }
  refresh();
});

deleteSchemeBtn.addEventListener('click', async () => {
  if (!schemeSelect.value) return;
  try {
    await send({ type: 'deleteScheme', name: schemeSelect.value });
  } catch {
    /* ignore */
  }
  lastSchemeKey = '';
  refresh();
});

zoomSlider.addEventListener('input', async () => {
  zoomVal.textContent = `×${zoomSlider.value}`;
  try {
    await send({ type: 'setZoom', value: Number(zoomSlider.value) });
  } catch {
    /* 页面侧无接收者时静默 */
  }
});

showToggle.addEventListener('change', async () => {
  try {
    await send({ type: 'toggle', show: showToggle.checked });
  } catch {
    /* ignore */
  }
  refresh();
});

clearBtn.addEventListener('click', async () => {
  try {
    await send({ type: 'clearRoom' });
  } catch {
    /* ignore */
  }
  lastSchemeKey = '';
  refresh();
});

refresh();
setInterval(refresh, 1000);
