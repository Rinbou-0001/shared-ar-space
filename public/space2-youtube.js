// space2-youtube.js — /space2/youtube スマホ専用ページ用クライアント
//   ・youtube-ui-study を iframe で表示
//   ・iframe 内の touch / click / scroll / DOM 変化を捕捉 → Energy/Tension/Flow 算出
//   ・1Hz で envParams emit (他クライアントの効果10 系統に取込まれる)
//   ・特定の UI 要素クリック (video-card / brand / chip / side-item / search submit) で
//     siteAction emit → 他クライアントの space2.js がリアクション
//   ・pose は emit しない (world に avatar として出現しない、純粋な入力デバイス扱い)

(function () {
  'use strict';

  let socket = null;
  let myId = null;
  const iframe = document.getElementById('site-frame');

  // Energy 計算用 state (space2.js Phase 1 とほぼ同一構造)
  const _env = {
    mouse: { x: 0, y: 0, lastX: 0, lastY: 0, prevSpeed: 0 },
    scroll: { wheelAccum: 0 },
    touchCount: 0, clickCount: 0, mutationCount: 0,
    smooth: { V: 0, A: 0, C: 0, S: 0, F: 0 },
    alpha: { V: 0.3, A: 0.3, C: 0.2, S: 0.3, F: 0.15 },
    velHist: [],   // [{t, v}]
    params: { energy: 0, tension: 0, flow: 0 },
    mutObs: null,
    attached: false, attachedWin: null, attachedDoc: null,   // doc も記憶 (navigation 検知)
  };

  function log(msg) {
    const el = document.getElementById('log');
    if (el) {
      const d = document.createElement('div');
      d.textContent = msg;
      el.appendChild(d);
      while (el.children.length > 6) el.removeChild(el.firstChild);
    }
    console.log('[yt]', msg);
  }
  function setStatus(txt) {
    const el = document.getElementById('status');
    if (el) el.textContent = txt;
  }
  function ema(prev, cur, a) { return prev + a * (cur - prev); }

  // ==== iframe イベント捕捉 ====
  function attachToIframe() {
    try {
      const win = iframe.contentWindow;
      const doc = iframe.contentDocument;
      if (!win || !doc) {
        log('iframe not ready, retry 200ms');
        setTimeout(attachToIframe, 200);
        return;
      }
      // doc が null か about:blank 相当の空 body ならスキップ (youtube-ui-study 読込完了を待つ)
      if (!doc.body || doc.body.children.length === 0) {
        log('doc.body empty (likely about:blank), retry 200ms');
        setTimeout(attachToIframe, 200);
        return;
      }
      // doc ベースの短絡 (contentWindow は navigation で再利用されるが doc は差替わる)
      if (_env.attached && _env.attachedDoc === doc) {
        log('already attached to this doc, skip');
        return;
      }
      detachFromIframe();
      // Energy 用イベント (touch 優先、mouse / click も fallback)
      win.addEventListener('touchstart', _onTouch, { passive: true });
      win.addEventListener('touchmove',  _onTouchMove, { passive: true });
      win.addEventListener('mousemove',  _onMouseMove, { passive: true });
      win.addEventListener('click',      _onClick,     { passive: true });
      win.addEventListener('scroll',     _onScroll,    { passive: true, capture: true });
      win.addEventListener('wheel',      _onWheel,     { passive: true });
      _env.attached = true;
      _env.attachedWin = win;
      _env.attachedDoc = doc;
      log('iframe listeners attached (touch/mouse/click/scroll)');
      // MutationObserver (body or documentElement fallback)
      const target = doc.body || doc.documentElement;
      if (target) {
        if (!_env.mutObs) {
          _env.mutObs = new MutationObserver((muts) => { _env.mutationCount += muts.length; });
        } else {
          _env.mutObs.disconnect();
        }
        _env.mutObs.observe(target, { subtree: true, childList: true, attributes: true, characterData: true });
        log('MutationObserver attached (' + (target === doc.body ? 'body' : 'documentElement') + ')');
      } else {
        log('MutationObserver skip: no body/documentElement');
      }
      // 特定インタラクション用 delegation (body に 1 つ、navigate で新 body になっても attach する時に再登録)
      attachSpecificListeners(doc);
    } catch (err) {
      log('attach err: ' + err.message);
    }
  }
  function detachFromIframe() {
    const win = _env.attachedWin;
    if (!win) return;
    try {
      win.removeEventListener('touchstart', _onTouch);
      win.removeEventListener('touchmove',  _onTouchMove);
      win.removeEventListener('mousemove',  _onMouseMove);
      win.removeEventListener('click',      _onClick);
      win.removeEventListener('scroll',     _onScroll, { capture: true });
      win.removeEventListener('wheel',      _onWheel);
    } catch (_) {}
    if (_env.mutObs) { try { _env.mutObs.disconnect(); } catch(_) {} }
    _env.attached = false;
    _env.attachedWin = null;
    _env.attachedDoc = null;
  }

  function _onTouch(e) {
    _env.touchCount++;
    const t = e.touches && e.touches[0];
    if (t) { _env.mouse.x = t.clientX; _env.mouse.y = t.clientY; }
  }
  function _onTouchMove(e) {
    const t = e.touches && e.touches[0];
    if (t) { _env.mouse.x = t.clientX; _env.mouse.y = t.clientY; }
  }
  function _onMouseMove(e) { _env.mouse.x = e.clientX; _env.mouse.y = e.clientY; }
  function _onClick() { _env.clickCount++; }
  function _onScroll() { _env.scroll.wheelAccum += 50; }
  function _onWheel(e) { _env.scroll.wheelAccum += Math.abs(e.deltaY || 0) + Math.abs(e.deltaX || 0); }

  // ==== 特定インタラクション (siteAction emit) ====
  function attachSpecificListeners(doc) {
    // 既存 body に delegation (navigate のたびに doc.body が新しくなる場合は再 attach 必要だが、
    //   iframe.load で attachToIframe が再度呼ばれるためそこで処理)
    doc.body.addEventListener('click', (e) => {
      // 動画カード
      const card = e.target.closest && e.target.closest('.video-card');
      if (card) {
        const idx = card.getAttribute('data-index');
        const title = (card.querySelector('h3') || {}).textContent || '';
        emitSiteAction({
          action: 'video-select',
          videoId: Number(idx),
          title: title.slice(0, 80),
        });
        log('video-select #' + idx + ' "' + title.slice(0, 20) + '"');
        return;
      }
      // ロゴ
      const brand = e.target.closest && e.target.closest('.brand');
      if (brand) {
        emitSiteAction({ action: 'logo-tap' });
        log('logo-tap');
        return;
      }
      // カテゴリチップ
      const chip = e.target.closest && e.target.closest('.chip');
      if (chip) {
        const cat = chip.getAttribute('data-category') || chip.textContent.trim();
        emitSiteAction({ action: 'category', category: cat.slice(0, 48) });
        log('category: ' + cat);
        return;
      }
      // サイドバー項目
      const side = e.target.closest && e.target.closest('.side-item');
      if (side) {
        const t = (side.textContent || '').trim();
        emitSiteAction({ action: 'nav', target: t.slice(0, 48) });
        log('nav: ' + t);
        return;
      }
      // 推薦動画 (watch.html)
      const rec = e.target.closest && e.target.closest('.recommendation');
      if (rec) {
        const idx = rec.getAttribute('data-index');
        emitSiteAction({ action: 'recommendation-select', videoId: Number(idx) });
        log('rec-select #' + idx);
        return;
      }
    }, true);
    // 検索フォーム submit
    const searchForm = doc.querySelector('#searchForm');
    if (searchForm) {
      searchForm.addEventListener('submit', () => {
        const input = doc.querySelector('#searchInput');
        const q = input && input.value ? input.value.trim() : '';
        if (q) {
          emitSiteAction({ action: 'search', query: q.slice(0, 60) });
          log('search: ' + q);
        }
      });
    }
    log('specific listeners attached (video-card/brand/chip/side-item/rec/search)');
  }

  function emitSiteAction(data) {
    if (!socket || !socket.connected) return;
    try {
      data.site = 'youtube';
      data.t = Date.now();
      socket.emit('siteAction', data);
    } catch (err) { log('siteAction emit err: ' + err.message); }
  }

  // ==== Energy / Tension / Flow 計算 (30Hz) + emit (1Hz) ====
  let lastTickT = performance.now();
  let lastEmitT = 0;
  function tick() {
    try {
      const now = performance.now();
      const dt = Math.max(0.001, Math.min(0.1, (now - lastTickT) / 1000));
      lastTickT = now;
      // マウス速度・加速度
      const dx = _env.mouse.x - _env.mouse.lastX;
      const dy = _env.mouse.y - _env.mouse.lastY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const rawV = dist / dt;
      const normV = Math.min(1, rawV / 3000);
      const normA = Math.min(1, Math.abs(normV - _env.mouse.prevSpeed) / dt / 10);
      _env.mouse.lastX = _env.mouse.x;
      _env.mouse.lastY = _env.mouse.y;
      _env.mouse.prevSpeed = normV;
      // 離散イベント頻度
      const normC = Math.min(1, (_env.clickCount + _env.touchCount * 0.5) / 5);
      const normS = Math.min(1, _env.scroll.wheelAccum / 500);
      const normR = Math.min(1, _env.mutationCount / 20);
      _env.clickCount = 0; _env.touchCount = 0;
      _env.scroll.wheelAccum = 0; _env.mutationCount = 0;
      // EMA
      _env.smooth.V = ema(_env.smooth.V, normV, _env.alpha.V);
      _env.smooth.A = ema(_env.smooth.A, normA, _env.alpha.A);
      _env.smooth.C = ema(_env.smooth.C, normC, _env.alpha.C);
      _env.smooth.S = ema(_env.smooth.S, Math.min(1, normS + normR * 0.3), _env.alpha.S);
      // velocity history
      _env.velHist.push({ t: now, v: normV });
      while (_env.velHist.length && now - _env.velHist[0].t > 2000) _env.velHist.shift();
      if (_env.velHist.length > 200) _env.velHist.length = 200;
      // Energy / Tension / Flow
      const e = Math.min(1, 0.3 * _env.smooth.V + 0.25 * _env.smooth.A +
                           0.25 * _env.smooth.C + 0.2 * _env.smooth.S);
      const t = Math.min(1, 0.6 * _env.smooth.A + 0.4 * Math.abs(_env.smooth.C - _env.smooth.S));
      let flowRaw = 0;
      if (_env.velHist.length >= 3) {
        let sum = 0; for (const h of _env.velHist) sum += h.v;
        const mean = sum / _env.velHist.length;
        if (mean > 0.05) {
          let sq = 0; for (const h of _env.velHist) sq += (h.v - mean) * (h.v - mean);
          const std = Math.sqrt(sq / _env.velHist.length);
          flowRaw = Math.max(0, 1 - std / 0.3);
        }
      }
      _env.smooth.F = ema(_env.smooth.F, flowRaw, _env.alpha.F);
      _env.params.energy = e;
      _env.params.tension = t;
      _env.params.flow = Math.min(1, _env.smooth.F);
    } catch (err) { log('tick err: ' + err.message); }
  }
  function emitEnvParams() {
    const now = performance.now();
    if (now - lastEmitT < 1000) return;
    lastEmitT = now;
    if (!socket || !socket.connected) return;
    try {
      socket.emit('envParams', {
        e: _env.params.energy,
        t: _env.params.tension,
        f: _env.params.flow,
      });
    } catch (err) { log('envParams emit err: ' + err.message); }
  }

  // ==== main loop ====
  function mainLoop() {
    tick();
    emitEnvParams();
    requestAnimationFrame(mainLoop);
  }

  // ==== socket 初期化 ====
  function initSocket() {
    try {
      const cfg = window.APP_CONFIG || {};
      socket = cfg.socketUrl ? io(cfg.socketUrl) : io();
      socket.on('connect', () => {
        myId = socket.id;
        setStatus('接続済 #' + socket.id.slice(0, 6));
        log('socket connected: ' + socket.id);
      });
      socket.on('disconnect', () => {
        setStatus('切断');
        log('socket disconnected');
      });
    } catch (err) {
      setStatus('socket err');
      log('socket init err: ' + err.message);
    }
  }

  // ==== 初期化 ====
  function init() {
    initSocket();
    // iframe load 毎に attach (navigate 跨ぎ対応)
    iframe.addEventListener('load', () => {
      log('iframe load → attach check');
      setTimeout(attachToIframe, 100);
    });
    // 初回 (既にロード済の場合に備え)
    setTimeout(attachToIframe, 300);
    mainLoop();
    log('init done (Energy loop running)');
  }

  window.__spaceYtInit = init;
})();
