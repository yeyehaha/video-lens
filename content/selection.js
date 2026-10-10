// ===== 框选 / 裁剪调整 =====

// ---------- 遮罩(选区外压暗) ----------
function makeShades(layer) {
  return [...layer.querySelectorAll('.vl-shade')];
}

function updateShades(shades, b) {
  const vw = innerWidth;
  const vh = innerHeight;
  const [top, bottom, left, right] = shades;
  const x1 = b.left + b.width;
  const y1 = b.top + b.height;
  Object.assign(top.style, { left: '0px', top: '0px', width: `${vw}px`, height: `${Math.max(0, b.top)}px` });
  Object.assign(bottom.style, { left: '0px', top: `${y1}px`, width: `${vw}px`, height: `${Math.max(0, vh - y1)}px` });
  Object.assign(left.style, { left: '0px', top: `${b.top}px`, width: `${Math.max(0, b.left)}px`, height: `${b.height}px` });
  Object.assign(right.style, { left: `${x1}px`, top: `${b.top}px`, width: `${Math.max(0, vw - x1)}px`, height: `${b.height}px` });
}

// ---------- 放大镜:框选/裁剪时跟随光标,4 倍放大看清边缘 ----------
function createLoupe(layer, video) {
  const el = document.createElement('div');
  el.className = 'vl-loupe';
  const cv = document.createElement('canvas');
  cv.width = 120;
  cv.height = 120;
  el.appendChild(cv);
  layer.appendChild(el);
  const ctx = cv.getContext('2d');
  const SIZE = 120;
  const SRC = 30; // 源半径 30px → 约 4 倍放大

  function update(cx, cy) {
    if (!video.videoWidth || !video.videoHeight) return;
    const c = getVideoContentRect(video);
    if (!c) return;
    // 源窗口始终以光标为中心(十字准星即光标位置),不做平移钳制——
    // 否则贴近画面边缘时准星和实际指向会错位;越出画面的部分保持黑色
    const sx = ((cx - c.left) / c.width) * video.videoWidth - SRC;
    const sy = ((cy - c.top) / c.height) * video.videoHeight - SRC;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.drawImage(video, sx, sy, SRC * 2, SRC * 2, 0, 0, SIZE, SIZE);
    ctx.strokeStyle = 'rgba(255, 70, 70, 0.95)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(SIZE / 2, 0);
    ctx.lineTo(SIZE / 2, SIZE);
    ctx.moveTo(0, SIZE / 2);
    ctx.lineTo(SIZE, SIZE / 2);
    ctx.stroke();
    // 跟随光标;靠近屏幕边缘时翻到另一侧,避免出屏
    const off = 20;
    let lx = cx + off;
    let ly = cy + off;
    if (lx + SIZE > innerWidth - 4) lx = cx - off - SIZE;
    if (ly + SIZE > innerHeight - 4) ly = cy - off - SIZE;
    el.style.left = `${Math.max(4, lx)}px`;
    el.style.top = `${Math.max(4, ly)}px`;
  }

  return {
    update,
    destroy: () => el.remove(),
  };
}

// ---------- 智能吸附:贴合摄像头窗口的"内容"边界 ----------
// 摄像头窗口是多层结构:游戏画面 →(阴影)→ 边框线 → 内容,每层交界都是一条强梯度线。
// 策略:找最强峰 → 向内容侧走,跳过边框/阴影层 → 落在最贴近内容的边界 → +1px 跳过过渡像素。
// 圆角通过只扫描边的中段 70% 规避。

function bestCol(gray, W, target, R, y0, y1, inward) {
  const c0 = Math.max(1, Math.round(target) - R);
  const c1 = Math.min(W - 2, Math.round(target) + R);
  if (c1 <= c0) return null;
  const vals = [];
  for (let c = c0; c <= c1; c++) {
    let s = 0;
    let n = 0;
    for (let y = Math.round(y0); y <= Math.round(y1); y += 2) {
      s += Math.abs(gray(c + 1, y) - gray(c, y));
      n++;
    }
    vals.push(n ? s / n : 0);
  }
  const sorted = [...vals].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1] || 0;
  let m = 0;
  for (let i = 1; i < vals.length; i++) if (vals[i] > vals[m]) m = i;
  if (vals[m] < 10 || vals[m] < median * 2.5) return null;

  // 向内容侧(inward=+1 向右 / -1 向左)取最强峰 10px 内最后一个达标列:
  // 跳过边框/阴影层,但 10px 以内的强线视作画面内容,不跟过去
  const floor = Math.max(10, median * 2.5, vals[m] * 0.5);
  const limit = Math.max(0, Math.min(vals.length - 1, m + inward * 10));
  for (let i = m + inward; inward > 0 ? i <= limit : i >= limit; i += inward) {
    if (vals[i] >= floor) m = i;
  }
  return c0 + m;
}

function bestRow(gray, H, target, R, x0, x1, inward) {
  const r0 = Math.max(1, Math.round(target) - R);
  const r1 = Math.min(H - 2, Math.round(target) + R);
  if (r1 <= r0) return null;
  const vals = [];
  for (let r = r0; r <= r1; r++) {
    let s = 0;
    let n = 0;
    for (let x = Math.round(x0); x <= Math.round(x1); x += 2) {
      s += Math.abs(gray(x, r + 1) - gray(x, r));
      n++;
    }
    vals.push(n ? s / n : 0);
  }
  const sorted = [...vals].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1] || 0;
  let m = 0;
  for (let i = 1; i < vals.length; i++) if (vals[i] > vals[m]) m = i;
  if (vals[m] < 10 || vals[m] < median * 2.5) return null;

  const floor = Math.max(10, median * 2.5, vals[m] * 0.5);
  const limit = Math.max(0, Math.min(vals.length - 1, m + inward * 10));
  for (let i = m + inward; inward > 0 ? i <= limit : i >= limit; i += inward) {
    if (vals[i] >= floor) m = i;
  }
  return r0 + m;
}

function snapRegion(video, norm) {
  const out = { ...norm };
  try {
    const W = video.videoWidth;
    const H = video.videoHeight;
    if (!W || !H) return out;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0);
    const img = ctx.getImageData(0, 0, W, H).data;
    const gray = (x, y) => {
      const i = (y * W + x) << 2;
      return (img[i] * 3 + img[i + 1] * 4 + img[i + 2]) >> 3;
    };

    const R = Math.round(Math.min(W, H) * 0.03);
    const x0 = norm.x * W;
    const y0 = norm.y * H;
    const x1 = x0 + norm.w * W;
    const y1 = y0 + norm.h * H;
    // 只扫描边的中段,避开摄像头窗口的圆角
    const yA = y0 + (y1 - y0) * 0.15;
    const yB = y1 - (y1 - y0) * 0.15;
    const xA = x0 + (x1 - x0) * 0.15;
    const xB = x1 - (x1 - x0) * 0.15;

    const nx0 = bestCol(gray, W, x0, R, yA, yB, +1); // 左边:内容在右侧,向内 = 向右
    const nx1 = bestCol(gray, W, x1, R, yA, yB, -1); // 右边:内容在左侧,向内 = 向左
    const ny0 = bestRow(gray, H, y0, R, xA, xB, +1);
    const ny1 = bestRow(gray, H, y1, R, xA, xB, -1);

    // 峰值列是"过渡前"的那一列,+1 跳过过渡像素/边框线,让裁剪从内容的第一个像素开始
    let sx0 = nx0 != null ? nx0 + 1 : x0;
    let sx1 = nx1 != null ? nx1 + 1 : x1;
    let sy0 = ny0 != null ? ny0 + 1 : y0;
    let sy1 = ny1 != null ? ny1 + 1 : y1;
    // 吸附后太小(两边吸到同一条线)则整条边放弃
    if (sx1 - sx0 < 8) {
      sx0 = x0;
      sx1 = x1;
    }
    if (sy1 - sy0 < 8) {
      sy0 = y0;
      sy1 = y1;
    }
    out.x = sx0 / W;
    out.w = (sx1 - sx0) / W;
    out.y = sy0 / H;
    out.h = (sy1 - sy0) / H;
  } catch {
    /* DRM/跨域等读不到像素时,保持用户手选的区域 */
  }
  return out;
}

// ---------- 框选区域 ----------
function startRegionSelection(video, onDone, onCancel) {
  document.getElementById('vl-select-layer')?.remove();

  const layer = document.createElement('div');
  layer.id = 'vl-select-layer';
  layer.className = 'vl-select';
  layer.innerHTML = `
    <div class="vl-select-hint">拖动框选要放大的区域,松开自动贴合边框(Esc 取消)</div>
    <div class="vl-shade"></div><div class="vl-shade"></div>
    <div class="vl-shade"></div><div class="vl-shade"></div>
    <div class="vl-select-box"><span class="vl-select-size"></span></div>
  `;
  (document.fullscreenElement || document.body).appendChild(layer);

  const shades = makeShades(layer);
  const box = layer.querySelector('.vl-select-box');
  const sizeLabel = layer.querySelector('.vl-select-size');
  const loupe = createLoupe(layer, video);

  let started = false;
  let sx0 = 0;
  let sy0 = 0;
  let cleaned = false;

  function cleanup(done, region) {
    if (cleaned) return;
    cleaned = true;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('keydown', onKey);
    loupe.destroy();
    layer.remove();
    if (done) onDone(snapRegion(video, region));
    else onCancel?.();
  }

  function onKey(e) {
    if (e.key === 'Escape') cleanup(false);
  }

  function onMove(ev) {
    loupe.update(ev.clientX, ev.clientY);
    if (!started) return;
    const x0 = Math.min(sx0, ev.clientX);
    const y0 = Math.min(sy0, ev.clientY);
    const x1 = Math.max(sx0, ev.clientX);
    const y1 = Math.max(sy0, ev.clientY);
    const w = x1 - x0;
    const h = y1 - y0;

    box.style.left = `${x0}px`;
    box.style.top = `${y0}px`;
    box.style.width = `${w}px`;
    box.style.height = `${h}px`;
    box.style.display = 'block';
    sizeLabel.textContent = `${Math.round(w)}×${Math.round(h)}px`;
    updateShades(shades, { left: x0, top: y0, width: w, height: h });
  }

  function onUp(ev) {
    if (!started) return;
    const x0 = Math.min(sx0, ev.clientX);
    const y0 = Math.min(sy0, ev.clientY);
    const x1 = Math.max(sx0, ev.clientX);
    const y1 = Math.max(sy0, ev.clientY);
    if (x1 - x0 < 24 || y1 - y0 < 24) {
      cleanup(false); // 拖得太小视为取消
      return;
    }
    // 两个角都转成相对画面内容的归一化坐标(自动处理黑边/裁切)
    const p0 = clientToNorm(video, x0, y0);
    const p1 = clientToNorm(video, x1, y1);
    if (!p0 || !p1) {
      cleanup(false);
      return;
    }
    cleanup(true, {
      x: Math.min(p0.x, p1.x),
      y: Math.min(p0.y, p1.y),
      w: Math.abs(p1.x - p0.x),
      h: Math.abs(p1.y - p0.y),
    });
  }

  layer.addEventListener('pointerdown', (e) => {
    if (started || e.button !== 0) return;
    started = true;
    sx0 = e.clientX;
    sy0 = e.clientY;
    e.preventDefault();
  });
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('keydown', onKey);
}

// ---------- 裁剪调整:在视频上拖动/拉角已有区域,实时预览 ----------
// handlers: { onChange(norm) 实时, onCommit(norm) 每次松手提交, onEnd(cancelled) 会话结束 }
// 返回 end(cancelled) 供外部主动结束
function startRegionAdjust(video, norm, handlers) {
  if (!getVideoContentRect(video)) {
    handlers.onEnd?.(true);
    return () => {};
  }
  document.getElementById('vl-adj-layer')?.remove();

  const layer = document.createElement('div');
  layer.id = 'vl-adj-layer';
  layer.className = 'vl-select vl-select-adjust';
  layer.innerHTML = `
    <div class="vl-select-hint">拖动 / 拉角调整裁剪区域;点空白处或按 Esc 结束</div>
    <div class="vl-shade"></div><div class="vl-shade"></div>
    <div class="vl-shade"></div><div class="vl-shade"></div>
    <div class="vl-adj-box">
      ${['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
        .map((d) => `<div class="vl-adj-handle vl-adj-${d}" data-d="${d}"></div>`)
        .join('')}
    </div>
  `;
  (document.fullscreenElement || document.body).appendChild(layer);

  const shades = makeShades(layer);
  const boxEl = layer.querySelector('.vl-adj-box');
  const loupe = createLoupe(layer, video);

  const normToBox = (n) => {
    const c = getVideoContentRect(video);
    return {
      left: c.left + n.x * c.width,
      top: c.top + n.y * c.height,
      width: n.w * c.width,
      height: n.h * c.height,
    };
  };
  const boxToNorm = (b) => {
    const p0 = clientToNorm(video, b.left, b.top);
    const p1 = clientToNorm(video, b.left + b.width, b.top + b.height);
    return { x: p0.x, y: p0.y, w: p1.x - p0.x, h: p1.y - p0.y };
  };

  let cur = normToBox(norm);
  let mode = null; // null | 'move' | n/s/e/w/组合
  let startBox = null;
  let sx = 0;
  let sy = 0;
  let cleaned = false;

  function render() {
    Object.assign(boxEl.style, {
      left: `${cur.left}px`,
      top: `${cur.top}px`,
      width: `${cur.width}px`,
      height: `${cur.height}px`,
    });
    updateShades(shades, cur);
  }

  function cleanup(done) {
    if (cleaned) return;
    cleaned = true;
    layer.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('keydown', onKey);
    loupe.destroy();
    layer.remove();
    if (done) handlers.onCommit?.(boxToNorm(cur));
    handlers.onEnd?.(!done);
  }

  function onKey(e) {
    if (e.key === 'Escape') cleanup(false);
  }

  function onMove(ev) {
    loupe.update(ev.clientX, ev.clientY);
    if (!mode) return;
    const dx = ev.clientX - sx;
    const dy = ev.clientY - sy;
    const b = { ...startBox };
    if (mode === 'move') {
      b.left = startBox.left + dx;
      b.top = startBox.top + dy;
    } else {
      if (mode.includes('e')) b.width = startBox.width + dx;
      if (mode.includes('s')) b.height = startBox.height + dy;
      if (mode.includes('w')) {
        b.width = startBox.width - dx;
        b.left = startBox.left + dx;
      }
      if (mode.includes('n')) {
        b.height = startBox.height - dy;
        b.top = startBox.top + dy;
      }
      if (b.width < 24) {
        if (mode.includes('w')) b.left = startBox.left + startBox.width - 24;
        b.width = 24;
      }
      if (b.height < 24) {
        if (mode.includes('n')) b.top = startBox.top + startBox.height - 24;
        b.height = 24;
      }
    }
    // 限制在画面内容矩形内
    const c = getVideoContentRect(video);
    if (c) {
      b.left = clamp(b.left, c.left, c.left + c.width - b.width);
      b.top = clamp(b.top, c.top, c.top + c.height - b.height);
    }
    cur = b;
    render();
    handlers.onChange?.(boxToNorm(cur));
  }

  function onUp() {
    if (!mode) return;
    mode = null;
    // 裁剪不吸附,所见即所得
    handlers.onCommit?.(boxToNorm(cur));
  }

  boxEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || cleaned) return;
    e.preventDefault();
    e.stopPropagation();
    mode = e.target.closest('.vl-adj-handle')?.dataset.d || 'move';
    startBox = { ...cur };
    sx = e.clientX;
    sy = e.clientY;
  });

  // 点在框外的空白处:确认并结束
  layer.addEventListener('pointerdown', (e) => {
    if (e.target !== layer || cleaned) return;
    e.preventDefault();
    cleanup(true);
  });

  layer.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('keydown', onKey);
  render();

  return (cancelled) => cleanup(!cancelled);
}
