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
let viewerEye = { x: 0, y: 1.5, z: 0 };

// 各周回オブジェクトの速度倍率 (1.0 = 各モデル既定速度) - master が個別に変更
let orbitSpeeds = { whale: 1.0, fox: 1.0, human: 1.0 };

io.on('connection', (socket) => {
  const color = randomColor();
  const me = {
    color,
    role: 'camera',
    lightOn: true,
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
  socket.emit('orbitSpeed', orbitSpeeds);

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

  // Master からのディスプレイ向き/オフアクシス設定 → 全クライアントへ配信
  socket.on('displayConfig', (data) => {
    const sender = users.get(socket.id);
    if (!sender || sender.role !== 'master') return;
    if (!data || typeof data.targetId !== 'string') return;
    const target = users.get(data.targetId);
    if (!target) return;
    if (typeof data.yaw === 'number') target.display.yaw = data.yaw;
    if (typeof data.pitch === 'number') target.display.pitch = data.pitch;
    if (typeof data.roll === 'number') target.display.roll = data.roll;
    if (typeof data.offaxis === 'boolean') target.display.offaxis = data.offaxis;
    io.emit('displayConfig', { id: data.targetId, display: target.display });
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

  // Master からの鯨周回速度設定
  socket.on('orbitSpeed', (data) => {
    const sender = users.get(socket.id);
    if (!sender || sender.role !== 'master') return;
    if (!data || typeof data !== 'object') return;
    if (typeof data.whale === 'number' && isFinite(data.whale)) orbitSpeeds.whale = data.whale;
    if (typeof data.fox === 'number' && isFinite(data.fox)) orbitSpeeds.fox = data.fox;
    if (typeof data.human === 'number' && isFinite(data.human)) orbitSpeeds.human = data.human;
    io.emit('orbitSpeed', orbitSpeeds);
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
