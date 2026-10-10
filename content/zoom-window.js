// ===== 悬浮放大窗口 =====
// 不克隆 video(MSE 的 blob: 源一个 MediaSource 只能挂一个元素),
// 直接每帧从原 video 的当前帧 drawImage 裁剪区域到 canvas,GPU 加速、零额外流量。

class ZoomWindow {
  static ZOOM_MIN = 1;
  static ZOOM_MAX = 5;

  constructor(video, config) {
    this.video = video;
    this.id = config.id || genId();
    this.title = config.title || '放大';
    this.norm = { x: config.x, y: config.y, w: config.w, h: config.h }; // 归一化区域
    this.zoom = clamp(config.zoom || 1, ZoomWindow.ZOOM_MIN, ZoomWindow.ZOOM_MAX);
    this.savedWin = config.win || null; // {left, top, width, height}
    this.onPersist = null; // (state) => void,由 main.js 接管持久化
    this.onClose = null; // (id) => void,关闭时通知 main 移除对应区域
    this.onCrop = null; // (id) => void,点击 ✂ 进入裁剪调整
    this.onRename = null; // (id, name) => void,标题重命名
    this.destroyed = false;
    this._cbKind = null;
    this._cbHandle = 0;
    this._cbVideo = null;
    this._build();
    this._reparent(); // 全屏时必须挂进全屏元素,否则不可见
    this._layout();
    this._bindHeaderDrag();
    this._bindResize();
    this._bindButtons();
    this._bindWheel();
    this._bindTitleRename();
    this.drawFrame();
    this.startDrawLoop();
  }

  _build() {
    const box = document.createElement('div');
    box.className = 'vl-zoom';
    box.dataset.vlZoomId = this.id; // 多窗口:不再用固定 id,避免互相覆盖删除
    box.innerHTML = `
      <div class="vl-zoom-header">
        <span class="vl-zoom-title"></span>
        <span class="vl-zoom-val"></span>
        <button class="vl-zoom-btn" data-act="crop" title="调整裁剪区域">✂</button>
        <button class="vl-zoom-btn" data-act="minus" title="缩小">−</button>
        <button class="vl-zoom-btn" data-act="plus" title="放大">＋</button>
        <button class="vl-zoom-btn vl-zoom-close" data-act="close" title="关闭">✕</button>
      </div>
      <div class="vl-zoom-body"><canvas class="vl-zoom-canvas"></canvas></div>
    `;
    this.box = box;
    this.header = box.querySelector('.vl-zoom-header');
    this.valEl = box.querySelector('.vl-zoom-val');
    this.titleEl = box.querySelector('.vl-zoom-title');
    this.canvas = box.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.titleEl.title = '点击重命名';
    this.titleEl.textContent = `🔍 ${this.title}`;
    this._updateZoomLabel();
  }

  // 全屏时只有全屏元素及其子节点会被渲染,窗口需重挂
  _reparent() {
    (document.fullscreenElement || document.body).appendChild(this.box);
  }

  _layout() {
    const vw = innerWidth;
    const vh = innerHeight;
    // 默认高度按裁剪区域宽高比算,尽量让画面铺满窗口
    const cropAspect =
      this.video.videoWidth && this.video.videoHeight
        ? (this.norm.w * this.video.videoWidth) / (this.norm.h * this.video.videoHeight)
        : 16 / 9;
    let width = this.savedWin?.width || 360;
    let height = this.savedWin?.height || Math.round(width / cropAspect);
    width = clamp(width, 160, Math.min(820, vw - 16));
    height = clamp(height, 120, Math.min(920, vh - 16));
    let left = this.savedWin?.left ?? vw - width - 24;
    let top = this.savedWin?.top ?? Math.max(12, Math.round(vh * 0.12));
    left = clamp(left, 0, Math.max(0, vw - 80));
    top = clamp(top, 0, Math.max(0, vh - 60));
    Object.assign(this.box.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`,
    });
  }

  getWinState() {
    const r = this.box.getBoundingClientRect();
    return {
      left: Math.round(r.left),
      top: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
  }

  _persist() {
    this.onPersist?.({ zoom: this.zoom, win: this.getWinState() });
  }

  // 放大倍率语义:窗口大小不变,显示的区域缩小为 1/zoom(以选中区域中心为焦点)
  _srcRect() {
    const v = this.video;
    if (!v || !v.videoWidth || !v.videoHeight) return null;
    const sw = (this.norm.w * v.videoWidth) / this.zoom;
    const sh = (this.norm.h * v.videoHeight) / this.zoom;
    const sx = clamp(
      (this.norm.x + this.norm.w / 2) * v.videoWidth - sw / 2,
      0,
      v.videoWidth - sw
    );
    const sy = clamp(
      (this.norm.y + this.norm.h / 2) * v.videoHeight - sh / 2,
      0,
      v.videoHeight - sh
    );
    return { sx, sy, sw, sh };
  }

  drawFrame() {
    if (this.destroyed) return;
    const r = this._srcRect();
    if (!r) return;
    // canvas 内部分辨率 = 源区域真实像素(上限 1600),CSS 再拉伸 → 尽量清晰
    const MAX = 1600;
    const scale = Math.min(1, MAX / Math.max(r.sw, r.sh));
    const cw = Math.max(2, Math.round(r.sw * scale));
    const ch = Math.max(2, Math.round(r.sh * scale));
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    try {
      this.ctx.drawImage(this.video, r.sx, r.sy, r.sw, r.sh, 0, 0, cw, ch);
    } catch {
      /* DRM 等极端情况下 drawImage 可能抛错,忽略此帧 */
    }
  }

  startDrawLoop() {
    const step = () => {
      if (this.destroyed) return;
      this.drawFrame();
      this._schedule(step);
    };
    this._schedule(step);
  }

  // 有新解码帧才画(rVFC);不支持时退回 rAF
  _schedule(step) {
    if (this.destroyed) return;
    if (typeof this.video.requestVideoFrameCallback === 'function') {
      this._cbKind = 'vfc';
      this._cbVideo = this.video; // 记住注册到哪个元素上,换 video 后才能正确取消
      this._cbHandle = this.video.requestVideoFrameCallback(() => step());
    } else {
      this._cbKind = 'raf';
      this._cbHandle = requestAnimationFrame(step);
    }
  }

  stopDrawLoop() {
    if (this._cbKind === 'vfc' && this._cbVideo?.cancelVideoFrameCallback) {
      this._cbVideo.cancelVideoFrameCallback(this._cbHandle);
    } else if (this._cbKind === 'raf') {
      cancelAnimationFrame(this._cbHandle);
    }
    this._cbKind = null;
    this._cbVideo = null;
  }

  setZoom(z) {
    this.zoom = clamp(z, ZoomWindow.ZOOM_MIN, ZoomWindow.ZOOM_MAX);
    this._updateZoomLabel();
    this.drawFrame();
    this._persist();
  }

  _updateZoomLabel() {
    this.valEl.textContent = `×${this.zoom.toFixed(2).replace(/0$/, '')}`;
  }

  setVisible(show) {
    this.box.style.display = show ? '' : 'none';
    if (show) this.drawFrame();
  }

  _bindHeaderDrag() {
    this.header.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.vl-zoom-btn') || e.target.closest('input')) return;
      e.preventDefault();
      this.header.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startY = e.clientY;
      const r = this.box.getBoundingClientRect();
      const onMove = (ev) => {
        const left = clamp(r.left + ev.clientX - startX, -this.box.offsetWidth + 80, innerWidth - 80);
        const top = clamp(r.top + ev.clientY - startY, 0, innerHeight - 36);
        this.box.style.left = `${left}px`;
        this.box.style.top = `${top}px`;
      };
      const onUp = () => {
        this.header.removeEventListener('pointermove', onMove);
        this.header.removeEventListener('pointerup', onUp);
        this._persist();
      };
      this.header.addEventListener('pointermove', onMove);
      this.header.addEventListener('pointerup', onUp);
    });
  }

  // 八向调整大小:四条边 + 四个角
  _bindResize() {
    for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
      const h = document.createElement('div');
      h.className = `vl-zoom-rh vl-rh-${dir}`;
      h.title = '拖动调整大小';
      h.addEventListener('pointerdown', (e) => this._startResize(e, dir));
      this.box.appendChild(h);
    }
  }

  _startResize(e, dir) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const start = this.box.getBoundingClientRect();
    const sx = e.clientX;
    const sy = e.clientY;
    const onMove = (ev) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      let { left, top, width, height } = start;
      // 各方向独立计算;角柄同时命中两轴。最小 160×120,同时不拖出视口
      if (dir.includes('e')) width = clamp(start.width + dx, 160, innerWidth - start.left - 8);
      if (dir.includes('s')) height = clamp(start.height + dy, 120, innerHeight - start.top - 8);
      if (dir.includes('w')) {
        width = clamp(start.width - dx, 160, start.left + start.width);
        left = start.left + start.width - width;
      }
      if (dir.includes('n')) {
        height = clamp(start.height - dy, 120, start.top + start.height);
        top = start.top + start.height - height;
      }
      Object.assign(this.box.style, {
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        height: `${height}px`,
      });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      this.drawFrame();
      this._persist();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  // 点击标题重命名:原地变输入框,Enter/失焦提交,Esc 取消
  _bindTitleRename() {
    this.titleEl.addEventListener('click', () => {
      if (this.destroyed || this.titleEl.querySelector('input')) return;
      const input = document.createElement('input');
      input.className = 'vl-zoom-title-input';
      input.value = this.title;
      this.titleEl.textContent = '';
      this.titleEl.appendChild(input);
      input.focus();
      input.select();

      const render = () => {
        this.titleEl.textContent = `🔍 ${this.title}`;
      };
      let settled = false;
      input.addEventListener('keydown', (ev) => {
        ev.stopPropagation(); // 不让按键冒泡到页面快捷键
        if (ev.key === 'Enter') {
          settled = true;
          this.title = input.value.trim() || this.title;
          this.onRename?.(this.id, this.title);
          input.blur();
          render();
        } else if (ev.key === 'Escape') {
          settled = true;
          input.blur();
          render();
        }
      });
      input.addEventListener('blur', () => {
        if (settled) return;
        this.title = input.value.trim() || this.title;
        this.onRename?.(this.id, this.title);
        render();
      });
    });
  }

  _bindButtons() {
    this.box.addEventListener('click', (e) => {
      const act = e.target.closest('.vl-zoom-btn')?.dataset.act;
      if (act === 'minus') this.setZoom(this.zoom - 0.25);
      else if (act === 'plus') this.setZoom(this.zoom + 0.25);
      else if (act === 'crop') this.onCrop?.(this.id);
      else if (act === 'close') {
        this.destroy();
        this.onClose?.(this.id);
      }
    });
  }

  _bindWheel() {
    this.box.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.setZoom(this.zoom + (e.deltaY < 0 ? 0.25 : -0.25));
      },
      { passive: false }
    );
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopDrawLoop();
    this.box.remove();
  }
}
