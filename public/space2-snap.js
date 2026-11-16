// space2-snap.js — 壁ボックス snap 操作パネル (独立 2D UI)
//   ・snap タグ ON かつサーバー snapFace != null のクライアントのみ表示
//   ・6 面 (A..F) を切り替えて、その面に配置された各クライアントの base 矩形を表示
//   ・border を左ドラッグ → forceSnapPos emit で位置移動 (全クライアント同期)
//   ・border 右クリック → ジャンプタブ (他面に切替) を表示
//   ・この panel は pose を emit しないため、world 側 avatar として出現しない

(function () {
  'use strict';

  // ===== 面定義 (A..F) =====
  //   face.axis: 法線軸 ('x'|'y'|'z')
  //   face.sign: 法線向き (+1|-1)
  //   face.ua / face.va: 接線 2 軸 (パネル u = 右方向, v = 上方向 (SVG 反転前の論理軸))
  //   face.uRange / face.vRange: 世界座標範囲
  const FACES = [
    { label: 'A', name: '+X', axis: 'x', sign: +1, ua: 'z', va: 'y', uRange: [-1.5, 1.5], vRange: [0, 3] },
    { label: 'B', name: '-X', axis: 'x', sign: -1, ua: 'z', va: 'y', uRange: [-1.5, 1.5], vRange: [0, 3] },
    { label: 'C', name: '+Y', axis: 'y', sign: +1, ua: 'x', va: 'z', uRange: [-1.5, 1.5], vRange: [-1.5, 1.5] },
    { label: 'D', name: '-Y', axis: 'y', sign: -1, ua: 'x', va: 'z', uRange: [-1.5, 1.5], vRange: [-1.5, 1.5] },
    { label: 'E', name: '+Z', axis: 'z', sign: +1, ua: 'x', va: 'y', uRange: [-1.5, 1.5], vRange: [0, 3] },
    { label: 'F', name: '-Z', axis: 'z', sign: -1, ua: 'x', va: 'y', uRange: [-1.5, 1.5], vRange: [0, 3] },
  ];
  const faceByName = (name) => FACES.find((f) => f.name === name);
  const faceByLabel = (label) => FACES.find((f) => f.label === label);

  // 表示設定
  const CANVAS_SIZE = 500;
  const MARGIN = 40;
  const PLOT_SIZE = CANVAS_SIZE - MARGIN * 2;   // 面の 3m 範囲を描画するピクセル数 (正方面)
  // 非正方面 (+X/-X/+Z/-Z は u=3m, v=3m なので正方形、+Y/-Y も 3m×3m 正方なので全面正方)

  let socket = null;
  let selfId = null;
  const clients = new Map();   // id → { entryTag, display:{width,height}, customTags:[], snapFace, pos:{x,y,z} }
  let activeFaceLabel = 'A';
  let hoverClientId = null;

  function log(msg) {
    const el = document.getElementById('log');
    if (el) el.textContent = String(msg);
    console.log('[snap-panel]', msg);
  }

  function setStatus(txt, color) {
    const el = document.getElementById('status');
    if (!el) return;
    el.textContent = txt;
    el.style.color = color || '';
  }

  // ===== クライアント状態管理 =====
  function ensureClient(id) {
    let c = clients.get(id);
    if (!c) {
      c = { entryTag: null, display: { width: 0.5, height: 0.3 }, customTags: [], snapFace: null,
            pos: { x: 0, y: 0, z: 0 }, color: '#22d3ee' };
      clients.set(id, c);
    }
    return c;
  }

  function hasSnapTag(c) {
    return c && Array.isArray(c.customTags) && c.customTags.indexOf('snap') >= 0;
  }

  // 「表示対象」= snap タグ ON かつ snapFace != null
  function isVisibleOnPanel(c) {
    return hasSnapTag(c) && c.snapFace;
  }

  // 現在選択面にスナップ中のクライアント一覧
  function clientsOnActiveFace() {
    const face = faceByLabel(activeFaceLabel);
    if (!face) return [];
    const result = [];
    for (const [id, c] of clients.entries()) {
      if (!isVisibleOnPanel(c)) continue;
      if (c.snapFace !== face.name) continue;
      result.push({ id, c });
    }
    return result;
  }

  // ===== 座標変換 =====
  // 世界座標 (x,y,z) → (u, v) in meters, according to face
  function worldToUV(face, pos) {
    return { u: pos[face.ua], v: pos[face.va] };
  }

  // u,v (meters) → SVG pixel (x, y)。SVG y は上向き反転
  function uvToPx(face, u, v) {
    const uRange = face.uRange, vRange = face.vRange;
    const uN = (u - uRange[0]) / (uRange[1] - uRange[0]);   // 0..1
    const vN = (v - vRange[0]) / (vRange[1] - vRange[0]);   // 0..1
    const px = MARGIN + uN * PLOT_SIZE;
    const py = MARGIN + (1 - vN) * PLOT_SIZE;               // SVG 上下反転
    return { x: px, y: py };
  }

  // SVG pixel → u,v (meters)
  function pxToUV(face, px, py) {
    const uRange = face.uRange, vRange = face.vRange;
    const uN = (px - MARGIN) / PLOT_SIZE;
    const vN = 1 - (py - MARGIN) / PLOT_SIZE;
    const u = uRange[0] + uN * (uRange[1] - uRange[0]);
    const v = vRange[0] + vN * (vRange[1] - vRange[0]);
    return { u, v };
  }

  // u,v の clamp (face range 内)
  function clampUV(face, u, v) {
    return {
      u: Math.max(face.uRange[0], Math.min(face.uRange[1], u)),
      v: Math.max(face.vRange[0], Math.min(face.vRange[1], v)),
    };
  }

  // ===== 描画 =====
  function render() {
    const svg = document.getElementById('svg');
    if (!svg) return;
    const face = faceByLabel(activeFaceLabel);
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    // 壁面背景
    const bg = svgEl('rect', {
      x: MARGIN, y: MARGIN, width: PLOT_SIZE, height: PLOT_SIZE,
      fill: '#334155', stroke: '#64748b', 'stroke-width': 1,
    });
    svg.appendChild(bg);

    // グリッド (0.5m 刻み)
    const uSpan = face.uRange[1] - face.uRange[0];
    const vSpan = face.vRange[1] - face.vRange[0];
    for (let g = 0.5; g < uSpan; g += 0.5) {
      const x = MARGIN + (g / uSpan) * PLOT_SIZE;
      svg.appendChild(svgEl('line', {
        x1: x, y1: MARGIN, x2: x, y2: MARGIN + PLOT_SIZE,
        stroke: '#475569', 'stroke-width': 0.5,
      }));
    }
    for (let g = 0.5; g < vSpan; g += 0.5) {
      const y = MARGIN + (g / vSpan) * PLOT_SIZE;
      svg.appendChild(svgEl('line', {
        x1: MARGIN, y1: y, x2: MARGIN + PLOT_SIZE, y2: y,
        stroke: '#475569', 'stroke-width': 0.5,
      }));
    }

    // 軸ラベル
    svg.appendChild(svgEl('text', {
      x: MARGIN + PLOT_SIZE / 2, y: MARGIN - 8,
      fill: '#94a3b8', 'font-size': 10, 'text-anchor': 'middle', 'font-family': 'monospace',
    }, `← ${face.ua} →  (${face.uRange[0]}m .. ${face.uRange[1]}m)`));
    svg.appendChild(svgEl('text', {
      x: MARGIN - 8, y: MARGIN + PLOT_SIZE / 2,
      fill: '#94a3b8', 'font-size': 10, 'text-anchor': 'middle', 'font-family': 'monospace',
      transform: `rotate(-90 ${MARGIN - 8} ${MARGIN + PLOT_SIZE / 2})`,
    }, `↑ ${face.va} ↓  (${face.vRange[0]}m .. ${face.vRange[1]}m)`));

    // 面ラベル
    svg.appendChild(svgEl('text', {
      x: MARGIN + PLOT_SIZE - 6, y: MARGIN + 14,
      fill: '#e2e8f0', 'font-size': 13, 'text-anchor': 'end', 'font-weight': 700,
    }, `${face.label}  (${face.name})`));

    // 各クライアントの base 矩形を描画
    const list = clientsOnActiveFace();
    for (const { id, c } of list) {
      const uv = worldToUV(face, c.pos);
      const w = Number(c.display.width) || 0.5;
      const h = Number(c.display.height) || 0.3;
      const centerPx = uvToPx(face, uv.u, uv.v);
      // base 矩形の半幅/半高 (pixel)
      const halfWpx = (w / uSpan) * PLOT_SIZE / 2;
      const halfHpx = (h / vSpan) * PLOT_SIZE / 2;
      const rect = svgEl('rect', {
        x: centerPx.x - halfWpx, y: centerPx.y - halfHpx,
        width: halfWpx * 2, height: halfHpx * 2,
        fill: 'none',
        stroke: (id === hoverClientId) ? '#facc15' : '#22d3ee',
        'stroke-width': 2,
        'data-client-id': id,
        'data-role': 'base-rect',
        style: 'cursor: move;',
      });
      svg.appendChild(rect);
      // 中心点
      svg.appendChild(svgEl('circle', {
        cx: centerPx.x, cy: centerPx.y, r: 3,
        fill: (id === hoverClientId) ? '#facc15' : '#22d3ee',
        'pointer-events': 'none',
      }));
      // ラベル (entryTag)
      const label = c.entryTag || id.slice(0, 4);
      svg.appendChild(svgEl('text', {
        x: centerPx.x + halfWpx + 4, y: centerPx.y + 4,
        fill: (id === hoverClientId) ? '#facc15' : '#e2e8f0',
        'font-size': 11, 'font-weight': 600, 'pointer-events': 'none',
      }, label + '  ' + w.toFixed(2) + '×' + h.toFixed(2) + 'm'));
    }

    // 画面情報
    const faceInfo = document.getElementById('face-info');
    if (faceInfo) faceInfo.textContent = `面 ${face.label} (${face.name}): ${list.length} クライアント`;

    renderSidebar();
  }

  function svgEl(tag, attrs, text) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (text != null) el.textContent = text;
    return el;
  }

  function renderSidebar() {
    const sel = document.getElementById('client-list');
    const all = document.getElementById('all-snap-list');
    if (sel) {
      const list = clientsOnActiveFace();
      sel.innerHTML = list.length === 0
        ? '<div style="color:#94a3b8;font-size:11px;">(なし)</div>'
        : list.map(({ id, c }) => {
          const w = Number(c.display.width) || 0.5;
          const h = Number(c.display.height) || 0.3;
          const face = faceByLabel(activeFaceLabel);
          const uv = worldToUV(face, c.pos);
          return `<div class="client-row${id === hoverClientId ? ' sel' : ''}" data-client-id="${id}">
            <div><span class="ctag">${c.entryTag || id.slice(0, 6)}</span></div>
            <div class="ccoords">${w.toFixed(2)}×${h.toFixed(2)}m  u=${uv.u.toFixed(2)} v=${uv.v.toFixed(2)}</div>
          </div>`;
        }).join('');
    }
    if (all) {
      const rows = [];
      for (const [id, c] of clients.entries()) {
        if (!isVisibleOnPanel(c)) continue;
        rows.push(`<div class="client-row" data-client-id="${id}">
          <div><span class="ctag">${c.entryTag || id.slice(0, 6)}</span>  面 ${c.snapFace}</div>
        </div>`);
      }
      all.innerHTML = rows.length === 0 ? '<div style="color:#94a3b8;font-size:11px;">(なし)</div>' : rows.join('');
    }
  }

  // ===== 面タブ =====
  function renderFaceTabs() {
    const tabs = document.getElementById('face-tabs');
    tabs.innerHTML = '';
    for (const f of FACES) {
      const btn = document.createElement('button');
      btn.className = 'face-tab' + (f.label === activeFaceLabel ? ' active' : '');
      btn.textContent = f.label;
      btn.title = f.name;
      btn.addEventListener('click', () => {
        activeFaceLabel = f.label;
        hoverClientId = null;
        renderFaceTabs();
        render();
      });
      tabs.appendChild(btn);
    }
  }

  // ===== ドラッグ移動 =====
  let dragState = null;   // { clientId, face, startPx, startUV }
  function setupSvgInteraction() {
    const svg = document.getElementById('svg');
    svg.addEventListener('mousedown', onSvgMouseDown);
    window.addEventListener('mousemove', onSvgMouseMove);
    window.addEventListener('mouseup', onSvgMouseUp);
    svg.addEventListener('contextmenu', onSvgRightClick);
    svg.addEventListener('mousemove', onSvgHover);
  }

  function svgLocalPx(evt) {
    const svg = document.getElementById('svg');
    const rect = svg.getBoundingClientRect();
    // SVG viewBox は固定なので、clientX/Y を viewBox 空間にスケール
    const scale = CANVAS_SIZE / rect.width;
    return { px: (evt.clientX - rect.left) * scale, py: (evt.clientY - rect.top) * scale };
  }

  function clientIdFromTarget(target) {
    if (!target) return null;
    if (target.getAttribute && target.getAttribute('data-client-id')) return target.getAttribute('data-client-id');
    return null;
  }

  function onSvgMouseDown(evt) {
    if (evt.button !== 0) return;   // 左クリックのみ
    const id = clientIdFromTarget(evt.target);
    if (!id) return;
    const face = faceByLabel(activeFaceLabel);
    const c = clients.get(id);
    if (!face || !c) return;
    const { px, py } = svgLocalPx(evt);
    const uv = pxToUV(face, px, py);
    const centerUV = worldToUV(face, c.pos);
    dragState = { clientId: id, face, grabOffset: { du: centerUV.u - uv.u, dv: centerUV.v - uv.v } };
    evt.preventDefault();
  }

  function onSvgMouseMove(evt) {
    if (!dragState) return;
    const { px, py } = svgLocalPx(evt);
    const face = dragState.face;
    const uv0 = pxToUV(face, px, py);
    const target = clampUV(face, uv0.u + dragState.grabOffset.du, uv0.v + dragState.grabOffset.dv);
    // 対象クライアントの pos を楽観的更新 (サーバーからの broadcast で確定)
    const c = clients.get(dragState.clientId);
    if (c) {
      c.pos[face.ua] = target.u;
      c.pos[face.va] = target.v;
      render();
    }
    // サーバーへ強制位置送信 (throttle 50ms)
    throttledEmitForce(dragState.clientId, face.name, target.u, target.v);
  }

  function onSvgMouseUp(evt) {
    if (!dragState) return;
    // 最終位置を確実に送る
    const c = clients.get(dragState.clientId);
    if (c) {
      const face = dragState.face;
      const uv = worldToUV(face, c.pos);
      emitForce(dragState.clientId, face.name, uv.u, uv.v);
    }
    dragState = null;
  }

  function onSvgHover(evt) {
    if (dragState) return;
    const id = clientIdFromTarget(evt.target);
    if (id !== hoverClientId) {
      hoverClientId = id;
      render();
    }
  }

  function onSvgRightClick(evt) {
    const id = clientIdFromTarget(evt.target);
    if (!id) return;
    evt.preventDefault();
    showJumpMenu(evt.clientX, evt.clientY, id);
  }

  // 強制位置 emit (50ms throttle)
  let _emitLast = 0;
  let _emitPending = null;
  function throttledEmitForce(clientId, face, u, v) {
    const now = performance.now();
    if (now - _emitLast < 50) {
      _emitPending = { clientId, face, u, v };
      return;
    }
    _emitLast = now;
    _emitPending = null;
    emitForce(clientId, face, u, v);
  }
  setInterval(() => {
    if (_emitPending && performance.now() - _emitLast >= 50) {
      const p = _emitPending; _emitPending = null; _emitLast = performance.now();
      emitForce(p.clientId, p.face, p.u, p.v);
    }
  }, 50);

  function emitForce(clientId, face, u, v) {
    if (!socket || !socket.connected) return;
    socket.emit('forceSnapPos', { targetId: clientId, face, u, v });
  }

  // ===== ジャンプタブ =====
  function showJumpMenu(clientX, clientY, targetId) {
    const menu = document.getElementById('jump-menu');
    menu.style.left = clientX + 'px';
    menu.style.top = clientY + 'px';
    menu.style.display = 'block';
    // 既存のアイテムを削除 (header を残す)
    while (menu.children.length > 1) menu.removeChild(menu.lastChild);
    for (const f of FACES) {
      const item = document.createElement('div');
      item.className = 'jm-item';
      item.textContent = `${f.label}  (${f.name})`;
      item.addEventListener('click', () => {
        hideJumpMenu();
        // 選択面の中心へジャンプ (u=0, v=中心)
        const uCenter = (f.uRange[0] + f.uRange[1]) / 2;
        const vCenter = (f.vRange[0] + f.vRange[1]) / 2;
        emitForce(targetId, f.name, uCenter, vCenter);
      });
      menu.appendChild(item);
    }
  }
  function hideJumpMenu() {
    const menu = document.getElementById('jump-menu');
    menu.style.display = 'none';
  }
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('jump-menu');
    if (menu.style.display === 'block' && !menu.contains(e.target)) hideJumpMenu();
  });

  // ===== socket 接続 =====
  function initSocket() {
    const cfg = window.APP_CONFIG || {};
    const base = cfg.socketUrl || undefined;
    socket = base ? io(base) : io();

    socket.on('connect', () => {
      setStatus('接続済 (' + socket.id.slice(0, 6) + ')', '#4ade80');
    });
    socket.on('disconnect', () => {
      setStatus('切断', '#f87171');
    });
    socket.on('init', (data) => {
      selfId = data.id;
      const users = data.users || {};
      for (const id in users) {
        const u = users[id];
        const c = ensureClient(id);
        c.entryTag = u.entryTag || null;
        if (u.display) {
          c.display.width = u.display.width;
          c.display.height = u.display.height;
        }
        c.customTags = Array.isArray(u.customTags) ? u.customTags.slice() : [];
        c.snapFace = u.snapFace || null;
        c.pos = { x: u.x || 0, y: u.y || 0, z: u.z || 0 };
        c.color = u.color || '#22d3ee';
      }
      render();
    });
    socket.on('join', (u) => {
      if (!u || !u.id) return;
      const c = ensureClient(u.id);
      c.entryTag = u.entryTag || null;
      if (u.display) {
        c.display.width = u.display.width;
        c.display.height = u.display.height;
      }
      c.customTags = Array.isArray(u.customTags) ? u.customTags.slice() : [];
      c.snapFace = u.snapFace || null;
      c.pos = { x: u.x || 0, y: u.y || 0, z: u.z || 0 };
      c.color = u.color || '#22d3ee';
      render();
    });
    socket.on('leave', (data) => {
      if (!data || !data.id) return;
      clients.delete(data.id);
      render();
    });
    socket.on('pose', (p) => {
      if (!p || !p.id) return;
      const c = ensureClient(p.id);
      c.pos.x = p.x; c.pos.y = p.y; c.pos.z = p.z;
      if (p.entryTag) c.entryTag = p.entryTag;
      render();
    });
    socket.on('displayConfig', (data) => {
      if (!data || !data.id || !data.display) return;
      const c = ensureClient(data.id);
      c.display.width = data.display.width;
      c.display.height = data.display.height;
      render();
    });
    socket.on('avatarTag', (data) => {
      if (!data || !data.id) return;
      const c = ensureClient(data.id);
      c.customTags = Array.isArray(data.tags) ? data.tags.slice() : [];
      render();
    });
    socket.on('snapFace', (data) => {
      if (!data || !data.id) return;
      const c = ensureClient(data.id);
      c.snapFace = data.face || null;
      render();
    });
  }

  // ===== 初期化 =====
  function init() {
    renderFaceTabs();
    setupSvgInteraction();
    render();
    initSocket();
  }

  window.__panelInit = init;
})();
