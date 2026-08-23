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

    // ========== 診断: id → 要素を返す。null なら「どの id が欠けているか」ログして
    //   その後の .addEventListener の連鎖エラーを未然に防ぐ (機能欠落として続行) ==========
    function _bind(id, evt, fn) {
      const el = document.getElementById(id);
      if (!el) {
        log('bind FAIL: #' + id + ' が DOM に無い (HTML が古い/未デプロイ の可能性)', 'err');
        return null;
      }
      el.addEventListener(evt, fn);
      return el;
    }
    function _by(id) {
      const el = document.getElementById(id);
      if (!el) log('$: #' + id + ' が DOM に無い', 'err');
      return el;
    }

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
    // 背景 = 白。距離フェード先の色と一致させると「遠方が空気に溶ける」ように見える
    scene.background = new THREE.Color(0xffffff);
    // 指数フォグ (視点から距離 d のフラグメントの色は color との mix になる):
    //   factor = exp(-(density * d)²), density=0.12 なら 10m で 24%→白 76%、15m でほぼ完全に白
    //   Fog (linear) より遠近の変化が自然。GridHelper (LineBasicMaterial) も対応する。
    //   ★ 床面自体は純白 (0xffffff) なので視覚的変化なし (白+白=白)。
    //      グリッド/境界線 (濃グレー) と他クライアントのアバターだけがフェードして見える。
    //   density は master 制御パネルから変更可能 (fogConfig で全クライアントに配信)
    scene.fog = new THREE.FogExp2(0xffffff, 0.3);

    const camera = new THREE.PerspectiveCamera(
      72,
      window.innerWidth / window.innerHeight,
      0.05, 500
    );
    // 全ロール共通: 入室座標 (0, 1, 0)、初期回転 Yaw=-90°, Pitch=0, Roll=0
    //   Euler(pitch=0, yaw=-π/2, roll=0, 'YXZ') → +X 方向を見る
    const SPAWN_POS = { x: 0, y: 1, z: 0 };
    const INIT_YAW = -Math.PI / 2;   // -90°
    const INIT_PITCH = 0;
    const INIT_ROLL = 0;
    camera.position.set(SPAWN_POS.x, SPAWN_POS.y, SPAWN_POS.z);
    camera.quaternion.setFromEuler(new THREE.Euler(INIT_PITCH, INIT_YAW, INIT_ROLL, 'YXZ'));

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.getElementById('stage').appendChild(renderer.domElement);

    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });

    // ライト (床は白でフラットに見せるため、環境光を強めに)
    scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.35);
    dirLight.position.set(10, 20, 10);
    scene.add(dirLight);

    // ========== 床: 20m × 20m at origin (白) ==========
    const FIELD_SIZE = 20;
    const FIELD_HALF = FIELD_SIZE / 2;

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(FIELD_SIZE, FIELD_SIZE),
      new THREE.MeshStandardMaterial({
        color: 0xffffff,      // 純白
        roughness: 1.0,
        metalness: 0.0,
        side: THREE.DoubleSide,
        // fog: true はデフォルト有効 — 遠方は scene.fog の白に自動フェード
      })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, 0);
    floor.name = 'floor';
    scene.add(floor);

    // 1m グリッド (中グレー) — フォグでフェードして遠方が薄く消える
    //   GridHelper は LineBasicMaterial (fog: true デフォルト) なので、
    //   遠方の格子線が自動的に白フェードで薄くなる。
    //   色を濃くすることで白 (背景) との差が大きくなり、フェードが視認しやすくなる。
    const grid = new THREE.GridHelper(FIELD_SIZE, FIELD_SIZE, 0x374151, 0x6b7280);
    grid.position.set(0, 0.01, 0);
    scene.add(grid);
    // 5m 主格子 (濃いグレー、はっきり見える)
    const majorGrid = new THREE.GridHelper(FIELD_SIZE, FIELD_SIZE / 5, 0x1f2937, 0x1f2937);
    majorGrid.position.set(0, 0.015, 0);
    scene.add(majorGrid);
    // 20m 境界 (ほぼ黒)
    const boundary = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(FIELD_SIZE, 0.02, FIELD_SIZE)),
      new THREE.LineBasicMaterial({ color: 0x111827 })
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

    // cube1: 1m 立方体
    //   ・XZ 中心 = (1.5, -0.5)、Y = 0.5 (床に接地する高さ)
    //   ・MeshStandardMaterial は fog:true (default) なので遠ざかれば白に溶ける
    //   ・クリックで選択 → 矢印/PageUp/PageDown で 1m グリッド移動 (床貫通不可)
    const cube1 = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({
        color: 0x6b7280,
        roughness: 0.8,
        metalness: 0.0,
      })
    );
    cube1.position.set(1.5, 0.5, -0.5);
    cube1.name = 'cube1';
    scene.add(cube1);

    // 選択ハイライト用: cube1 に黄色エッジを子オーバーレイ (parented → cube 移動に追従)
    const cube1Edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(cube1.geometry),
      new THREE.LineBasicMaterial({
        color: 0xfbbf24,
        transparent: true, opacity: 1.0,
        depthTest: false,   // 手前に確実に描画
        fog: false,         // ハイライトは遠くても消えないように
      })
    );
    cube1Edges.renderOrder = 999;
    cube1Edges.visible = false;
    cube1.add(cube1Edges);

    // ========== 選択/移動 (グリッド 1m 単位) ==========
    //   ・selectables: raycast 対象のリスト (将来オブジェクト追加可能)
    //   ・selectedObject: 現在選択中の Mesh (null なら未選択)
    //   ・移動は 1m スナップ、cube 中心 Y >= CUBE_HALF (= 0.5) で床貫通防止
    //   ・キー割り当て:
    //       ← / →   : X ± 1  (左右)
    //       ↑ / ↓   : Z ∓ 1  (奥 / 手前)
    //       PageUp   : Y + 1 (上)
    //       PageDown : Y - 1 (下、床で止まる)
    //       Esc      : 選択解除
    const selectables = [cube1];
    let selectedObject = null;
    const CUBE_STEP = 1.0;
    const CUBE_HALF = 0.5;   // 1m キューブ半分 = 床上面までの距離
    // ドラッグ移動感度 (px / 1m)。master が変更 → server 経由で全クライアントへ配信される
    let moveSensitivity = 60;
    function selectObject(obj) {
      if (selectedObject === obj) return;
      // 前の選択解除表示
      if (selectedObject) {
        const prevEdges = selectedObject.getObjectByProperty('isLineSegments', true);
        if (prevEdges) prevEdges.visible = false;
      }
      selectedObject = obj;
      if (obj) {
        const edges = obj.getObjectByProperty('isLineSegments', true);
        if (edges) edges.visible = true;
        log('select: ' + obj.name, 'ok');
      } else {
        log('deselect', 'ok');
      }
      updateSelectionHint();
    }
    function updateSelectionHint() {
      const el = document.getElementById('obs-sel-info');
      if (!el) return;
      el.textContent = selectedObject ? selectedObject.name : '--';
    }
    function snapAndClamp(p) {
      p.x = Math.round(p.x - CUBE_HALF) + CUBE_HALF;
      p.z = Math.round(p.z - CUBE_HALF) + CUBE_HALF;
      p.y = Math.round(p.y - CUBE_HALF) + CUBE_HALF;
      // 床貫通防止: cube 下面 = center.y - CUBE_HALF >= 0 → center.y >= CUBE_HALF
      if (p.y < CUBE_HALF) p.y = CUBE_HALF;
    }
    // 選択中オブジェクトの現在位置をサーバーに送信 (他クライアントで同期される)
    //   スロットル: 直前送信から 40ms 以内は連続送信抑制 (10 回/秒 程度)
    let _lastObjSent = 0;
    function emitObjectPose(obj, force) {
      if (!obj || !socket || !socket.connected) return;
      const now = performance.now();
      if (!force && now - _lastObjSent < 40) return;
      _lastObjSent = now;
      socket.emit('objectPose', {
        name: obj.name,
        x: obj.position.x, y: obj.position.y, z: obj.position.z,
      });
    }
    function moveSelected(dx, dy, dz) {
      if (!selectedObject) return;
      const p = selectedObject.position;
      p.x += dx * CUBE_STEP;
      p.y += dy * CUBE_STEP;
      p.z += dz * CUBE_STEP;
      snapAndClamp(p);
      log('move ' + selectedObject.name + ' → (' + p.x + ',' + p.y + ',' + p.z + ')', 'ok');
      emitObjectPose(selectedObject, true);
    }
    // グローバルキー: 選択中のみ反応。他ハンドラより先に preventDefault
    window.addEventListener('keydown', (e) => {
      if (!selectedObject) {
        if (e.code === 'Escape') selectObject(null);
        return;
      }
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
      let handled = true;
      switch (e.code) {
        case 'ArrowLeft':  moveSelected(-1, 0, 0); break;
        case 'ArrowRight': moveSelected(+1, 0, 0); break;
        case 'ArrowUp':    moveSelected(0, 0, -1); break;   // 奥
        case 'ArrowDown':  moveSelected(0, 0, +1); break;   // 手前
        case 'PageUp':     moveSelected(0, +1, 0); break;   // 上
        case 'PageDown':   moveSelected(0, -1, 0); break;   // 下 (床で止まる)
        case 'Escape':     selectObject(null); break;
        default: handled = false;
      }
      if (handled) e.preventDefault();
    });

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

      // 他クライアントからの objectPose (cube1 等の位置更新)
      //   自分自身が emit した内容は broadcast 経由で戻らないが、名前一致すればどのオブジェクトも同期
      socket.on('objectPose', (data) => {
        if (!data || typeof data.name !== 'string') return;
        try {
          log('recv objectPose: ' + data.name + ' → (' +
              (typeof data.x === 'number' ? data.x.toFixed(2) : '?') + ',' +
              (typeof data.y === 'number' ? data.y.toFixed(2) : '?') + ',' +
              (typeof data.z === 'number' ? data.z.toFixed(2) : '?') + ')', 'ok');
        } catch (_) {}
        // 現在サポートするのは cube1 のみ (将来 selectables に追加すれば拡張可)
        if (data.name === 'cube1') {
          // 自分が動かしている最中は上書きしない (ドラッグ中の一時ズレを防ぐ)
          if (selectedObject === cube1 && window.__cubeDragActive) return;
          if (typeof data.x === 'number') cube1.position.x = data.x;
          if (typeof data.y === 'number') cube1.position.y = data.y;
          if (typeof data.z === 'number') cube1.position.z = data.z;
        }
      });

      socket.on('moveConfig', (data) => {
        if (!data || typeof data.sensitivity !== 'number') return;
        moveSensitivity = Math.max(5, Math.min(500, data.sensitivity));
        const inp = document.getElementById('m-move-sens');
        if (inp && document.activeElement !== inp) inp.value = moveSensitivity;
        const cur = document.getElementById('m-move-sens-current');
        if (cur) cur.textContent = moveSensitivity;
        log('move sensitivity → ' + moveSensitivity + ' px/m', 'ok');
      });

      socket.on('fogConfig', (data) => {
        if (!data || !scene.fog) return;
        if (typeof data.density === 'number' && isFinite(data.density)) {
          scene.fog.density = Math.max(0, Math.min(1, data.density));
          // master パネルの入力欄と現在値表示を同期
          const inp = document.getElementById('m-fog-density');
          if (inp && document.activeElement !== inp) inp.value = scene.fog.density.toFixed(3);
          const cur = document.getElementById('m-fog-current');
          if (cur) cur.textContent = scene.fog.density.toFixed(3);
          log('fog density → ' + scene.fog.density.toFixed(3), 'ok');
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
      // camera ロール: 入室ボタン → iOS permission → DeviceOrientation で 360° マジックウィンドウ
      setupCameraEntry();
    }

    // ============================================================
    // CAMERA (スマホ): 入室 + DeviceOrientation (360° ジャイロ) + iOS permission
    //   ・enter-btn 押下で DeviceOrientation/DeviceMotion 権限要求 (iOS 13+ 必須)
    //   ・enterAsCamera で spawn 位置 (0,2,0) + 初期方向 +Y にセット
    //   ・setupDeviceOrientation で毎フレーム phone 姿勢 → camera.quaternion
    // ============================================================
    function setupCameraEntry() {
      _bind('enter-btn', 'click', async () => {
        // iOS 13+ DeviceOrientation permission
        try {
          if (typeof DeviceOrientationEvent !== 'undefined'
              && typeof DeviceOrientationEvent.requestPermission === 'function') {
            const p = await DeviceOrientationEvent.requestPermission();
            if (p !== 'granted') { log('DeviceOrientation 拒否', 'err'); return; }
            log('DeviceOrientation 許可', 'ok');
          }
        } catch (e) {
          log('requestPermission 例外: ' + e.message, 'err');
        }
        // iOS 13+ DeviceMotion permission (現状 space2 では未使用、将来歩行追跡用)
        try {
          if (typeof DeviceMotionEvent !== 'undefined'
              && typeof DeviceMotionEvent.requestPermission === 'function') {
            await DeviceMotionEvent.requestPermission();
          }
        } catch (_) {}
        enterAsCamera();
      });
    }

    function enterAsCamera() {
      state.entered = true;
      camera.position.set(SPAWN_POS.x, SPAWN_POS.y, SPAWN_POS.z);
      // 初期方向: +Y (真上、DeviceOrientation が来るまでの一瞬用)
      camera.quaternion.setFromEuler(new THREE.Euler(INIT_PITCH, INIT_YAW, 0, 'YXZ'));
      log('spawn(camera): (' + SPAWN_POS.x + ',' + SPAWN_POS.y + ',' + SPAWN_POS.z + ') 初期 +Y 向き', 'ok');
      const overlay = _by('enter-overlay');
      if (overlay) overlay.style.display = 'none';
      setupDeviceOrientation();
    }

    // ========== DeviceOrientation → camera.quaternion (Three.js 旧 DeviceOrientationControls 準拠) ==========
    let _cameraTickFn = null;   // tick で毎フレーム呼ばれる (camera role のみ設定される)
    function setupDeviceOrientation() {
      const euler = new THREE.Euler();
      const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -π/2 X 軸オフセット
      const zee = new THREE.Vector3(0, 0, 1);
      const q0 = new THREE.Quaternion();

      let alpha = 0, beta = 0, gamma = 0;
      let hasEvent = false;
      let screenOrient = (typeof window.orientation === 'number') ? window.orientation : 0;

      window.addEventListener('orientationchange', () => {
        screenOrient = window.orientation || 0;
      });

      window.addEventListener('deviceorientation', (e) => {
        if (e.alpha === null) return;
        alpha = THREE.MathUtils.degToRad(e.alpha);
        beta  = THREE.MathUtils.degToRad(e.beta || 0);
        gamma = THREE.MathUtils.degToRad(e.gamma || 0);
        hasEvent = true;
      }, true);

      _cameraTickFn = () => {
        if (!hasEvent) return;  // gyro が来るまで初期 +Y 向きを維持
        const orient = THREE.MathUtils.degToRad(screenOrient);
        euler.set(beta, alpha, -gamma, 'YXZ');
        camera.quaternion.setFromEuler(euler);
        camera.quaternion.multiply(q1);
        camera.quaternion.multiply(q0.setFromAxisAngle(zee, -orient));
      };
      log('DeviceOrientation listener attached', 'ok');
    }

    // ============================================================
    // 共有 canvas インタラクション: tap = 選択、drag = 選択中オブジェクトを 1m 単位移動
    //   ・observer/master マウス左クリック、camera スマホタップの両方に対応
    //   ・選択中に drag/swipe → cube1 を XZ 平面 (床) 上でスナップ移動
    //     - カメラの right/forward を XZ 平面に投影し、画面 dx/dy → 世界 offset に写像
    //     - Math.round で 1m グリッドスナップ
    //     - moveSensitivity (px/m) で感度調整 (master → server → 全クライアント配信)
    //   ・選択中でも "移動 < slop" の press+release は tap 扱いで選択/選択解除
    //   ・observer カメラ回転ドラッグは "未選択時のみ" 発火 (setupObserver 側で判定)
    // 外部から参照される:
    //   window.__cubeDragActive : 選択中のドラッグ移動中かどうか (observer が回転抑制に使う)
    // ============================================================
    window.__cubeDragActive = false;
    {
      const _canvas = renderer.domElement;
      const _rayTap = new THREE.Raycaster();
      const _ndcTap = new THREE.Vector2();
      let _pressAt = null;
      let _tapMoved = false;
      let _dragState = null;   // 選択中の drag 移動状態
      const TAP_SLOP_MOUSE = 6;
      const TAP_SLOP_TOUCH = 10;

      function _computeCamBasis() {
        const camR = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        camR.y = 0;
        if (camR.lengthSq() < 1e-6) camR.set(1, 0, 0); else camR.normalize();
        const camF = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        camF.y = 0;
        if (camF.lengthSq() < 1e-6) camF.set(0, 0, -1); else camF.normalize();
        return { camR, camF };
      }

      function _pressBegin(x, y) {
        _pressAt = { x, y };
        _tapMoved = false;
        // 選択中ならドラッグ移動用の初期状態を用意 (実際の移動は _pressCheck 内で発生)
        if (selectedObject) {
          const basis = _computeCamBasis();
          _dragState = {
            startCube: selectedObject.position.clone(),
            startX: x,
            startY: y,
            camR: basis.camR,
            camF: basis.camF,
            moved: false,
          };
          window.__cubeDragActive = true;
          try {
            log('drag begin: ' + selectedObject.name +
                ' start=(' + _dragState.startCube.x.toFixed(2) + ',' + _dragState.startCube.z.toFixed(2) + ')' +
                ' camR=(' + basis.camR.x.toFixed(2) + ',' + basis.camR.z.toFixed(2) + ')' +
                ' camF=(' + basis.camF.x.toFixed(2) + ',' + basis.camF.z.toFixed(2) + ')' +
                ' sens=' + moveSensitivity, 'ok');
          } catch (_) {}
        } else {
          _dragState = null;
          window.__cubeDragActive = false;
        }
      }
      function _pressCheck(x, y, slop) {
        if (!_pressAt) return;
        const dx = x - _pressAt.x, dy = y - _pressAt.y;
        if (Math.hypot(dx, dy) > slop) _tapMoved = true;
        if (_dragState) {
          const wr = (x - _dragState.startX) / moveSensitivity;
          const wf = -(y - _dragState.startY) / moveSensitivity;
          const off = _dragState.camR.clone().multiplyScalar(wr)
                        .add(_dragState.camF.clone().multiplyScalar(wf));
          const ix = Math.round(off.x);
          const iz = Math.round(off.z);
          if (ix !== 0 || iz !== 0) _dragState.moved = true;
          const p = selectedObject.position;
          const newX = _dragState.startCube.x + ix;
          const newZ = _dragState.startCube.z + iz;
          if (newX !== p.x || newZ !== p.z) {
            p.x = newX;
            p.z = newZ;
            snapAndClamp(p);
            try { log('drag step: ' + selectedObject.name + ' → (' + p.x.toFixed(2) + ',' + p.z.toFixed(2) + ') px=(' + dx + ',' + dy + ')', 'ok'); } catch (_) {}
            // ドラッグ中はスロットル付きで sync (最大 25 Hz)
            emitObjectPose(selectedObject, false);
          }
        }
      }
      function _pressEnd(x, y) {
        const hadDragMove = _dragState && _dragState.moved;
        _dragState = null;
        window.__cubeDragActive = false;
        const wasTap = _pressAt && !_tapMoved && !hadDragMove;
        _pressAt = null;
        if (hadDragMove) {
          log('move ' + selectedObject.name + ' → (' +
              selectedObject.position.x + ',' + selectedObject.position.y + ',' +
              selectedObject.position.z + ')', 'ok');
          // ドラッグ終了時に強制送信 (スロットルで最終位置が抜け落ちるのを防ぐ)
          emitObjectPose(selectedObject, true);
          return;
        }
        if (!wasTap) return;
        // tap: raycast → 選択 / 選択解除
        const rect = _canvas.getBoundingClientRect();
        _ndcTap.x = ((x - rect.left) / rect.width) * 2 - 1;
        _ndcTap.y = -((y - rect.top) / rect.height) * 2 + 1;
        _rayTap.setFromCamera(_ndcTap, camera);
        const hits = _rayTap.intersectObjects(selectables, false);
        if (hits.length > 0) selectObject(hits[0].object);
        else selectObject(null);
      }

      // Mouse
      _canvas.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        _pressBegin(e.clientX, e.clientY);
      });
      window.addEventListener('mousemove', (e) => _pressCheck(e.clientX, e.clientY, TAP_SLOP_MOUSE));
      window.addEventListener('mouseup', (e) => {
        if (e.button !== 0) return;
        _pressEnd(e.clientX, e.clientY);
      });

      // Touch (mobile)
      _canvas.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) { _pressAt = null; _dragState = null; window.__cubeDragActive = false; return; }
        const t = e.touches[0];
        _pressBegin(t.clientX, t.clientY);
      }, { passive: true });
      _canvas.addEventListener('touchmove', (e) => {
        const t = e.touches[0]; if (!t) return;
        _pressCheck(t.clientX, t.clientY, TAP_SLOP_TOUCH);
      }, { passive: true });
      _canvas.addEventListener('touchend', (e) => {
        const t = e.changedTouches[0]; if (!t) { _pressAt = null; _dragState = null; window.__cubeDragActive = false; return; }
        _pressEnd(t.clientX, t.clientY);
      }, { passive: true });
      _canvas.addEventListener('touchcancel', () => {
        _pressAt = null; _dragState = null; window.__cubeDragActive = false;
      });
    }

    // ============================================================
    // OBSERVER セットアップ (FPS 風 yaw/pitch + WASD + テレポート + Off-Axis)
    // ============================================================
    function setupObserver() {
      state.entered = true;
      // 入室位置 (全ロール共通)
      camera.position.set(SPAWN_POS.x, SPAWN_POS.y, SPAWN_POS.z);
      // 初期方向 = +Y (真上)。ユーザーが下 (床) を見たい時は下方向にマウスドラッグ or PitchDown。
      let yaw = INIT_YAW, pitch = INIT_PITCH;
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

      // 左ドラッグ = look (yaw/pitch)。ただし選択中は cube 移動を優先し、カメラ回転は抑制。
      let dragging = false, lastX = 0, lastY = 0;
      dom.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        // 選択中は共有ハンドラが drag-move を担当 → カメラ回転を開始しない
        if (selectedObject) return;
        dragging = true; lastX = e.clientX; lastY = e.clientY;
        dom.style.cursor = 'grabbing';
      });
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        // 途中で選択された場合も抑制 (drag-move 側が動く)
        if (window.__cubeDragActive) return;
        const dx = e.clientX - lastX, dy = e.clientY - lastY;
        lastX = e.clientX; lastY = e.clientY;
        const SENS = 0.0035;
        yaw -= dx * SENS;
        pitch -= dy * SENS;
        // pitch は ±88° にクランプ (ジンバルロック回避)
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
      _bind('obs-teleport', 'click', () => {
        const x = parseFloat((_by('obs-x') || {}).value) || 0;
        const y = parseFloat((_by('obs-y') || {}).value) || 1.7;
        const z = parseFloat((_by('obs-z') || {}).value) || 0;
        teleport(x, y, z);
      });
      _bind('obs-overview', 'click', () => teleport(0, 15, 20, 0, -40));
      _bind('obs-top',      'click', () => teleport(0, 20, 0, 0, -89));
      // Enter で apply
      ['obs-x','obs-y','obs-z'].forEach((id) => {
        _bind(id, 'keydown', (e) => {
          if (e.key === 'Enter') {
            const t = _by('obs-teleport'); if (t) t.click();
          }
        });
      });

      // Off-Axis トグル (自分に適用) — サーバーへ notify
      const obsOaBtn = _by('obs-offaxis-toggle');
      window.syncObsOaBtn = function() {
        if (!obsOaBtn) return;
        obsOaBtn.textContent = myDisplay.offaxis ? 'ON' : 'OFF';
        obsOaBtn.style.background = myDisplay.offaxis ? '#06b6d4' : '#475569';
        obsOaBtn.style.color = myDisplay.offaxis ? '#083344' : 'white';
      };
      syncObsOaBtn();
      _bind('obs-offaxis-toggle', 'click', () => {
        myDisplay.offaxis = !myDisplay.offaxis;
        syncObsOaBtn();
        if (socket && socket.connected) {
          socket.emit('displayConfig', { offaxis: myDisplay.offaxis });
        }
        log('observer offaxis → ' + (myDisplay.offaxis ? 'ON' : 'OFF'), 'ok');
      });
      // 表示サイズ入力
      function pushDisplaySize() {
        const w = parseFloat((_by('obs-display-w') || {}).value) || 0.3;
        const h = parseFloat((_by('obs-display-h') || {}).value) || 0.2;
        myDisplay.width = w; myDisplay.height = h;
        if (socket && socket.connected) socket.emit('displaySize', { width: w, height: h });
      }
      _bind('obs-display-w', 'change', pushDisplaySize);
      _bind('obs-display-h', 'change', pushDisplaySize);

      // ========== フルスクリーン (旧 /test/space から継承) ==========
      //   ・obs-fullscreen ボタン: html 要素で requestFullscreen
      //   ・fs-exit-btn      : exitFullscreen
      //   ・fullscreenchange 監視: body.fs-mode class を付け外し
      //       → CSS で status/panel/log/ui-toggle 一括非表示、fs-exit-btn のみ表示
      //   ・resize もイベント経由で呼ばれるが念のため手動更新
      _bind('obs-fullscreen', 'click', () => {
        const el = document.documentElement;
        if (el.requestFullscreen) el.requestFullscreen().catch((e) => log('fullscreen err: ' + e.message, 'err'));
        else log('requestFullscreen 非対応ブラウザ', 'err');
      });
      _bind('fs-exit-btn', 'click', () => {
        if (document.exitFullscreen) document.exitFullscreen();
      });
      document.addEventListener('fullscreenchange', () => {
        const active = !!document.fullscreenElement;
        document.body.classList.toggle('fs-mode', active);
        // canvas サイズ再計算
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
        log('fullscreen ' + (active ? 'ON' : 'OFF'), 'ok');
      });
      // F キーでもフルスクリーン切替 (旧 /test/space 準拠)
      window.addEventListener('keydown', (e) => {
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
        if (e.code === 'KeyF') {
          if (document.fullscreenElement) document.exitFullscreen();
          else document.documentElement.requestFullscreen().catch(() => {});
        }
      });
    }

    // ============================================================
    // MASTER セットアップ (クライアント選択 + 強制ポーズ + Off-Axis + viewerEye)
    // ============================================================
    function setupMaster() {
      // クライアント選択
      const selEl = _by('m-client-select');
      _bind('m-client-select', 'change', () => {
        selectedClientId = selEl ? selEl.value : '';
        readCurrentToInputs();
      });

      // 適用 (強制ポーズ)
      function applyForcePose() {
        if (!selectedClientId) { log('未選択', 'err'); return; }
        const x = parseFloat((_by('m-x') || {}).value) || 0;
        const y = parseFloat((_by('m-y') || {}).value) || 0;
        const z = parseFloat((_by('m-z') || {}).value) || 0;
        const yaw   = THREE.MathUtils.degToRad(parseFloat((_by('m-yaw')   || {}).value) || 0);
        const pitch = THREE.MathUtils.degToRad(parseFloat((_by('m-pitch') || {}).value) || 0);
        const roll  = THREE.MathUtils.degToRad(parseFloat((_by('m-roll')  || {}).value) || 0);
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
      _bind('m-apply', 'click', applyForcePose);
      ['m-x','m-y','m-z','m-yaw','m-pitch','m-roll'].forEach((id) => {
        _bind(id, 'keydown', (e) => { if (e.key === 'Enter') applyForcePose(); });
      });

      // 現在値読込
      function readCurrentToInputs() {
        if (!selectedClientId) return;
        const a = avatars.get(selectedClientId);
        if (!a) return;
        const p = a.grp.position;
        const set = (id, v) => { const el = _by(id); if (el) el.value = v; };
        set('m-x', p.x.toFixed(2));
        set('m-y', p.y.toFixed(2));
        set('m-z', p.z.toFixed(2));
        const e = new THREE.Euler().setFromQuaternion(a.grp.quaternion, 'YXZ');
        set('m-yaw',   THREE.MathUtils.radToDeg(e.y).toFixed(0));
        set('m-pitch', THREE.MathUtils.radToDeg(e.x).toFixed(0));
        set('m-roll',  THREE.MathUtils.radToDeg(e.z).toFixed(0));
      }
      _bind('m-readcurrent', 'click', readCurrentToInputs);

      // Off-Axis (選択中クライアントの display.offaxis をトグル)
      const _masterDisplayCache = new Map(); // id → display
      window.syncMasterOaBtn = function(display) {
        if (display) _masterDisplayCache.set(selectedClientId, display);
        const d = _masterDisplayCache.get(selectedClientId) || {};
        const btn = _by('m-offaxis-toggle');
        if (btn) {
          btn.textContent = d.offaxis ? 'ON' : 'OFF';
          btn.style.background = d.offaxis ? '#06b6d4' : '#475569';
          btn.style.color = d.offaxis ? '#083344' : 'white';
        }
        const ds = _by('m-display-size');
        if (ds) {
          if (typeof d.width === 'number' && typeof d.height === 'number') {
            ds.textContent = 'サイズ: ' + d.width.toFixed(2) + '×' + d.height.toFixed(2) + 'm';
          } else {
            ds.textContent = 'サイズ: --';
          }
        }
      };
      _bind('m-offaxis-toggle', 'click', () => {
        if (!selectedClientId) { log('未選択', 'err'); return; }
        const cur = _masterDisplayCache.get(selectedClientId) || { offaxis: false };
        const newVal = !cur.offaxis;
        if (socket && socket.connected) {
          socket.emit('displayConfig', { targetId: selectedClientId, offaxis: newVal });
        }
        log('master offaxis[' + selectedClientId.substring(0, 6) + '] → ' + (newVal ? 'ON' : 'OFF'), 'ok');
      });

      // viewerEye
      _bind('ve-apply', 'click', () => {
        const x = parseFloat((_by('ve-x') || {}).value) || 0;
        const y = parseFloat((_by('ve-y') || {}).value) || 2;
        const z = parseFloat((_by('ve-z') || {}).value) || 0;
        if (socket && socket.connected) socket.emit('viewerEye', { x, y, z });
        log('viewerEye → (' + x + ',' + y + ',' + z + ')', 'ok');
      });

      // 移動感度 (master が変更 → server 経由で全クライアントに配信)
      function applyMoveSens() {
        const el = _by('m-move-sens');
        if (!el) return;
        const v = parseFloat(el.value);
        if (isNaN(v)) return;
        if (socket && socket.connected) socket.emit('moveConfig', { sensitivity: v });
        log('move sens emit → ' + v + ' px/m', 'ok');
      }
      _bind('m-move-sens-apply', 'click', applyMoveSens);
      _bind('m-move-sens', 'keydown', (e) => { if (e.key === 'Enter') applyMoveSens(); });

      // FogExp2 密度 (master が変更 → server 経由で全クライアントに配信)
      function applyFogDensity() {
        const el = _by('m-fog-density');
        if (!el) return;
        const d = parseFloat(el.value);
        if (isNaN(d)) return;
        if (socket && socket.connected) socket.emit('fogConfig', { density: d });
        log('fog density emit → ' + d.toFixed(3), 'ok');
      }
      _bind('m-fog-apply', 'click', applyFogDensity);
      _bind('m-fog-density', 'keydown', (e) => { if (e.key === 'Enter') applyFogDensity(); });
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
    _bind('ui-toggle', 'click', () => {
      const btn = _by('ui-toggle');
      document.body.classList.toggle('ui-hidden');
      if (btn) btn.textContent = document.body.classList.contains('ui-hidden') ? '◉' : 'UI';
    });

    // ========== メインループ ==========
    const clock = new THREE.Clock();
    function tick() {
      requestAnimationFrame(tick);
      const dt = Math.min(clock.getDelta(), 0.1);
      // camera role: DeviceOrientation で毎フレーム camera.quaternion 更新
      if (_cameraTickFn) _cameraTickFn();
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
