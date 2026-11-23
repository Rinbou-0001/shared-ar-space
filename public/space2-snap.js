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
  // 共通視点 (viewerEye) — 全クライアントで共有される 3D 視点座標
  //   各面に (u, v) として投影し、ドラッグ中の矩形中心をスナップ可能な点として表示
  let viewerEye = { x: 0, y: 1.5, z: 0 };
  const clients = new Map();

  // 検証トグル (master パネルと同一の `effectState` イベントで全クライアント同期)
  const EFFECT_DEFS = [
    { n: 1, label: '効果1' },
    { n: 2, label: '効果2 (スマホ UI)' },
    { n: 3, label: '効果3 (影)' },
    { n: 4, label: '効果4 (魚)' },
    { n: 5, label: '効果5 (テーマ)' },
    { n: 6, label: '効果6' },
    { n: 7, label: '効果7 (窓枠)' },
    { n: 8, label: '効果8' },
    { n: 9, label: '効果9 (窓枠off-axis)' },
    { n: 10, label: '効果10 (環境E)' },
  ];
  const effectStates = {};   // id → { entryTag, display:{width,height}, customTags:[], snapFace, pos:{x,y,z} }
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

    // 共通視点 (viewerEye) を面に投影した点 — スナップターゲット
    {
      const vuv = worldToUV(face, viewerEye);
      // 面の (u, v) 範囲内のときのみ描画 (範囲外なら non-informative)
      if (vuv.u >= face.uRange[0] - 0.01 && vuv.u <= face.uRange[1] + 0.01 &&
          vuv.v >= face.vRange[0] - 0.01 && vuv.v <= face.vRange[1] + 0.01) {
        const vpx = uvToPx(face, vuv.u, vuv.v);
        // 十字マーク + 円
        svg.appendChild(svgEl('line', {
          x1: vpx.x - 8, y1: vpx.y, x2: vpx.x + 8, y2: vpx.y,
          stroke: '#f472b6', 'stroke-width': 1.2, 'pointer-events': 'none',
        }));
        svg.appendChild(svgEl('line', {
          x1: vpx.x, y1: vpx.y - 8, x2: vpx.x, y2: vpx.y + 8,
          stroke: '#f472b6', 'stroke-width': 1.2, 'pointer-events': 'none',
        }));
        svg.appendChild(svgEl('circle', {
          cx: vpx.x, cy: vpx.y, r: 3,
          fill: 'none', stroke: '#f472b6', 'stroke-width': 1.2,
          'pointer-events': 'none',
        }));
        svg.appendChild(svgEl('text', {
          x: vpx.x + 10, y: vpx.y - 6,
          fill: '#f472b6', 'font-size': 10, 'font-family': 'monospace',
          'pointer-events': 'none',
        }, `eye (${viewerEye.x.toFixed(2)},${viewerEye.y.toFixed(2)},${viewerEye.z.toFixed(2)})`));
      }
    }

    // 各クライアントの base 矩形を描画
    //   ・ドラッグ中はその対象のみ dragState.lastU/lastV に差し替え表示 (移動確定前のプレビュー)
    const list = clientsOnActiveFace();
    for (const { id, c } of list) {
      let uv;
      if (dragState && dragState.clientId === id && dragState.face.name === face.name
          && dragState.lastU != null && dragState.lastV != null) {
        uv = { u: dragState.lastU, v: dragState.lastV };
      } else {
        uv = worldToUV(face, c.pos);
      }
      const w = Number(c.display.width) || 0.5;
      const h = Number(c.display.height) || 0.3;
      const centerPx = uvToPx(face, uv.u, uv.v);
      // base 矩形の半幅/半高 (pixel)
      const halfWpx = (w / uSpan) * PLOT_SIZE / 2;
      const halfHpx = (h / vSpan) * PLOT_SIZE / 2;
      const isHover = (id === hoverClientId);
      const strokeCol = isHover ? '#facc15' : '#22d3ee';
      const fillCol   = isHover ? '#facc15' : '#22d3ee';
      const rect = svgEl('rect', {
        x: centerPx.x - halfWpx, y: centerPx.y - halfHpx,
        width: halfWpx * 2, height: halfHpx * 2,
        fill: fillCol,
        'fill-opacity': isHover ? 0.35 : 0.22,
        stroke: strokeCol,
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

  // サイズ入力中は DOM 再構築で focus/途中入力を失わないように skip
  function _isSidebarInputFocused() {
    const ae = document.activeElement;
    if (!ae || !ae.matches) return false;
    return ae.matches('#sidebar input, #sidebar button');
  }
  // ロック用: focus 時に捕捉した aspect ratio を保持 (clientId → w/h)
  const _szAspectLock = {};
  // 編集中 row (clientId) — focus 中 or 直前まで触っていた間は renderSidebar の再構築をスキップ
  const _szEditing = new Set();

  function renderSidebar() {
    if (_isSidebarInputFocused() || _szEditing.size > 0) return;   // 入力中 / 編集中 row がある時は書き換え回避
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
            <div class="ccoords">${w.toFixed(3)}×${h.toFixed(3)}m  u=${uv.u.toFixed(2)} v=${uv.v.toFixed(2)}</div>
            <div class="size-edit">
              <input type="number" class="sz-w" step="0.01" min="0.01" max="10" value="${w.toFixed(3)}" />
              <span class="sz-sep">×</span>
              <input type="number" class="sz-h" step="0.01" min="0.01" max="10" value="${h.toFixed(3)}" />
              <button type="button" class="sz-apply">適用</button>
            </div>
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

  // ===== サイズ編集: アスペクト比ロック + 適用 =====
  //   DOM 再構築問題:
  //     pose broadcast が ~60Hz で届く度に renderSidebar() が走ると、
  //     ユーザー入力中 or クリック直後 (focus 遷移中) に DOM を差し替えてしまい、
  //     ・入力値がサーバー値で上書きされる
  //     ・apply ボタンが click 発火前に消滅 → イベント不発
  //   対策:
  //     ・入力に focus が入ったら _szEditing に row id を追加 → renderSidebar skip
  //     ・apply は click ではなく mousedown + preventDefault で捕捉 (focus 遷移前に実行)
  //     ・apply or 外部 click で _szEditing から削除 → render 再開
  function _setupSizeEditDelegation() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    // focus 時: アスペクト比を捕捉 + 編集中マーク
    sidebar.addEventListener('focusin', (ev) => {
      const el = ev.target;
      if (!el.matches || !el.matches('.sz-w, .sz-h')) return;
      const row = el.closest('.client-row');
      if (!row) return;
      const id = row.getAttribute('data-client-id');
      _szEditing.add(id);
      const wEl = row.querySelector('.sz-w');
      const hEl = row.querySelector('.sz-h');
      const w = parseFloat(wEl && wEl.value);
      const h = parseFloat(hEl && hEl.value);
      if (isFinite(w) && w > 0 && isFinite(h) && h > 0) {
        _szAspectLock[id] = w / h;
      }
    });
    // 入力中: ロック比率で相方を自動更新
    sidebar.addEventListener('input', (ev) => {
      const el = ev.target;
      if (!el.matches || !el.matches('.sz-w, .sz-h')) return;
      const row = el.closest('.client-row');
      if (!row) return;
      const id = row.getAttribute('data-client-id');
      const ratio = _szAspectLock[id];
      if (!ratio) return;
      const wEl = row.querySelector('.sz-w');
      const hEl = row.querySelector('.sz-h');
      const v = parseFloat(el.value);
      if (!isFinite(v) || v <= 0) return;
      if (el === wEl)       { hEl.value = (v / ratio).toFixed(3); }
      else if (el === hEl)  { wEl.value = (v * ratio).toFixed(3); }
    });
    // 適用ボタン: mousedown で捕捉 (focus 遷移前、DOM 書換え前に値を確定・送信)
    sidebar.addEventListener('mousedown', (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest('.sz-apply') : null;
      if (!btn) return;
      ev.preventDefault();   // input から button への focus 遷移を抑止 → input.value が保持される
      const row = btn.closest('.client-row');
      if (!row) return;
      const id = row.getAttribute('data-client-id');
      const wEl = row.querySelector('.sz-w');
      const hEl = row.querySelector('.sz-h');
      const w = parseFloat(wEl && wEl.value);
      const h = parseFloat(hEl && hEl.value);
      if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0 || w > 10 || h > 10) {
        log('サイズ不正 (0 < w,h ≦ 10 m) w=' + wEl.value + ' h=' + hEl.value); return;
      }
      if (socket && socket.connected) {
        socket.emit('forceDisplaySize', { targetId: id, width: w, height: h });
        log('forceDisplaySize emit: ' + (id.slice(0, 6)) + ' → ' + w.toFixed(3) + '×' + h.toFixed(3) + 'm');
      } else {
        log('socket 未接続 - emit 不可');
      }
      // 編集完了 → render 再開
      _szEditing.delete(id);
      delete _szAspectLock[id];
      if (wEl) wEl.blur();
      if (hEl) hEl.blur();
      render();   // 即座に最新化
    });
    // サイドバー外部クリックで編集状態をクリア (操作キャンセル扱い)
    document.addEventListener('mousedown', (ev) => {
      if (sidebar.contains(ev.target)) return;
      if (_szEditing.size > 0) {
        _szEditing.clear();
        Object.keys(_szAspectLock).forEach((k) => delete _szAspectLock[k]);
        render();
      }
    });
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
    dragState = {
      clientId: id, face,
      grabOffset: { du: centerUV.u - uv.u, dv: centerUV.v - uv.v },
      others: otherRectsOnFace(face, id),
      lastU: centerUV.u, lastV: centerUV.v,
    };
    evt.preventDefault();
  }

  // 他ディスプレイの辺にスナップ可能な距離 (メートル)
  const EDGE_SNAP_THRESHOLD_M = 0.05;

  // ドラッグ中の対象を除いた、同じ面にスナップ中の他クライアントの base 矩形 (u,v 空間)
  function otherRectsOnFace(face, excludeId) {
    const result = [];
    for (const [id, c] of clients.entries()) {
      if (id === excludeId) continue;
      if (!isVisibleOnPanel(c)) continue;
      if (c.snapFace !== face.name) continue;
      const uv = worldToUV(face, c.pos);
      const w = Number(c.display.width) || 0.5;
      const h = Number(c.display.height) || 0.3;
      result.push({ id, cu: uv.u, cv: uv.v, w, h });
    }
    return result;
  }

  // ドラッグ中矩形 (center u,v + w,h) を周囲矩形の辺にスナップ
  //   ・自身の辺 (left/right/top/bottom + center) が他矩形の辺に threshold 以内なら吸着
  //   ・u 軸と v 軸は独立に判定
  function applyEdgeSnap(face, dragU, dragV, dragW, dragH, others) {
    const T = EDGE_SNAP_THRESHOLD_M;
    const myHalfW = dragW / 2, myHalfH = dragH / 2;
    // 自身の候補 "辺の u 座標" リスト: [leftEdge, centerU, rightEdge]
    const myU = [dragU - myHalfW, dragU, dragU + myHalfW];
    const myV = [dragV - myHalfH, dragV, dragV + myHalfH];
    let bestDu = 0, bestDuAbs = T + 1;
    let bestDv = 0, bestDvAbs = T + 1;
    for (const o of others) {
      const oU = [o.cu - o.w / 2, o.cu, o.cu + o.w / 2];
      const oV = [o.cv - o.h / 2, o.cv, o.cv + o.h / 2];
      for (const mu of myU) {
        for (const ou of oU) {
          const d = ou - mu;
          if (Math.abs(d) < bestDuAbs) { bestDuAbs = Math.abs(d); bestDu = d; }
        }
      }
      for (const mv of myV) {
        for (const ov of oV) {
          const d = ov - mv;
          if (Math.abs(d) < bestDvAbs) { bestDvAbs = Math.abs(d); bestDv = d; }
        }
      }
    }
    // 共通視点 (viewerEye) を面へ投影した点に矩形中心をスナップ
    {
      const vuv = worldToUV(face, viewerEye);
      if (vuv.u >= face.uRange[0] - 0.01 && vuv.u <= face.uRange[1] + 0.01 &&
          vuv.v >= face.vRange[0] - 0.01 && vuv.v <= face.vRange[1] + 0.01) {
        const du = vuv.u - dragU;
        const dv = vuv.v - dragV;
        if (Math.abs(du) < bestDuAbs) { bestDuAbs = Math.abs(du); bestDu = du; }
        if (Math.abs(dv) < bestDvAbs) { bestDvAbs = Math.abs(dv); bestDv = dv; }
      }
    }
    return {
      u: dragU + (bestDuAbs <= T ? bestDu : 0),
      v: dragV + (bestDvAbs <= T ? bestDv : 0),
    };
  }

  function onSvgMouseMove(evt) {
    if (!dragState) return;
    const { px, py } = svgLocalPx(evt);
    const face = dragState.face;
    const uv0 = pxToUV(face, px, py);
    let targetU = uv0.u + dragState.grabOffset.du;
    let targetV = uv0.v + dragState.grabOffset.dv;
    // 他ディスプレイの辺にスナップ
    const c = clients.get(dragState.clientId);
    const w = c ? (Number(c.display.width)  || 0.5) : 0.5;
    const h = c ? (Number(c.display.height) || 0.3) : 0.3;
    const snapped = applyEdgeSnap(face, targetU, targetV, w, h, dragState.others);
    const clamped = clampUV(face, snapped.u, snapped.v);
    dragState.lastU = clamped.u;
    dragState.lastV = clamped.v;
    // 描画のみ更新 (サーバーへは mouseup 時のみ送信)
    //   クライアント pos は書き換えず、drag 専用のオーバーレイで描画
    render();
  }

  function onSvgMouseUp(evt) {
    if (!dragState) return;
    const face = dragState.face;
    const c = clients.get(dragState.clientId);
    if (c && dragState.lastU != null && dragState.lastV != null) {
      // 最終位置をクライアント pos に反映 + サーバーへ送信 (移動動作完了時のみ)
      c.pos[face.ua] = dragState.lastU;
      c.pos[face.va] = dragState.lastV;
      emitForce(dragState.clientId, face.name, dragState.lastU, dragState.lastV);
    }
    dragState = null;
    render();
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

  // 強制位置 emit — ドラッグ終了 (mouseup) または ジャンプタブ選択時のみ発火
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
      // snap パネルとして識別 (effectState 送信権限を取得)
      socket.emit('identify', { role: 'snap-panel' });
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
    socket.on('viewerEye', (data) => {
      if (!data) return;
      if (typeof data.x === 'number') viewerEye.x = data.x;
      if (typeof data.y === 'number') viewerEye.y = data.y;
      if (typeof data.z === 'number') viewerEye.z = data.z;
      render();
    });
    socket.on('effectState', (data) => {
      if (!data || typeof data.effect !== 'number') return;
      effectStates[data.effect] = !!data.on;
      renderEffectToggles();
    });
  }

  // ===== 検証トグル =====
  //   ・renderEffectToggles で innerHTML を書き換えるとボタン DOM が差し変わるため、
  //     listener は子ボタンではなく親コンテナに 1 度だけ登録する (event delegation)。
  let _effectListenerAttached = false;
  function renderEffectToggles() {
    const list = document.getElementById('effect-list');
    if (!list) return;
    list.innerHTML = EFFECT_DEFS.map((def) => {
      const on = !!effectStates[def.n];
      return `<button type="button" class="effect-btn ${on ? 'on' : 'off'}" data-effect="${def.n}">
        <span class="elab">${def.label}</span>
        <span class="eval">${on ? 'ON' : 'OFF'}</span>
      </button>`;
    }).join('');
    if (!_effectListenerAttached) {
      list.addEventListener('click', (ev) => {
        // 子ボタンまで遡って data-effect を拾う (span クリック対応)
        const btn = ev.target && ev.target.closest ? ev.target.closest('.effect-btn') : null;
        if (!btn) return;
        const n = Number(btn.getAttribute('data-effect'));
        if (!n) return;
        const nextOn = !effectStates[n];
        log('effectState click → 効果' + n + ': ' + (nextOn ? 'ON' : 'OFF'));
        if (socket && socket.connected) {
          // 送信直前に identify を再送 (サーバーが role=snap-panel を認識していない場合の保険)
          socket.emit('identify', { role: 'snap-panel' });
          socket.emit('effectState', { effect: n, on: nextOn });
          // 楽観的更新 (サーバー broadcast 受信で確定上書き)
          effectStates[n] = nextOn;
          renderEffectToggles();
        } else {
          log('socket 未接続 - emit 不可');
        }
      });
      _effectListenerAttached = true;
    }
  }

  // ===== 初期化 =====
  function init() {
    renderFaceTabs();
    setupSvgInteraction();
    _setupSizeEditDelegation();
    render();
    renderEffectToggles();
    initSocket();
  }

  window.__panelInit = init;
})();
