// server.js - フェーズ5 (VR背景 + マーカー追従)
// Socket.IO サーバー
//
// プロトコル:
//   - client→server 'pose' { x, y, z, qx, qy, qz, qw } (マーカー空間, メートル)
//   - server→client 'init' { id, self, users } (接続時、hasPose=trueのみ含む)
//   - server→others 'join' { id, ...pose, color } (初回pose受信時)
//   - server→others 'pose' { id, ...pose } (以降のpose更新)
//   - server→others 'leave' { id } (切断時)

const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const certsDir = path.join(__dirname, 'certs');
const certFile = path.join(certsDir, 'cert.pem');
const keyFile  = path.join(certsDir, 'key.pem');

let server, scheme;
if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
  server = https.createServer({
    cert: fs.readFileSync(certFile),
    key:  fs.readFileSync(keyFile),
  }, app);
  scheme = 'https';
} else {
  server = http.createServer(app);
  scheme = 'http';
}

// CORS: 環境変数 ALLOWED_ORIGINS (カンマ区切り) で許可するオリジンを指定可能
// 例: ALLOWED_ORIGINS="https://your-app.web.app,https://your-app.firebaseapp.com"
// 未指定なら * (開発時用)
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
  : '*';
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
  },
});
console.log('CORS allowed origins:', allowedOrigins);
app.use(express.static(path.join(__dirname, 'public')));

const users = new Map();
function randomColor() { return `hsl(${Math.floor(Math.random() * 360)}, 70%, 60%)`; }

// 壁を這う球体 (全クライアント共有)
// s: 周回パラメータ (北→東→南→西、メートル単位、0 で北壁の西端)
// y: 高さ (m)
const orbState = { s: 0, y: 2.5 };

// マルチディスプレイのオフアクシス投影用 共通視点位置
let viewerEye = { x: 0, y: 2.0, z: 0 };

// GPU 波動シミュレーション共有パラメータ (master が変更、全クライアントへ配信)
//   rippleMinM / rippleMaxM: 発生する波紋の直径 min / max (メートル)
//   waveSpeed              : 0-20 の抽象値、client 側で c² にマップ
let shaderConfig = { rippleMinM: 0.5, rippleMaxM: 1.5, waveSpeed: 12.5 };

// 各周回オブジェクトの「累積位相 (factor-秒)」「位相凍結時刻 (ms)」「現在の倍率」
//   theta(t) = phase + factor * (Date.now() - t0) / 1000     (factor-秒単位、client が baseOmega を掛けて rad/距離 にする)
//   サーバーは baseOmega を知らないが phase/t0/factor だけで完全に同期させられる。
//   全クライアントは Date.now() (絶対時刻) を共有しているのでロード開始タイミングに依らず同じ位置を計算する。
// 全クライアントが共有できる固定エポック (= Unix epoch 0)。
// 各クライアントの初期 t0 も 0 にしておけば、broadcast 受信前後で位置が飛ばない。
const ORBIT_EPOCH = 0;
let orbitState = {
  whale: { phase: 0, t0: ORBIT_EPOCH, factor: 1.0 },
  fox:   { phase: 0, t0: ORBIT_EPOCH, factor: 1.0 },
  human: { phase: 0, t0: ORBIT_EPOCH, factor: 1.0 },
};
// 後方互換: 旧 orbitSpeeds API を引き続き露出 (現在の倍率だけ)
function orbitSpeedsBroadcastObj() {
  return {
    // クライアントがサーバー時刻に同期するためのアンカー
    //   client は (serverNow - 受信時の Date.now()) でオフセットを記録し、
    //   以降の orbit 計算は (Date.now() + offset) を「サーバー時刻」として扱う
    serverNow: Date.now(),
    whale: orbitState.whale.factor, whalePhase: orbitState.whale.phase, whaleT0: orbitState.whale.t0,
    fox:   orbitState.fox.factor,   foxPhase:   orbitState.fox.phase,   foxT0:   orbitState.fox.t0,
    human: orbitState.human.factor, humanPhase: orbitState.human.phase, humanT0: orbitState.human.t0,
  };
}

io.on('connection', (socket) => {
  const color = randomColor();
  const me = {
    color,
    role: 'camera',
    lightOn: false,
    x: 0, y: 0, z: 0,
    qx: 0, qy: 0, qz: 0, qw: 1,
    hasPose: false,
    // ディスプレイ設定: クライアントが自身の物理サイズを送信、master が向きと offaxis を設定
    display: {
      width: 0.5,  // m (クライアントが上書き)
      height: 0.3, // m
      yaw: 0,      // 度
      pitch: 0,    // 度
      roll: 0,     // 度
      offaxis: false,
    },
  };
  users.set(socket.id, me);
  console.log(`[+] ${socket.id} (total=${users.size})`);

  const existing = {};
  for (const [id, u] of users.entries()) {
    if (id !== socket.id && u.hasPose) existing[id] = u;
  }
  socket.emit('init', { id: socket.id, self: me, users: existing });
  // 接続時に現在の orb 位置を送る
  socket.emit('orb', orbState);
  // 接続時に viewerEye も送る
  socket.emit('viewerEye', viewerEye);
  // 接続時に全周回オブジェクトの速度倍率を送る
  socket.emit('orbitSpeed', orbitSpeedsBroadcastObj());
  // 接続直後に現在のシェーダー設定 (波紋 min/max, 波速) を送る
  socket.emit('shaderConfig', shaderConfig);

  socket.on('orb', (data) => {
    if (typeof data.s === 'number' && typeof data.y === 'number' &&
        isFinite(data.s) && isFinite(data.y)) {
      orbState.s = data.s;
      orbState.y = data.y;
      socket.broadcast.emit('orb', orbState);
    }
  });

  socket.on('pose', (pose) => {
    const u = users.get(socket.id);
    if (!u) return;
    const wasFirst = !u.hasPose;
    if (pose.role === 'camera' || pose.role === 'observer' || pose.role === 'master') u.role = pose.role;
    if (typeof pose.x === 'number') u.x = pose.x;
    if (typeof pose.y === 'number') u.y = pose.y;
    if (typeof pose.z === 'number') u.z = pose.z;
    if (typeof pose.qx === 'number') u.qx = pose.qx;
    if (typeof pose.qy === 'number') u.qy = pose.qy;
    if (typeof pose.qz === 'number') u.qz = pose.qz;
    if (typeof pose.qw === 'number') u.qw = pose.qw;
    u.hasPose = true;

    if (wasFirst) {
      socket.broadcast.emit('join', {
        id: socket.id, color: u.color, role: u.role, lightOn: u.lightOn,
        display: u.display,
        x: u.x, y: u.y, z: u.z,
        qx: u.qx, qy: u.qy, qz: u.qz, qw: u.qw,
      });
    } else {
      socket.broadcast.emit('pose', {
        id: socket.id, role: u.role,
        x: u.x, y: u.y, z: u.z,
        qx: u.qx, qy: u.qy, qz: u.qz, qw: u.qw,
      });
    }
  });

  // 懐中電灯 ON/OFF 同期
  socket.on('light', (data) => {
    const u = users.get(socket.id);
    if (!u) return;
    if (typeof data.on === 'boolean') u.lightOn = data.on;
    socket.broadcast.emit('light', { id: socket.id, on: u.lightOn });
  });

  // クライアントから自身の物理ディスプレイサイズ報告
  socket.on('displaySize', (data) => {
    const u = users.get(socket.id);
    if (!u) return;
    if (typeof data.width === 'number' && data.width > 0) u.display.width = data.width;
    if (typeof data.height === 'number' && data.height > 0) u.display.height = data.height;
    socket.broadcast.emit('displayConfig', { id: socket.id, display: u.display });
  });

  // ディスプレイ向き / オフアクシス / サイズ 設定
  //   - master: 任意の targetId に対し他人 / 自分の display を変更可
  //   - non-master: targetId を省略 (= 自身) のみ許可
  // これでオブザーバー自身の offaxis トグルもサーバーへ反映され、その後に master が
  // controlPose+displayConfig (yaw/pitch/roll のみ) を打っても offaxis が保持される。
  socket.on('displayConfig', (data) => {
    const sender = users.get(socket.id);
    if (!sender || !data) return;
    const isMaster = (sender.role === 'master');
    const targetId = (typeof data.targetId === 'string') ? data.targetId : socket.id;
    if (!isMaster && targetId !== socket.id) return;  // 非 master は自分以外を変更不可
    const target = users.get(targetId);
    if (!target) return;
    if (typeof data.yaw === 'number') target.display.yaw = data.yaw;
    if (typeof data.pitch === 'number') target.display.pitch = data.pitch;
    if (typeof data.roll === 'number') target.display.roll = data.roll;
    if (typeof data.offaxis === 'boolean') target.display.offaxis = data.offaxis;
    if (typeof data.width === 'number' && data.width > 0) target.display.width = data.width;
    if (typeof data.height === 'number' && data.height > 0) target.display.height = data.height;
    io.emit('displayConfig', { id: targetId, display: target.display });
  });

  // Master からの viewerEye 設定
  socket.on('viewerEye', (data) => {
    const sender = users.get(socket.id);
    if (!sender || sender.role !== 'master') return;
    if (typeof data.x === 'number') viewerEye.x = data.x;
    if (typeof data.y === 'number') viewerEye.y = data.y;
    if (typeof data.z === 'number') viewerEye.z = data.z;
    io.emit('viewerEye', viewerEye);
  });

  // スプレーイベント中継 (全クライアントに同じパルスを再生させる)
  //   data = { x, y, z, dx, dy, dz, color, halfAngle, time }
  socket.on('spray', (data) => {
    if (!data || typeof data !== 'object') return;
    socket.broadcast.emit('spray', data);
  });

  // 波紋イベント中継 (GPU 波動シミュレーション用: 発生位置 + 強度 + 時刻)
  //   data = { u, v, strength, radius, time }
  //   各クライアントが同一シミュレーションを走らせるので状態全体は送らない
  socket.on('ripple', (data) => {
    if (!data || typeof data !== 'object') return;
    socket.broadcast.emit('ripple', data);
  });

  // master からのシェーダー制御設定 (波紋 min/max, 波速) → 全クライアントへ配信
  socket.on('shaderConfig', (data) => {
    const sender = users.get(socket.id);
    if (!sender || sender.role !== 'master') return;
    if (!data || typeof data !== 'object') return;
    if (typeof data.rippleMinM === 'number' && isFinite(data.rippleMinM)) {
      shaderConfig.rippleMinM = Math.max(0.05, Math.min(10, data.rippleMinM));
    }
    if (typeof data.rippleMaxM === 'number' && isFinite(data.rippleMaxM)) {
      shaderConfig.rippleMaxM = Math.max(0.1, Math.min(10, data.rippleMaxM));
    }
    if (typeof data.waveSpeed === 'number' && isFinite(data.waveSpeed)) {
      shaderConfig.waveSpeed = Math.max(0, Math.min(20, data.waveSpeed));
    }
    // min > max のときは自動スワップ
    if (shaderConfig.rippleMinM > shaderConfig.rippleMaxM) {
      const t = shaderConfig.rippleMinM;
      shaderConfig.rippleMinM = shaderConfig.rippleMaxM;
      shaderConfig.rippleMaxM = t;
    }
    io.emit('shaderConfig', shaderConfig);
  });

  // Master からの周回速度設定
  //   各倍率変更時、その時点の累積位相を凍結し新しい factor / t0 で次区間を開始する。
  //   これにより周回位置が変更前後で「飛ばず」連続し、新規参加クライアントも同じ位相を再現できる。
  socket.on('orbitSpeed', (data) => {
    const sender = users.get(socket.id);
    if (!sender || sender.role !== 'master') return;
    if (!data || typeof data !== 'object') return;
    const now = Date.now();
    function applyChange(key, newFactor) {
      const s = orbitState[key];
      if (!s) return;
      // 直前まで factor で進めた分を phase に積み上げる
      s.phase = s.phase + s.factor * (now - s.t0) / 1000;
      s.t0 = now;
      s.factor = newFactor;
    }
    if (typeof data.whale === 'number' && isFinite(data.whale)) applyChange('whale', data.whale);
    if (typeof data.fox   === 'number' && isFinite(data.fox))   applyChange('fox',   data.fox);
    if (typeof data.human === 'number' && isFinite(data.human)) applyChange('human', data.human);
    io.emit('orbitSpeed', orbitSpeedsBroadcastObj());
  });

  // Master ロールからの強制ポーズ制御 → 全クライアントへ forcePose 配信
  // 対象クライアント自身も受け取り、自分の camera をそこにスナップする
  socket.on('controlPose', (data) => {
    const sender = users.get(socket.id);
    if (!sender || sender.role !== 'master') return; // master 以外は無視
    if (!data || typeof data.targetId !== 'string') return;
    const target = users.get(data.targetId);
    if (!target) return;
    if (typeof data.x === 'number') target.x = data.x;
    if (typeof data.y === 'number') target.y = data.y;
    if (typeof data.z === 'number') target.z = data.z;
    if (typeof data.qx === 'number') target.qx = data.qx;
    if (typeof data.qy === 'number') target.qy = data.qy;
    if (typeof data.qz === 'number') target.qz = data.qz;
    if (typeof data.qw === 'number') target.qw = data.qw;
    io.emit('forcePose', {
      id: data.targetId,
      x: target.x, y: target.y, z: target.z,
      qx: target.qx, qy: target.qy, qz: target.qz, qw: target.qw,
    });
  });

  socket.on('disconnect', () => {
    const u = users.get(socket.id);
    users.delete(socket.id);
    if (u && u.hasPose) io.emit('leave', { id: socket.id });
    console.log(`[-] ${socket.id} (total=${users.size})`);
  });
});

function getLanIPs() {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return ips;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  const lanIps = getLanIPs();
  console.log(`\n  Shared VR Space (${scheme.toUpperCase()}) - フェーズ5 (VR+マーカー)`);
  console.log(`  ----------------------------`);
  console.log(`  PC:    ${scheme}://localhost:${PORT}`);
  for (const ip of lanIps) console.log(`  スマホ: ${scheme}://${ip}:${PORT}`);
  console.log('');
});
