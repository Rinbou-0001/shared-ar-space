// public/space2.js
// 実験用の新しい共有空間 (URL: /space2, master: /space2/master)
//
// 継承した機能:
//   - observer / master ロール検出 (URL ハッシュ/クエリ/パス、UA デフォルト)
//   - observer パネル (座標入力・移動・俯瞰・真上・Off-Axis)
//   - master パネル (クライアント選択・強制ポーズ・Off-Axis・viewerEye)
//   - パネル表示条件:
//       observer role  → observer-panel のみ
//       master   role  → observer-panel + master-panel
//   - pose / displayConfig / viewerEye / controlPose の socket.io 同期
//
// 空間:
//   - 原点 (0,0,0) を中心に 20m × 20m の床 (Y=0 平面)
//   - 1m 間隔グリッド (見た目補助)
//   - 環境光 + 方向光

(function main() {
  const log = (msg, cls) => window.uiLog && window.uiLog(msg, cls);

  // ========== THREE ロード待ち ==========
  function waitForThree(cb, n = 100) {
    if (typeof THREE !== 'undefined') return cb();
    if (n <= 0) { log('THREE ロードタイムアウト', 'err'); return; }
    setTimeout(() => waitForThree(cb, n - 1), 50);
  }
  waitForThree(start);

  function start() {
    log('THREE r' + THREE.REVISION + ' loaded', 'ok');

    // ========== ロール判定 ==========
    //   優先順:
    //     1) URL ハッシュ #master
    //     2) URL クエリ ?role=master / observer / camera
    //     3) URL パス末尾 /master  (firebase rewrite /space2/master → /space2.html)
    //     4) UA で observer / camera デフォルト
    const params = new URLSearchParams(location.search);
    const fromHash = (location.hash || '').replace(/^#/, '').toLowerCase();
    const fromPath = location.pathname.replace(/\/+$/, '').endsWith('/master') ? 'master' : null;
    const forced =
      ['master', 'observer', 'camera'].indexOf(fromHash) >= 0 ? fromHash :
      (params.get('role') || fromPath);
    const isMobile = /Mobile|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const ROLE = forced === 'observer' ? 'observer'
              : forced === 'camera'   ? 'camera'
              : forced === 'master'   ? 'master'
              : (isMobile ? 'camera' : 'observer');
    log('role: ' + ROLE + ' (forced=' + forced + ', path=' + location.pathname + ')', 'ok');

    document.body.classList.toggle('is-camera',   ROLE === 'camera');
    document.body.classList.toggle('is-observer', ROLE === 'observer');
    document.body.classList.toggle('is-master',   ROLE === 'master');

    {
      const badge = document.getElementById('role-badge');
      if (badge) { badge.textContent = ROLE.toUpperCase(); badge.className = ROLE; }
    }

    // ========== Three.js セットアップ ==========
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1c1c28);

    const camera = new THREE.PerspectiveCamera(
      72,
      window.innerWidth / window.innerHeight,
      0.05, 500
    );
    camera.position.set(0, 1.7, 5);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.getElementById('stage').appendChild(renderer.domElement);

    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });

    // ライト
    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const dirLight = new THREE.DirectionalLight(0xd0d8e8, 0.6);
    dirLight.position.set(10, 20, 10);
    scene.add(dirLight);

    // ========== 床: 20m × 20m at origin ==========
    const FIELD_SIZE = 20;
    const FIELD_HALF = FIELD_SIZE / 2;

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(FIELD_SIZE, FIELD_SIZE),
      new THREE.MeshStandardMaterial({
        color: 0x55555c,
        roughness: 0.9,
        metalness: 0.0,
        side: THREE.DoubleSide,
      })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, 0);
    floor.name = 'floor';
    scene.add(floor);

    // 1m グリッド
    const grid = new THREE.GridHelper(FIELD_SIZE, FIELD_SIZE, 0x9a9aa0, 0x7a7a80);
    grid.position.set(0, 0.01, 0);
    scene.add(grid);
    // 5m 主格子
    const majorGrid = new THREE.GridHelper(FIELD_SIZE, FIELD_SIZE / 5, 0xb0b0b6, 0xb0b0b6);
    majorGrid.position.set(0, 0.015, 0);
    scene.add(majorGrid);
    // 20m 境界
    const boundary = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(FIELD_SIZE, 0.02, FIELD_SIZE)),
      new THREE.LineBasicMaterial({ color: 0xc0c0c6 })
    );
    boundary.position.set(0, 0.012, 0);
    scene.add(boundary);

    // 中心マーカー (原点確認用)
    const centerMarker = new THREE.Mesh(
      new THREE.BoxGeometry(0.15, 0.07, 0.15),
      new THREE.MeshBasicMaterial({ color: 0xc0c0c6 })
    );
    centerMarker.position.set(0, 0.035, 0);
    scene.add(centerMarker);

    // ========== 他クライアントのアバター管理 ==========
    // avatars: id → { grp, mesh, color, role }
    const avatars = new Map();
    function makeAvatar(id, color, role) {
      const grp = new THREE.Group();
      grp.userData.__avatarId = id;
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.15, 24, 16),
        new THREE.MeshStandardMaterial({ color: color || '#ffffff', roughness: 0.6 })
      );
      grp.add(mesh);
      scene.add(grp);
      return { grp, mesh, color: color || '#ffffff', role: role || 'camera' };
    }
    function ensureAvatar(id, color, role) {
      let a = avatars.get(id);
      if (!a) {
        a = makeAvatar(id, color, role);
        avatars.set(id, a);
      }
      return a;
    }

    // ========== Socket.IO ==========
    let socket = null;
    let myId = null;
    const state = {
      entered: false,   // pose 送信を開始するかどうか
      myColor: '#ffffff',
    };
    const myDisplay = { width: 0.30, height: 0.20, yaw: 0, pitch: 0, roll: 0, offaxis: false };
    let viewerEye = { x: 0, y: 2.0, z: 0 };
    let selectedClientId = ''; // master のみ使用

    function waitForIO(cb, n = 100) {
      if (typeof io !== 'undefined') return cb();
      if (n <= 0) { log('socket.io ロードタイムアウト', 'err'); return; }
      setTimeout(() => waitForIO(cb, n - 1), 50);
    }
    waitForIO(setupSocket);

    function setupSocket() {
      const cfg = window.APP_CONFIG || {};
      socket = io(cfg.socketUrl || undefined, { transports: ['websocket', 'polling'] });

      socket.on('connect', () => {
        document.getElementById('conn-pill').classList.add('ok');
        document.getElementById('conn-text').textContent = '接続 OK';
        log('socket connected: ' + socket.id, 'ok');
      });
      socket.on('disconnect', () => {
        document.getElementById('conn-pill').classList.remove('ok');
        document.getElementById('conn-text').textContent = '切断';
        log('socket disconnected', 'err');
      });

      socket.on('init', (data) => {
        myId = data.id;
        if (data.self && data.self.color) state.myColor = data.self.color;
        // 既存ユーザー
        for (const id in data.users) {
          const u = data.users[id];
          const a = ensureAvatar(id, u.color, u.role);
          a.grp.position.set(u.x, u.y, u.z);
          a.grp.quaternion.set(u.qx, u.qy, u.qz, u.qw);
        }
        rebuildClientSelect();
        log('init: id=' + myId + ' others=' + Object.keys(data.users || {}).length, 'ok');
        // ディスプレイサイズを報告
        socket.emit('displaySize', { width: myDisplay.width, height: myDisplay.height });
      });

      socket.on('join', (u) => {
        const a = ensureAvatar(u.id, u.color, u.role);
        a.grp.position.set(u.x, u.y, u.z);
        a.grp.quaternion.set(u.qx, u.qy, u.qz, u.qw);
        rebuildClientSelect();
        log('join: ' + u.id.substring(0, 6), 'ok');
      });

      socket.on('pose', (u) => {
        const a = avatars.get(u.id);
        if (!a) return;
        a.grp.position.set(u.x, u.y, u.z);
        a.grp.quaternion.set(u.qx, u.qy, u.qz, u.qw);
        if (u.role) a.role = u.role;
      });

      socket.on('leave', (u) => {
        const a = avatars.get(u.id);
        if (a) { scene.remove(a.grp); avatars.delete(u.id); }
        rebuildClientSelect();
        log('leave: ' + u.id.substring(0, 6));
      });

      socket.on('displayConfig', (data) => {
        if (!data || !data.id) return;
        // 対象が自分ならローカル state 更新
        if (data.id === myId && data.display) {
          if (typeof data.display.offaxis === 'boolean') myDisplay.offaxis = data.display.offaxis;
          if (typeof data.display.width === 'number') myDisplay.width = data.display.width;
          if (typeof data.display.height === 'number') myDisplay.height = data.display.height;
          if (typeof data.display.yaw === 'number') myDisplay.yaw = data.display.yaw;
          if (typeof data.display.pitch === 'number') myDisplay.pitch = data.display.pitch;
          if (typeof data.display.roll === 'number') myDisplay.roll = data.display.roll;
          syncObsOaBtn();
        }
        // master パネル: 選択中クライアントの表示更新
        if (ROLE === 'master' && data.id === selectedClientId) {
          syncMasterOaBtn(data.display);
        }
      });

      socket.on('viewerEye', (data) => {
        if (!data) return;
        if (typeof data.x === 'number') viewerEye.x = data.x;
        if (typeof data.y === 'number') viewerEye.y = data.y;
        if (typeof data.z === 'number') viewerEye.z = data.z;
        // master の入力欄も同期
        if (ROLE === 'master') {
          const vex = document.getElementById('ve-x');
          const vey = document.getElementById('ve-y');
          const vez = document.getElementById('ve-z');
          if (vex && document.activeElement !== vex) vex.value = viewerEye.x.toFixed(2);
          if (vey && document.activeElement !== vey) vey.value = viewerEye.y.toFixed(2);
          if (vez && document.activeElement !== vez) vez.value = viewerEye.z.toFixed(2);
        }
      });

      // master → 強制ポーズ (自分が対象なら camera を snap)
      socket.on('forcePose', (data) => {
        if (!data) return;
        if (data.id === myId) {
          camera.position.set(data.x, data.y, data.z);
          camera.quaternion.set(data.qx, data.qy, data.qz, data.qw);
          // yaw/pitch を Euler に再抽出して observer 内部状態も同期
          if (typeof _obsResync === 'function') _obsResync();
        }
        // 他クライアント: avatar を移動
        const a = avatars.get(data.id);
        if (a) {
          a.grp.position.set(data.x, data.y, data.z);
          a.grp.quaternion.set(data.qx, data.qy, data.qz, data.qw);
        }
      });
    }

    // ========== pose 送信 (60Hz スロットル) ==========
    let _lastPoseSent = 0;
    function sendPoseThrottled() {
      if (!socket || !socket.connected || !state.entered) return;
      const now = performance.now();
      if (now - _lastPoseSent < 16) return;
      _lastPoseSent = now;
      socket.emit('pose', {
        role: ROLE,
        x: camera.position.x, y: camera.position.y, z: camera.position.z,
        qx: camera.quaternion.x, qy: camera.quaternion.y,
        qz: camera.quaternion.z, qw: camera.quaternion.w,
      });
    }

    // ========== メインループ用: フレーム更新関数のレジストリ (setupObserver が push するので先に宣言) ==========
    const updaters = [];

    // ========== ロール別: パネル表示 + セットアップ ==========
    let _obsResync = null; // observer の yaw/pitch 再同期用 (forcePose 受信後)

    if (ROLE === 'observer') {
      document.getElementById('observer-panel').style.display = 'block';
      setupObserver();
    } else if (ROLE === 'master') {
      document.getElementById('observer-panel').style.display = 'block';
      document.getElementById('master-panel').style.display = 'block';
      setupObserver();
      setupMaster();
    } else {
      // camera ロール: このスペースではアバターだけ生成、UI は最小
      state.entered = true;
    }

    // ============================================================
    // OBSERVER セットアップ (FPS 風 yaw/pitch + WASD + テレポート + Off-Axis)
    // ============================================================
    function setupObserver() {
      state.entered = true;

      let yaw = 0, pitch = 0;
      const _e = new THREE.Euler(0, 0, 0, 'YXZ');
      function applyYawPitch() {
        _e.set(pitch, yaw, 0, 'YXZ');
        camera.quaternion.setFromEuler(_e);
      }
      applyYawPitch();
      _obsResync = () => {
        const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
        yaw = e.y; pitch = e.x;
      };

      const dom = renderer.domElement;
      dom.style.cursor = 'grab';

      // 左ドラッグ = look
      let dragging = false, lastX = 0, lastY = 0;
      dom.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        dragging = true; lastX = e.clientX; lastY = e.clientY;
        dom.style.cursor = 'grabbing';
      });
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - lastX, dy = e.clientY - lastY;
        lastX = e.clientX; lastY = e.clientY;
        const SENS = 0.0035;
        yaw -= dx * SENS;
        pitch -= dy * SENS;
        const PL = Math.PI / 2 - 0.05;
        pitch = Math.max(-PL, Math.min(PL, pitch));
        applyYawPitch();
      });
      window.addEventListener('mouseup', () => { dragging = false; dom.style.cursor = 'grab'; });
      dom.addEventListener('contextmenu', (e) => e.preventDefault());

      // WASD 移動
      const keys = new Set();
      window.addEventListener('keydown', (e) => {
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
        keys.add(e.code);
      });
      window.addEventListener('keyup', (e) => keys.delete(e.code));

      const moveTmp = new THREE.Vector3();
      function updateMove(dt) {
        const shift = keys.has('ShiftLeft') || keys.has('ShiftRight');
        const speed = (shift ? 6.0 : 2.5) * dt;
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        forward.y = 0; forward.normalize();
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        right.y = 0; right.normalize();
        moveTmp.set(0, 0, 0);
        if (keys.has('KeyW')) moveTmp.addScaledVector(forward, speed);
        if (keys.has('KeyS')) moveTmp.addScaledVector(forward, -speed);
        if (keys.has('KeyA')) moveTmp.addScaledVector(right, -speed);
        if (keys.has('KeyD')) moveTmp.addScaledVector(right, speed);
        if (keys.has('KeyQ')) moveTmp.y -= speed;
        if (keys.has('KeyE')) moveTmp.y += speed;
        camera.position.add(moveTmp);
        // 床範囲外へ大きく飛ばないよう緩やかにクランプ
        const HL = FIELD_HALF * 2;
        camera.position.x = Math.max(-HL, Math.min(HL, camera.position.x));
        camera.position.z = Math.max(-HL, Math.min(HL, camera.position.z));
        camera.position.y = Math.max(0.1, Math.min(50, camera.position.y));
      }
      // update ループへ登録
      updaters.push(updateMove);

      // テレポート系
      function teleport(x, y, z, yawDeg, pitchDeg) {
        camera.position.set(x, y, z);
        if (typeof yawDeg === 'number') yaw = THREE.MathUtils.degToRad(yawDeg);
        if (typeof pitchDeg === 'number') pitch = THREE.MathUtils.degToRad(pitchDeg);
        applyYawPitch();
      }
      document.getElementById('obs-teleport').addEventListener('click', () => {
        const x = parseFloat(document.getElementById('obs-x').value) || 0;
        const y = parseFloat(document.getElementById('obs-y').value) || 1.7;
        const z = parseFloat(document.getElementById('obs-z').value) || 0;
        teleport(x, y, z);
      });
      document.getElementById('obs-overview').addEventListener('click', () => {
        teleport(0, 15, 20, 0, -40);
      });
      document.getElementById('obs-top').addEventListener('click', () => {
        teleport(0, 20, 0, 0, -89);
      });
      // Enter で apply
      ['obs-x','obs-y','obs-z'].forEach((id) => {
        const el = document.getElementById(id);
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') document.getElementById('obs-teleport').click();
        });
      });

      // Off-Axis トグル (自分に適用) — サーバーへ notify
      const obsOaBtn = document.getElementById('obs-offaxis-toggle');
      window.syncObsOaBtn = function() {
        obsOaBtn.textContent = myDisplay.offaxis ? 'ON' : 'OFF';
        obsOaBtn.style.background = myDisplay.offaxis ? '#06b6d4' : '#475569';
        obsOaBtn.style.color = myDisplay.offaxis ? '#083344' : 'white';
      };
      syncObsOaBtn();
      obsOaBtn.addEventListener('click', () => {
        myDisplay.offaxis = !myDisplay.offaxis;
        syncObsOaBtn();
        if (socket && socket.connected) {
          socket.emit('displayConfig', { offaxis: myDisplay.offaxis });
        }
        log('observer offaxis → ' + (myDisplay.offaxis ? 'ON' : 'OFF'), 'ok');
      });
      // 表示サイズ入力
      function pushDisplaySize() {
        const w = parseFloat(document.getElementById('obs-display-w').value) || 0.3;
        const h = parseFloat(document.getElementById('obs-display-h').value) || 0.2;
        myDisplay.width = w; myDisplay.height = h;
        if (socket && socket.connected) socket.emit('displaySize', { width: w, height: h });
      }
      document.getElementById('obs-display-w').addEventListener('change', pushDisplaySize);
      document.getElementById('obs-display-h').addEventListener('change', pushDisplaySize);
    }

    // ============================================================
    // MASTER セットアップ (クライアント選択 + 強制ポーズ + Off-Axis + viewerEye)
    // ============================================================
    function setupMaster() {
      // クライアント選択
      const selEl = document.getElementById('m-client-select');
      selEl.addEventListener('change', () => {
        selectedClientId = selEl.value;
        readCurrentToInputs();
        // 選択中クライアントの display info を Off-Axis ボタンに反映
        // (現在の display 情報を再取得するには init/join に含まれる情報を使う: 簡易実装)
        // ここでは avatars.get() から拾える範囲で
      });

      // 適用 (強制ポーズ)
      function applyForcePose() {
        if (!selectedClientId) { log('未選択', 'err'); return; }
        const x = parseFloat(document.getElementById('m-x').value) || 0;
        const y = parseFloat(document.getElementById('m-y').value) || 0;
        const z = parseFloat(document.getElementById('m-z').value) || 0;
        const yaw   = THREE.MathUtils.degToRad(parseFloat(document.getElementById('m-yaw').value)   || 0);
        const pitch = THREE.MathUtils.degToRad(parseFloat(document.getElementById('m-pitch').value) || 0);
        const roll  = THREE.MathUtils.degToRad(parseFloat(document.getElementById('m-roll').value)  || 0);
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ'));
        if (socket && socket.connected) {
          socket.emit('controlPose', {
            targetId: selectedClientId,
            x, y, z,
            qx: q.x, qy: q.y, qz: q.z, qw: q.w,
          });
        }
        log('force pose → ' + selectedClientId.substring(0, 6), 'ok');
      }
      document.getElementById('m-apply').addEventListener('click', applyForcePose);
      ['m-x','m-y','m-z','m-yaw','m-pitch','m-roll'].forEach((id) => {
        document.getElementById(id).addEventListener('keydown', (e) => {
          if (e.key === 'Enter') applyForcePose();
        });
      });

      // 現在値読込
      function readCurrentToInputs() {
        if (!selectedClientId) return;
        const a = avatars.get(selectedClientId);
        if (!a) return;
        const p = a.grp.position;
        document.getElementById('m-x').value = p.x.toFixed(2);
        document.getElementById('m-y').value = p.y.toFixed(2);
        document.getElementById('m-z').value = p.z.toFixed(2);
        const e = new THREE.Euler().setFromQuaternion(a.grp.quaternion, 'YXZ');
        document.getElementById('m-yaw').value   = THREE.MathUtils.radToDeg(e.y).toFixed(0);
        document.getElementById('m-pitch').value = THREE.MathUtils.radToDeg(e.x).toFixed(0);
        document.getElementById('m-roll').value  = THREE.MathUtils.radToDeg(e.z).toFixed(0);
      }
      document.getElementById('m-readcurrent').addEventListener('click', readCurrentToInputs);

      // Off-Axis (選択中クライアントの display.offaxis をトグル)
      // 選択中クライアントの現在 display state は displayConfig 受信で更新する
      const _masterDisplayCache = new Map(); // id → display
      window.syncMasterOaBtn = function(display) {
        if (display) _masterDisplayCache.set(selectedClientId, display);
        const d = _masterDisplayCache.get(selectedClientId) || {};
        const btn = document.getElementById('m-offaxis-toggle');
        btn.textContent = d.offaxis ? 'ON' : 'OFF';
        btn.style.background = d.offaxis ? '#06b6d4' : '#475569';
        btn.style.color = d.offaxis ? '#083344' : 'white';
        const ds = document.getElementById('m-display-size');
        if (typeof d.width === 'number' && typeof d.height === 'number') {
          ds.textContent = 'サイズ: ' + d.width.toFixed(2) + '×' + d.height.toFixed(2) + 'm';
        } else {
          ds.textContent = 'サイズ: --';
        }
      };
      document.getElementById('m-offaxis-toggle').addEventListener('click', () => {
        if (!selectedClientId) { log('未選択', 'err'); return; }
        const cur = _masterDisplayCache.get(selectedClientId) || { offaxis: false };
        const newVal = !cur.offaxis;
        if (socket && socket.connected) {
          socket.emit('displayConfig', { targetId: selectedClientId, offaxis: newVal });
        }
        log('master offaxis[' + selectedClientId.substring(0, 6) + '] → ' + (newVal ? 'ON' : 'OFF'), 'ok');
      });

      // viewerEye
      document.getElementById('ve-apply').addEventListener('click', () => {
        const x = parseFloat(document.getElementById('ve-x').value) || 0;
        const y = parseFloat(document.getElementById('ve-y').value) || 2;
        const z = parseFloat(document.getElementById('ve-z').value) || 0;
        if (socket && socket.connected) {
          socket.emit('viewerEye', { x, y, z });
        }
        log('viewerEye → (' + x + ',' + y + ',' + z + ')', 'ok');
      });
    }

    // ========== クライアント選択ドロップダウン ==========
    function rebuildClientSelect() {
      const sel = document.getElementById('m-client-select');
      if (!sel) return;
      const prev = sel.value;
      sel.innerHTML = '<option value="">-- 未選択 --</option>';
      avatars.forEach((a, id) => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = (a.role || '?').substring(0, 3) + ' ' + id.substring(0, 6);
        sel.appendChild(opt);
      });
      if (prev && avatars.has(prev)) sel.value = prev;
    }

    // ========== UI 表示切替 ==========
    const uiToggleBtn = document.getElementById('ui-toggle');
    if (uiToggleBtn) {
      uiToggleBtn.addEventListener('click', () => {
        document.body.classList.toggle('ui-hidden');
        uiToggleBtn.textContent = document.body.classList.contains('ui-hidden') ? '◉' : 'UI';
      });
    }

    // ========== メインループ ==========
    const clock = new THREE.Clock();
    function tick() {
      requestAnimationFrame(tick);
      const dt = Math.min(clock.getDelta(), 0.1);
      for (const fn of updaters) fn(dt);
      sendPoseThrottled();
      // ステータス表示
      const cnt = document.getElementById('count');
      const mp = document.getElementById('my-pos');
      if (cnt) cnt.textContent = String(avatars.size + (state.entered ? 1 : 0));
      if (mp) mp.textContent =
        camera.position.x.toFixed(1) + ',' +
        camera.position.y.toFixed(1) + ',' +
        camera.position.z.toFixed(1);
      renderer.render(scene, camera);
    }
    tick();

    log('space2 ready (role=' + ROLE + ')', 'ok');
  }
})();
