// ===== 主逻辑:多窗口、方案(scheme)管理、找 video、SPA 换房、全屏、消息 =====

(() => {
  const DEFAULT_SCHEME = '默认';

  let video = null;
  const windows = new Map(); // regionId -> ZoomWindow
  let roomData = { schemes: {}, activeScheme: null };
  let lastHref = location.href;
  let endAdjustFn = null; // 当前裁剪会话的结束函数
  let followRafId = 0; // 画面跟随循环
  let lastVideoRect = null; // 上一帧的画面内容矩形(跟随基准)

  // 保存调度时就固定房间和布局，避免 SPA 换房后把旧布局写到新房间。
  const pendingSaves = new Map();
  function schedulePersist() {
    const roomKey = RoomStore.key();
    const snapshot = structuredClone({ schemes: roomData.schemes, activeScheme: roomData.activeScheme });
    clearTimeout(pendingSaves.get(roomKey));
    pendingSaves.set(roomKey, setTimeout(() => {
      pendingSaves.delete(roomKey);
      RoomStore.set(snapshot, roomKey);
    }, 300));
  }

  function activeRegions() {
    const s = roomData.schemes[roomData.activeScheme];
    return s ? s.regions : null;
  }

  function findRegion(id) {
    return activeRegions()?.find((r) => r.id === id) || null;
  }

  function ensureScheme() {
    if (roomData.schemes[roomData.activeScheme]) return roomData.activeScheme;
    const first = Object.keys(roomData.schemes)[0];
    roomData.activeScheme = first || DEFAULT_SCHEME;
    if (!roomData.schemes[roomData.activeScheme]) {
      roomData.schemes[roomData.activeScheme] = { regions: [] };
    }
    return roomData.activeScheme;
  }

  // 新窗口无记忆位置时级联排开,避免全部叠在同一个默认位置
  function defaultWinPos(index) {
    const k = index % 6;
    return { left: Math.max(12, innerWidth - 384 - k * 30), top: 24 + k * 34 };
  }

  // 窗口几何 ↔ 相对画面矩形的锚点坐标。
  // 视口绝对像素只在"当时的画面状态"下有意义(网页全屏下存的尺寸,回普通模式就错位,反复切换还会滚雪球);
  // 一律存锚点,恢复/跟随时用当前画面矩形重算,任何状态下大小位置都保持相对一致。
  function absToRel(g, rect) {
    return {
      rx: (g.left - rect.left) / rect.width,
      ry: (g.top - rect.top) / rect.height,
      rw: g.width / rect.width,
      rh: g.height / rect.height,
    };
  }

  function relToAbs(rel, rect) {
    return {
      left: rect.left + rel.rx * rect.width,
      top: rect.top + rel.ry * rect.height,
      width: rel.rw * rect.width,
      height: rel.rh * rect.height,
    };
  }

  function createWindowFor(region, index) {
    const rect = getVideoContentRect(video);
    const geo = region.rel && rect
      ? relToAbs(region.rel, rect)
      : region.win || defaultWinPos(index);
    const win = new ZoomWindow(video, {
      id: region.id,
      title: region.name || `窗口 ${index + 1}`,
      ...region,
      win: geo,
    });
    win.onPersist = (state) => {
      const r = findRegion(region.id);
      if (r) {
        r.zoom = state.zoom;
        const rc = getVideoContentRect(video);
        if (rc) {
          r.rel = absToRel(state.win, rc);
          delete r.win; // 旧绝对坐标字段退役
        }
        schedulePersist();
      }
    };
    win.onClose = (id) => {
      windows.delete(id);
      const list = activeRegions();
      if (list) {
        const i = list.findIndex((r) => r.id === id);
        if (i >= 0) list.splice(i, 1);
        schedulePersist();
      }
    };
    win.onCrop = (id) => startAdjustFor(id);
    win.onRename = (id, name) => {
      const r = findRegion(id);
      if (r && r.name !== name) {
        r.name = name;
        schedulePersist();
      }
    };
    windows.set(region.id, win);
    // 仅旧数据迁移时反推锚点(没有 rel 才算)。
    // 已有锚点绝不能用展示几何覆盖 —— _layout 会把窗口钳制进视口,
    // 创建那一刻若被钳制(播放器未就绪的小尺寸/窗口变小/滚动位置不同),
    // 钳制后的位置会污染锚点,播放器恢复后位置就错了,且是否触发取决于时序。
    if (rect && !region.rel) {
      region.rel = absToRel(win.getWinState(), rect);
      delete region.win;
      schedulePersist();
    }
    ensureFollowLoop();
    return win;
  }

  function destroyAllWindows() {
    for (const w of windows.values()) w.destroy();
    windows.clear();
  }

  // 框选/裁剪时把悬浮窗压到覆盖层之下,避免挡住视频上的操作
  function lowerAllWindows() {
    for (const w of windows.values()) w.box.style.zIndex = 2147483646;
  }

  function restoreWindowZ() {
    for (const w of windows.values()) w.box.style.zIndex = '';
  }

  function endAdjust(cancelled = true) {
    endAdjustFn?.(cancelled);
    endAdjustFn = null;
  }

  // 裁剪:在视频上直接调整某个窗口的选取区域,实时预览
  function startAdjustFor(id) {
    const w = windows.get(id);
    const r = findRegion(id);
    if (!w || !r || !video) return;
    endAdjust();
    const original = { ...w.norm };
    lowerAllWindows();
    endAdjustFn = startRegionAdjust(video, w.norm, {
      onChange: (n) => {
        w.norm = { ...n };
        w.drawFrame();
      },
      onCommit: (n) => {
        w.norm = { ...n };
        const rr = findRegion(id);
        if (rr) {
          rr.x = n.x;
          rr.y = n.y;
          rr.w = n.w;
          rr.h = n.h;
        }
        w.drawFrame();
        schedulePersist();
      },
      onEnd: (cancelled) => {
        if (cancelled) {
          w.norm = original;
          w.drawFrame();
        }
        restoreWindowZ();
        endAdjustFn = null;
      },
    });
  }

  // ===== 画面跟随:原画面大小/位置变化(剧场模式、全屏、浏览器窗口缩放、滚动)时,
  // 用锚点 × 当前画面矩形无状态重算窗口几何 —— 不做增量变换,
  // 中途的视口钳制不会污染基准,来回切换/滚动都能精确回到相对位置 =====
  function applyFollow(rect) {
    for (const [id, w] of windows) {
      if (w.destroyed) continue;
      const region = findRegion(id);
      if (!region?.rel) continue;
      const g = relToAbs(region.rel, rect);
      const width = clamp(g.width, 160, Math.max(160, innerWidth));
      const height = clamp(g.height, 120, Math.max(120, innerHeight));
      const left = clamp(g.left, -width + 80, innerWidth - 80);
      const top = clamp(g.top, 0, innerHeight - 36);
      Object.assign(w.box.style, {
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        height: `${height}px`,
      });
      w.drawFrame();
    }
    // 画面变化不更新锚点、不写存储:锚点只在用户拖动/缩放窗口时(onPersist)变化,
    // 否则网页全屏下存的尺寸回普通模式会错位、反复全屏会滚雪球
  }

  function followLoop() {
    followRafId = 0;
    if (!alive()) return shutdown();
    const c = video ? getVideoContentRect(video) : null;
    if (c && lastVideoRect) {
      const moved =
        Math.abs(c.left - lastVideoRect.left) > 0.5 ||
        Math.abs(c.top - lastVideoRect.top) > 0.5 ||
        Math.abs(c.width - lastVideoRect.width) > 0.5 ||
        Math.abs(c.height - lastVideoRect.height) > 0.5;
      if (moved) {
        applyFollow(c);
        lastVideoRect = c;
      }
    } else if (c) {
      lastVideoRect = c; // 首帧只建立基准,不变换
    }
    if (windows.size) followRafId = requestAnimationFrame(followLoop);
  }

  function ensureFollowLoop() {
    if (!followRafId) {
      lastVideoRect = null; // 新会话从当前画面状态起步,避免用旧基准跳跃
      followRafId = requestAnimationFrame(followLoop);
    }
  }

  function createAllWindows() {
    destroyAllWindows();
    const list = activeRegions();
    if (!list) return;
    list.forEach((r, i) => createWindowFor(r, i));
  }

  // 读取房间数据;旧版单区域格式自动迁移为「默认」方案
  async function loadRoom(roomKey) {
    const raw = await RoomStore.get(roomKey);
    if (!raw) return { schemes: {}, activeScheme: null };
    if (raw.schemes) return raw;
    if (raw.x != null) {
      return {
        schemes: {
          [DEFAULT_SCHEME]: {
            regions: [
              {
                id: genId(),
                x: raw.x,
                y: raw.y,
                w: raw.w,
                h: raw.h,
                zoom: raw.zoom || 1,
                win: raw.win || null,
              },
            ],
          },
        },
        activeScheme: DEFAULT_SCHEME,
      };
    }
    return { schemes: {}, activeScheme: null };
  }

  let restoreToken = 0; // 并发恢复去重:轮询和 MutationObserver 可能同时触发 restore
  async function restore() {
    const roomKey = RoomStore.key();
    const currentVideo = video;
    const token = ++restoreToken;
    const saved = await loadRoom(roomKey);
    if (token !== restoreToken || roomKey !== RoomStore.key() || currentVideo !== video) return;
    roomData = saved;
    if (activeRegions()?.length) createAllWindows();
  }

  // 找 video:播放器在 shadow DOM 里、切清晰度会换 video 元素,需要反复扫描
  function scanVideo() {
    if (!alive()) return shutdown();
    const v = findMainVideo();
    if (v === video) return;
    video = v;
    endAdjust(); // video 变了,裁剪坐标基准失效,取消当前会话
    if (!v) {
      destroyAllWindows();
      return;
    }
    if (windows.size) {
      // video 元素被替换(换清晰度/全屏切换):逐个重绑并重启绘制循环
      for (const w of windows.values()) {
        w.video = v;
        w.stopDrawLoop();
        w._reparent();
        w.drawFrame();
        w.startDrawLoop();
      }
    } else {
      restore();
    }
  }

  const timers = [setInterval(scanVideo, 2000), setInterval(watchUrl, 1000)];
  const mo = new MutationObserver(debounce(scanVideo, 400));
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // 扩展重载/更新后,页面里残留的旧 content script 的 chrome.* 绑定会失效
  // (chrome.storage / chrome.runtime 变 undefined)。检测到就自动下线,不再抛错。
  function alive() {
    return !!(chrome.runtime?.id && chrome.storage?.local);
  }

  function shutdown() {
    for (const t of timers) clearInterval(t);
    cancelAnimationFrame(followRafId);
    followRafId = 0;
    mo.disconnect();
    endAdjust();
    destroyAllWindows();
  }

  // 斗鱼/B站换直播间是 SPA,页面不刷新、URL 会变 → 切换记忆配置
  function watchUrl() {
    if (!alive()) return shutdown();
    if (location.href === lastHref) return;
    lastHref = location.href;
    endAdjust();
    destroyAllWindows();
    video = null;
    roomData = { schemes: {}, activeScheme: null };
    scanVideo(); // 找到新 video 后 restore() 会读新房间 key
  }

  // 播放器全屏后只有全屏元素可见,窗口必须重挂进去
  document.addEventListener('fullscreenchange', () => {
    for (const w of windows.values()) w._reparent();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      switch (msg?.type) {
        case 'getStatus': {
          const list = activeRegions();
          sendResponse({
            found: !!video,
            roomKey: RoomStore.key(),
            schemeNames: Object.keys(roomData.schemes),
            activeScheme: roomData.activeScheme,
            windowCount: windows.size,
            zoom: list?.length ? list[0].zoom : null,
          });
          break;
        }

        case 'startSelection':
          if (!video) {
            sendResponse({ ok: false, error: '未找到正在播放的视频' });
            break;
          }
          lowerAllWindows();
          startRegionSelection(
            video,
            (norm) => {
              const name = ensureScheme();
              const scheme = roomData.schemes[name];
              const region = { id: genId(), ...norm, zoom: 1, win: null };
              scheme.regions.push(region);
              createWindowFor(region, scheme.regions.length - 1);
              schedulePersist();
              restoreWindowZ();
            },
            () => restoreWindowZ()
          );
          sendResponse({ ok: true });
          break;

        case 'setZoom':
          for (const w of windows.values()) w.setZoom(msg.value);
          sendResponse({ ok: true });
          break;

        case 'toggle':
          if (msg.show) {
            if (windows.size) {
              for (const w of windows.values()) w.setVisible(true);
            } else if (video && activeRegions()?.length) {
              createAllWindows();
            }
          } else {
            for (const w of windows.values()) w.setVisible(false);
          }
          sendResponse({ ok: true });
          break;

        case 'applyScheme':
          if (!roomData.schemes[msg.name]) {
            sendResponse({ ok: false });
            break;
          }
          roomData.activeScheme = msg.name;
          schedulePersist();
          createAllWindows();
          sendResponse({ ok: true });
          break;

        case 'saveSchemeAs': {
          const name = (msg.name || '').trim();
          if (!name) {
            sendResponse({ ok: false, error: '名称不能为空' });
            break;
          }
          if (roomData.schemes[name]) {
            sendResponse({ ok: false, error: `方案「${name}」已存在,请换个名字` });
            break;
          }
          const src = roomData.schemes[roomData.activeScheme];
          roomData.schemes[name] = {
            regions: src
              ? src.regions.map((r) => ({
                  ...r,
                  win: r.win ? { ...r.win } : null,
                  rel: r.rel ? { ...r.rel } : null,
                }))
              : [],
          };
          roomData.activeScheme = name;
          schedulePersist();
          sendResponse({ ok: true });
          break;
        }

        case 'newScheme': {
          const name = (msg.name || '').trim();
          if (!name) {
            sendResponse({ ok: false, error: '名称不能为空' });
            break;
          }
          if (roomData.schemes[name]) {
            sendResponse({ ok: false, error: `方案「${name}」已存在,请换个名字` });
            break;
          }
          roomData.schemes[name] = { regions: [] };
          roomData.activeScheme = name;
          destroyAllWindows(); // 空白方案:关闭现有窗口,从零开始框选
          schedulePersist();
          sendResponse({ ok: true });
          break;
        }

        case 'deleteScheme':
          if (!roomData.schemes[msg.name]) {
            sendResponse({ ok: false });
            break;
          }
          delete roomData.schemes[msg.name];
          if (roomData.activeScheme === msg.name) {
            roomData.activeScheme = Object.keys(roomData.schemes)[0] || null;
            createAllWindows();
          }
          schedulePersist();
          sendResponse({ ok: true });
          break;

        case 'clearRoom':
          endAdjust();
          destroyAllWindows();
          clearTimeout(pendingSaves.get(RoomStore.key()));
          pendingSaves.delete(RoomStore.key());
          await RoomStore.clear();
          roomData = { schemes: {}, activeScheme: null };
          sendResponse({ ok: true });
          break;

        default:
          sendResponse({ ok: false, error: 'unknown message' });
      }
    })();
    return true; // 异步 sendResponse
  });

  scanVideo();
})();
