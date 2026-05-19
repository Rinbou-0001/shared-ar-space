// room.js - フェーズ5 (AR重畳・コーナー原点・world永続化)
//
// 設計:
//   - マーカー(コーナーに置く)を全デバイス共通の (0,0,0) 原点とする
//   - カメラ映像は表示(現実空間 = マジックウィンドウの背景)
//   - 仮想共通空間 = 'world' エンティティ。最新のマーカー姿勢を継続適用
//   - マーカーが画面から外れても直前のマーカー姿勢を保持(world は消えない)
//   - 自分の位置 = inverse(latestMarkerMatrix) でマーカー空間に変換して送信
//   - 他者のアバターは world の子としてマーカー空間座標で配置
//   - 距離・サイズはすべて実メートル単位(a-markerにsize=0.08を指定)

const log = (msg, cls) => window.uiLog && window.uiLog(msg, cls);

// ============================================================
// 0. 設定
// ============================================================
const AVATAR_RADIUS = 0.075;  // 直径15cm球の半径
const WINDOW_W = 0.10;        // マジックウィンドウ幅
const WINDOW_H = 0.06;        // マジックウィンドウ高
const POSE_SEND_HZ = 20;      // ポーズ送信周波数

// ============================================================
// 1. 状態
// ============================================================
const state = {
  myId: null,
  myColor: null,
  myPos: new THREE.Vector3(),
  myQuat: new THREE.Quaternion(),
  hasFirstPose: false,
  avatars: new Map(),
  markerSeen: false,           // 一度でもマーカーを検出したか
  markerVisibleNow: false,     // 現在マーカーが見えているか
  latestMarkerMatrix: new THREE.Matrix4(), // キャッシュされた最新行列
  lastSendTime: 0,
};

// ============================================================
// 2. Socket.IO
// ============================================================
let socket;

// socket.io ライブラリ(io)は room.html で動的読み込みのため、
// 定義されるまで最大5秒待ってから初期化する
function waitForIO(callback, attemptsLeft = 100) {
  if (typeof io !== 'undefined') {
    callback();
    return;
  }
  if (attemptsLeft <= 0) {
    log('socket.io ロード待ちタイムアウト(/socket.io/socket.io.js が読めていない)', 'err');
    return;
  }
  setTimeout(() => waitForIO(callback, attemptsLeft - 1), 50);
}

function initSocket() {
  try {
    const cfg = window.APP_CONFIG || {};
    const url = cfg.socketUrl || undefined; // undefined → 同一オリジン
    socket = url ? io(url, { transports: ['websocket', 'polling'] })
                 : io({ transports: ['websocket', 'polling'] });
    log('io() → ' + (url || 'same-origin'), 'ok');
    attachSocketHandlers();
  } catch (e) { log('io() 例外: ' + e.message, 'err'); }
}

waitForIO(initSocket);

function attachSocketHandlers() {
  if (!socket) return;
  socket.on('connect', () => {
    log('socket接続 ' + socket.id.slice(0, 6), 'ok');
    document.getElementById('conn-pill').classList.add('ok');
    document.getElementById('conn-text').textContent = '接続済み';
  });
  socket.on('disconnect', () => {
    document.getElementById('conn-pill').classList.remove('ok');
    document.getElementById('conn-text').textContent = '切断';
  });
  socket.on('init', ({ id, self, users }) => {
    state.myId = id;
    state.myColor = self.color;
    log(`init: 既存${Object.keys(users).length}人`);
    for (const [otherId, u] of Object.entries(users)) {
      spawnAvatar(otherId, u);
    }
    updateCount();
  });
  socket.on('join', ({ id, ...u }) => {
    log('join: ' + id.slice(0, 6));
    spawnAvatar(id, u);
    updateCount();
  });
  socket.on('pose', ({ id, x, y, z, qx, qy, qz, qw }) => {
    const a = state.avatars.get(id);
    if (!a) return;
    a.targetPos.set(x, y, z);
    a.targetQuat.set(qx, qy, qz, qw);
  });
  socket.on('leave', ({ id }) => {
    despawnAvatar(id);
    updateCount();
  });
}

// ============================================================
// 3. アバター生成
// ============================================================
function makeAvatarEntity(color) {
  const group = document.createElement('a-entity');

  const sphere = document.createElement('a-sphere');
  sphere.setAttribute('radius', AVATAR_RADIUS);
  sphere.setAttribute('material', `color: ${color}; opacity: 0.5; transparent: true; side: double`);
  group.appendChild(sphere);

  const win = document.createElement('a-plane');
  win.setAttribute('width', WINDOW_W);
  win.setAttribute('height', WINDOW_H);
  win.setAttribute('position', `0 0 ${-AVATAR_RADIUS * 0.95}`);
  win.setAttribute('material', `color: #ffffff; opacity: 0.95; side: double; emissive: ${color}; emissiveIntensity: 0.5`);
  group.appendChild(win);

  const frame = document.createElement('a-ring');
  frame.setAttribute('radius-inner', Math.min(WINDOW_W, WINDOW_H) * 0.5 * 0.95);
  frame.setAttribute('radius-outer', Math.min(WINDOW_W, WINDOW_H) * 0.5 * 1.15);
  frame.setAttribute('position', `0 0 ${-AVATAR_RADIUS * 0.95 - 0.005}`);
  frame.setAttribute('material', `color: ${color}; opacity: 0.9; side: double`);
  group.appendChild(frame);

  const arrow = document.createElement('a-cone');
  arrow.setAttribute('radius-bottom', 0.015);
  arrow.setAttribute('radius-top', 0);
  arrow.setAttribute('height', 0.04);
  arrow.setAttribute('position', `0 0 ${-AVATAR_RADIUS - 0.025}`);
  arrow.setAttribute('rotation', '-90 0 0');
  arrow.setAttribute('material', `color: ${color}`);
  group.appendChild(arrow);

  const label = document.createElement('a-text');
  label.setAttribute('value', '');
  label.setAttribute('position', `0 ${AVATAR_RADIUS + 0.05} 0`);
  label.setAttribute('align', 'center');
  label.setAttribute('color', '#ffffff');
  label.setAttribute('width', 4);
  label.setAttribute('look-at', '[camera]');
  group.appendChild(label);

  return { group, label };
}

function spawnAvatar(id, u) {
  if (state.avatars.has(id)) return;
  const others = document.getElementById('others');
  if (!others) return;

  const { group, label } = makeAvatarEntity(u.color);
  const x = u.x || 0, y = u.y || 0, z = u.z || 0;
  group.setAttribute('position', `${x} ${y} ${z}`);
  others.appendChild(group);

  const targetPos = new THREE.Vector3(x, y, z);
  const targetQuat = new THREE.Quaternion(u.qx || 0, u.qy || 0, u.qz || 0, u.qw || 1);

  group.addEventListener('loaded', () => {
    if (group.object3D) {
      group.object3D.scale.set(0.001, 0.001, 0.001);
      group.object3D.quaternion.copy(targetQuat);
    }
  });

  state.avatars.set(id, {
    el: group, label,
    color: u.color,
    targetPos, targetQuat,
    spawnedAt: performance.now(),
  });
}

function despawnAvatar(id) {
  const a = state.avatars.get(id);
  if (!a) return;
  if (a.el.parentNode) a.el.parentNode.removeChild(a.el);
  state.avatars.delete(id);
}

function updateCount() {
  document.getElementById('count').textContent = state.avatars.size + 1;
}

// ============================================================
// 4. 自分のポーズ計算・送信
// ============================================================
const tmpMat = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();

function sendMyPose() {
  if (!state.markerSeen) return;

  // latestMarkerMatrix = マーカーのカメラ空間における姿勢
  // 逆行列 = カメラ(自分)のマーカー空間における姿勢
  tmpMat.copy(state.latestMarkerMatrix).invert();
  tmpMat.decompose(tmpPos, tmpQuat, tmpScale);

  state.myPos.copy(tmpPos);
  state.myQuat.copy(tmpQuat);
  state.hasFirstPose = true;

  if (socket && socket.connected) {
    socket.emit('pose', {
      x: tmpPos.x, y: tmpPos.y, z: tmpPos.z,
      qx: tmpQuat.x, qy: tmpQuat.y, qz: tmpQuat.z, qw: tmpQuat.w,
    });
  }
}

function fmtPos(v) {
  return `${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)}`;
}

// ============================================================
// 5. メインループ
// ============================================================
function easeOutBack(t) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

const wPos = new THREE.Vector3();
const wQuat = new THREE.Quaternion();
const wScale = new THREE.Vector3();

function tick() {
  requestAnimationFrame(tick);

  // ====== マーカー追従 ======
  const marker = document.getElementById('marker');
  const world  = document.getElementById('world');

  if (marker && marker.object3D) {
    const wasVisible = state.markerVisibleNow;
    const visibleNow = marker.object3D.visible;
    state.markerVisibleNow = visibleNow;

    if (visibleNow) {
      // 検出中: 最新行列を更新
      state.latestMarkerMatrix.copy(marker.object3D.matrix);
      if (!state.markerSeen) {
        state.markerSeen = true;
        log('マーカー初検出!', 'ok');
        // worldを表示に切替
        if (world) world.setAttribute('visible', 'true');
      }
    }

    // UI: マーカー状態
    if (wasVisible !== visibleNow) {
      const pill = document.getElementById('marker-pill');
      pill.classList.toggle('ok', visibleNow);
      pill.classList.toggle('warn', !visibleNow && state.markerSeen);
      document.getElementById('marker-text').textContent =
        visibleNow ? 'マーカー検出中' :
        state.markerSeen ? 'マーカー外(直前位置を維持)' : 'マーカー未検出';
    }
  }

  // worldエンティティをlatestMarkerMatrixに同期(検出時もキャッシュ時も)
  if (state.markerSeen && world && world.object3D) {
    state.latestMarkerMatrix.decompose(wPos, wQuat, wScale);
    world.object3D.position.copy(wPos);
    world.object3D.quaternion.copy(wQuat);
    world.object3D.scale.copy(wScale);
  }

  // ====== 20Hzでポーズ送信 ======
  if (state.markerSeen) {
    const now = performance.now();
    if (now - state.lastSendTime > (1000 / POSE_SEND_HZ)) {
      state.lastSendTime = now;
      sendMyPose();
    }
  }

  // 自分位置UI
  if (state.hasFirstPose) {
    document.getElementById('my-pos').textContent = fmtPos(state.myPos);
  }

  // ====== アバター補間+ポップ+距離 ======
  const now = performance.now();
  let nearest = Infinity;

  state.avatars.forEach((a) => {
    if (!a.el.object3D) return;
    const o = a.el.object3D;

    // 位置・回転補間
    o.position.x += (a.targetPos.x - o.position.x) * 0.2;
    o.position.y += (a.targetPos.y - o.position.y) * 0.2;
    o.position.z += (a.targetPos.z - o.position.z) * 0.2;
    o.quaternion.slerp(a.targetQuat, 0.2);

    // ポップ
    const t = Math.min(1, (now - a.spawnedAt) / 700);
    const s = Math.max(0.001, easeOutBack(t));
    o.scale.set(s, s, s);

    // 距離(マーカー空間 = メートル)
    const dx = o.position.x - state.myPos.x;
    const dy = o.position.y - state.myPos.y;
    const dz = o.position.z - state.myPos.z;
    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if (dist < nearest) nearest = dist;

    if (a.label) a.label.setAttribute('value', dist.toFixed(2) + 'm');
  });

  const nearestEl = document.getElementById('nearest');
  if (nearestEl) {
    nearestEl.textContent = (state.avatars.size === 0 || !state.hasFirstPose) ? '--' : nearest.toFixed(2);
  }
}

// ============================================================
// 6. ローダー処理 & 起動
// ============================================================
function hideLoader() {
  const l = document.querySelector('.arjs-loader');
  if (l) l.style.display = 'none';
}
window.addEventListener('arjs-video-loaded', () => { log('arjs-video-loaded', 'ok'); hideLoader(); });
setTimeout(hideLoader, 3500);

function start() {
  if (typeof THREE === 'undefined') {
    log('THREE未定義', 'err');
    return;
  }
  log('起動', 'ok');

  // 床グリッド動的生成(1m間隔、20m範囲、緑の薄線)
  const grid = document.getElementById('grid');
  if (grid) {
    for (let i = -10; i <= 10; i++) {
      const lx = document.createElement('a-box');
      lx.setAttribute('position', `${i} 0.002 0`);
      lx.setAttribute('width', '0.01');
      lx.setAttribute('height', '0.002');
      lx.setAttribute('depth', '20');
      lx.setAttribute('material', 'color: #4ade80; opacity: 0.2; transparent: true');
      grid.appendChild(lx);
      const lz = document.createElement('a-box');
      lz.setAttribute('position', `0 0.002 ${i}`);
      lz.setAttribute('width', '20');
      lz.setAttribute('height', '0.002');
      lz.setAttribute('depth', '0.01');
      lz.setAttribute('material', 'color: #4ade80; opacity: 0.2; transparent: true');
      grid.appendChild(lz);
    }
  }

  const marker = document.getElementById('marker');
  if (marker) {
    marker.addEventListener('markerFound', () => log('markerFound', 'ok'));
    marker.addEventListener('markerLost',  () => log('markerLost'));
  }

  tick();
}

const scene = document.querySelector('a-scene');
if (scene?.hasLoaded) start();
else {
  scene?.addEventListener('loaded', start);
  setTimeout(() => { if (typeof THREE !== 'undefined') start(); }, 3000);
}
