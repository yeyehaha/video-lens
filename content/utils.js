// ===== 工具:DOM 穿透、坐标映射、存储 =====

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// 生成区域唯一 id
function genId() {
  return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// 穿透 shadow DOM 查找所有匹配元素(斗鱼/虎牙/B站播放器普遍用 shadow root 包 video)
function deepQueryAll(selector, root = document) {
  const results = [...root.querySelectorAll(selector)];
  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot) results.push(...deepQueryAll(selector, el.shadowRoot));
  }
  return results;
}

function isVisible(el) {
  const s = getComputedStyle(el);
  if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

// 找页面上最适合放大的 video:有画面、可见、面积最大
function findMainVideo() {
  const videos = deepQueryAll('video').filter(
    (v) => v.videoWidth > 0 && v.videoHeight > 0 && isVisible(v)
  );
  let best = null;
  let bestArea = 0;
  for (const v of videos) {
    const r = v.getBoundingClientRect();
    if (r.width < 100 || r.height < 50) continue;
    const area = r.width * r.height;
    if (area > bestArea) {
      best = v;
      bestArea = area;
    }
  }
  return best;
}

// 计算 video 实际画面在视口中的矩形。
// video 元素框 ≠ 画面显示框(object-fit 黑边/裁切),框选和放大都必须基于画面矩形,
// 否则选的位置和放大出来的位置对不上。
function getVideoContentRect(video) {
  const r = video.getBoundingClientRect();
  const va = video.videoWidth / video.videoHeight;
  if (!isFinite(va) || va <= 0 || r.width <= 0 || r.height <= 0) return null;

  const fit = getComputedStyle(video).objectFit || 'contain';

  if (fit === 'fill') {
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }
  if (fit === 'cover') {
    const s = Math.max(r.width / video.videoWidth, r.height / video.videoHeight);
    const w = video.videoWidth * s;
    const h = video.videoHeight * s;
    return { left: r.left - (w - r.width) / 2, top: r.top - (h - r.height) / 2, width: w, height: h };
  }
  // contain(默认)及其余情况:画面完整显示、可能留黑边
  const ea = r.width / r.height;
  if (ea > va) {
    const h = r.height;
    const w = h * va;
    return { left: r.left + (r.width - w) / 2, top: r.top, width: w, height: h };
  }
  const w = r.width;
  const h = w / va;
  return { left: r.left, top: r.top + (r.height - h) / 2, width: w, height: h };
}

// 视口坐标 → 相对画面内容的归一化坐标(0~1)。窗口缩放、全屏、清晰度切换后依然成立。
function clientToNorm(video, x, y) {
  const c = getVideoContentRect(video);
  if (!c || c.width <= 0 || c.height <= 0) return null;
  return {
    x: clamp((x - c.left) / c.width, 0, 1),
    y: clamp((y - c.top) / c.height, 0, 1),
  };
}

// 按房间 URL(域名+路径)存储配置,每个直播间/主播独立记忆。
// 防御:扩展重载后,残留旧 content script 的 chrome.* 绑定会失效(chrome.storage 变 undefined),
// 读不到就当无数据、写不进就放弃,不抛未捕获异常。
const RoomStore = {
  writeQueue: Promise.resolve(),
  key() {
    return location.host + location.pathname.replace(/\/+$/, '');
  },
  async get(roomKey = this.key()) {
    if (!chrome.storage?.local) return null;
    await this.writeQueue;
    const { rooms = {} } = await chrome.storage.local.get('rooms');
    return rooms[roomKey] || null;
  },
  set(patch, roomKey = this.key()) {
    if (!chrome.storage?.local) return null;
    const write = async () => {
      const { rooms = {} } = await chrome.storage.local.get('rooms');
      rooms[roomKey] = { ...(rooms[roomKey] || {}), ...patch };
      await chrome.storage.local.set({ rooms });
      return rooms[roomKey];
    };
    this.writeQueue = this.writeQueue.catch(() => {}).then(write);
    return this.writeQueue;
  },
  clear(roomKey = this.key()) {
    if (!chrome.storage?.local) return;
    const write = async () => {
      const { rooms = {} } = await chrome.storage.local.get('rooms');
      delete rooms[roomKey];
      await chrome.storage.local.set({ rooms });
    };
    this.writeQueue = this.writeQueue.catch(() => {}).then(write);
    return this.writeQueue;
  },
};

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
