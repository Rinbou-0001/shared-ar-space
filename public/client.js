// client.js
// 共有AR空間 最小モデル - クライアント
//
// 構成:
//   - Socket.IO で接続/座標同期(AR.js起動失敗時でも繋がる)
//   - AR.js が Hiroマーカーを検出して markerRoot.matrix を更新
//   - markerRoot.matrix の逆行列 = 自分のマーカー空間位置 → サーバーへ送信
//   - 他ユーザーのアバターは markerRoot の子として配置

const log = (msg, cls) => window.uiLog && window.uiLog(msg, cls);

// ============================================================
// 1. 共有state
// ============================================================
const state = {
  myId: null,
  myColor: '#888',
  avatars: new Map(), // id -> { group, targetX,Y,Z,Ry, spawnedAt }
  markerVisible: false,
  lastSendTime: 0,
  markerRoot: null, // Three.js初期化後にセット
};

// ============================================================
// 2. Socket.IO 接続(最優先 - AR.js失敗でも繋がるように)
// ============================================================
let socket;
try {
  socket = io();
  log('socket.io: 接続試行中...');
} catch (e) {
  log('socket.io 接続エラー: ' + e.message, 'err');
}

if (socket) {
  socket.on('connect', () => {
    log('socket.io: 接続成功 id=' + socket.id, 'ok');
    document.getElementById('conn-pill').classList.add('ok');
    document.getElementById('conn-text').textContent = '接続済み';
  });

  socket.on('disconnect', () => {
    log('socket.io: 切断', 'err');
    document.getElementById('conn-pill').classList.remove('ok');
    document.getElementById('conn-text').textContent = '切断';
  });

  socket.on('connect_error', (err) => {
    log('socket.io connect_error: ' + err.message, 'err');
  });

  socket.on('init', ({ id, self, users }) => {
    state.myId = id;
    state.myColor = self.color;
    log('init: 既存' + Object.keys(users).length + '人');
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

  socket.on('pose', ({ id, x, y, z, ry }) => {
    const a = state.avatars.get(id);
    if (!a) return;
    a.targetX = x; a.targetY = y; a.targetZ = z; a.targetRy = ry;
  });

  socket.on('leave', ({ id }) => {
    log('leave: ' + id.slice(0, 6));
    despawnAvatar(id);
    updateCount();
  });
}

// ============================================================
// 3. Three.js + AR.js セットアップ(失敗しても接続は維持)
// ============================================================
let scene, camera, renderer, arToolkitSource, arToolkitContext;

function initThreeAndAR() {
  if (typeof THREE === 'undefined') {
    log('THREE が未定義: Three.js読み込み失敗', 'err');
    return false;
  }
  if (typeof THREEx === 'undefined') {
    log('THREEx が未定義: AR.js読み込み失敗', 'err');
    return false;
  }

  scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.85));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.5);
  dirLight.position.set(1, 2, 1);
  scene.add(dirLight);

  camera = new THREE.Camera();
  scene.add(camera);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.domElement.style.position = 'absolute';
  renderer.domElement.style.top = '0';
  renderer.domElement.style.left = '0';
  document.body.appendChild(renderer.domElement);

  arToolkitSource = new THREEx.ArToolkitSource({ sourceType: 'webcam' });
  // ※ カメラ初期化は startCamera() でユーザー操作を待ってから実行する

  arToolkitContext = new THREEx.ArToolkitContext({
    cameraParametersUrl: 'https://cdn.jsdelivr.net/gh/AR-js-org/AR.js@3.4.5/data/data/camera_para.dat',
    detectionMode: 'mono',
  });
  arToolkitContext.init(() => {
    camera.projectionMatrix.copy(arToolkitContext.getProjectionMatrix());
    log('ARコンテキスト初期化完了', 'ok');
  });

  // 共通原点となるマーカーグループ
  const markerRoot = new THREE.Group();
  scene.add(markerRoot);
  state.markerRoot = markerRoot;

  new THREEx.ArMarkerControls(arToolkitContext, markerRoot, {
    type: 'pattern',
    patternUrl: 'https://cdn.jsdelivr.net/gh/AR-js-org/AR.js@3.4.5/data/data/patt.hiro',
    changeMatrixMode: 'modelViewMatrix',
  });

  // マーカー原点の可視化
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.2 })
  );
  floor.rotation.x = -Math.PI / 2;
  markerRoot.add(floor);

  window.addEventListener('resize', onResize);
  return true;
}

function onResize() {
  if (!arToolkitSource) return;
  arToolkitSource.onResizeElement();
  arToolkitSource.copyElementSizeTo(renderer.domElement);
  if (arToolkitContext.arController !== null) {
    arToolkitSource.copyElementSizeTo(arToolkitContext.arController.canvas);
  }
}

// ============================================================
// 4. アバター
// ============================================================
function makeAvatarMesh(color) {
  const group = new THREE.Group();
  const col = new THREE.Color(color);

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.4, 0.7, 0.25),
    new THREE.MeshLambertMaterial({ color: col })
  );
  body.position.y = 0.35;
  group.add(body);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 20, 20),
    new THREE.MeshLambertMaterial({ color: col })
  );
  head.position.y = 0.9;
  group.add(head);

  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.06, 0.15, 8),
    new THREE.MeshLambertMaterial({ color: 0xffffff })
  );
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 0.9, -0.25);
  group.add(nose);

  return group;
}

function spawnAvatar(id, u) {
  if (!state.markerRoot) return; // Three.js未初期化
  if (state.avatars.has(id)) return;
  const mesh = makeAvatarMesh(u.color);
  mesh.position.set(u.x || 0, u.y || 0, u.z || 0);
  mesh.rotation.y = u.ry || 0;
  mesh.scale.set(0.01, 0.01, 0.01);
  state.markerRoot.add(mesh);

  state.avatars.set(id, {
    group: mesh,
    targetX: u.x || 0,
    targetY: u.y || 0,
    targetZ: u.z || 0,
    targetRy: u.ry || 0,
    spawnedAt: performance.now(),
  });
}

function despawnAvatar(id) {
  const a = state.avatars.get(id);
  if (!a) return;
  state.markerRoot.remove(a.group);
  state.avatars.delete(id);
}

function updateCount() {
  document.getElementById('count').textContent = state.avatars.size + 1;
}

// ============================================================
// 5. ポーズ送信
// ============================================================
const tmpMat = new THREE.Matrix4 ? new THREE.Matrix4() : null;
const tmpPos = new THREE.Vector3 ? new THREE.Vector3() : null;
const tmpQuat = new THREE.Quaternion ? new THREE.Quaternion() : null;
const tmpScale = new THREE.Vector3 ? new THREE.Vector3() : null;
const tmpEuler = new THREE.Euler ? new THREE.Euler(0, 0, 0, 'YXZ') : null;

function sendMyPose() {
  if (!socket || !state.markerRoot || !tmpMat) return;
  tmpMat.copy(state.markerRoot.matrix).invert();
  tmpMat.decompose(tmpPos, tmpQuat, tmpScale);
  tmpEuler.setFromQuaternion(tmpQuat, 'YXZ');
  socket.emit('pose', {
    x: tmpPos.x,
    y: tmpPos.y,
    z: tmpPos.z,
    ry: tmpEuler.y,
  });
}

// ============================================================
// 6. ループ
// ============================================================
function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function animate() {
  requestAnimationFrame(animate);

  if (arToolkitSource && arToolkitSource.ready && arToolkitContext && state.markerRoot) {
    arToolkitContext.update(arToolkitSource.domElement);

    const visible = state.markerRoot.visible;
    if (visible !== state.markerVisible) {
      state.markerVisible = visible;
      const pill = document.getElementById('marker-pill');
      pill.classList.toggle('ok', visible);
      document.getElementById('marker-text').textContent =
        visible ? 'マーカー検出中' : 'マーカー未検出';
    }

    if (visible) {
      const now = performance.now();
      if (now - state.lastSendTime > 50) {
        state.lastSendTime = now;
        sendMyPose();
      }
    }
  }

  const now = performance.now();
  state.avatars.forEach((a) => {
    a.group.position.x += (a.targetX - a.group.position.x) * 0.18;
    a.group.position.y += (a.targetY - a.group.position.y) * 0.18;
    a.group.position.z += (a.targetZ - a.group.position.z) * 0.18;
    let dr = a.targetRy - a.group.rotation.y;
    while (dr > Math.PI) dr -= 2 * Math.PI;
    while (dr < -Math.PI) dr += 2 * Math.PI;
    a.group.rotation.y += dr * 0.18;

    const t = Math.min(1, (now - a.spawnedAt) / 600);
    const s = Math.max(0.01, easeOutBack(t));
    a.group.scale.set(s, s, s);
  });

  if (renderer && scene && camera) {
    renderer.render(scene, camera);
  }
}

// ============================================================
// 7. カメラ起動(ユーザー操作起点)
// ============================================================
function startCamera() {
  log('カメラ起動を試みます...');
  if (!arToolkitSource) {
    log('arToolkitSource 未初期化', 'err');
    return;
  }
  arToolkitSource.init(
    () => {
      log('カメラ起動コールバック', 'ok');
      setTimeout(() => {
        onResize();
        const v = arToolkitSource.domElement;
        if (v) {
          // iOS Safari 用属性を確実に付与
          v.setAttribute('playsinline', '');
          v.setAttribute('autoplay', '');
          v.setAttribute('muted', '');
          v.muted = true;
          // 再生を強制実行
          const playPromise = v.play();
          if (playPromise && playPromise.catch) {
            playPromise.catch(err => log('video.play() 失敗: ' + err.message, 'err'));
          }
          log('video: ' + v.videoWidth + 'x' + v.videoHeight, 'ok');
        } else {
          log('video element が見つかりません', 'err');
        }
      }, 800);
    },
    (err) => {
      log('カメラ起動失敗: ' + (err && err.message ? err.message : JSON.stringify(err)), 'err');
    }
  );
}

// ============================================================
// 8. 起動 - ボタンハンドラを最優先で設置(AR初期化失敗時でも反応するように)
// ============================================================
log('スクリプト実行開始');
log('THREE存在: ' + (typeof THREE !== 'undefined'));
log('THREEx存在: ' + (typeof THREEx !== 'undefined'));

const startBtn = document.getElementById('start-btn');
const overlay = document.getElementById('start-overlay');

if (!startBtn) {
  log('start-btn が見つかりません', 'err');
} else {
  log('ボタンハンドラ設置中...', 'ok');
  const handler = (ev) => {
    ev.preventDefault();
    log('「ARを開始」が押されました', 'ok');
    if (overlay) overlay.style.display = 'none';
    try {
      startCamera();
    } catch (e) {
      log('startCamera例外: ' + e.message, 'err');
    }
  };
  // click と touchend 両方を保険として登録
  startBtn.addEventListener('click', handler);
  startBtn.addEventListener('touchend', handler);
}

// AR初期化
let arInitOk = false;
try {
  arInitOk = initThreeAndAR();
} catch (e) {
  log('AR初期化例外: ' + e.message, 'err');
}

if (arInitOk) {
  log('Three.js + AR.js 初期化完了', 'ok');
  animate();
} else {
  log('AR初期化失敗 → カメラは起動できません', 'err');
}
