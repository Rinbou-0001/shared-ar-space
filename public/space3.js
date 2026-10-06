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
    scene.fog = new THREE.FogExp2(0xffffff, 0.1);

    // ========== Fog 中心切替 (効果3) ==========
    //   既定: Three.js 標準の fog = カメラからの距離に基づくフェード (アバター追従)
    //   効果3 ON: フィールド原点 (0,0,0) からの距離に基づくフェード (アバター位置不変)
    //   実装: 全マテリアルの fog_vertex を onBeforeCompile で差し替え、
    //         共有 uniform `uFogOriginMode` (0/1) で切替。
    //         Mesh/Line 系どちらも vFogDepth varying を使うので同じ差し替えで動く。
    const _uFogOriginMode = { value: 0 };
    window.__uFogOriginMode = _uFogOriginMode;
    function _patchMaterialFog(mat) {
      if (!mat || !mat.isMaterial) return;
      if (mat.userData && mat.userData.__originFogPatched) return;
      mat.userData = mat.userData || {};
      mat.userData.__originFogPatched = true;
      const prevOBC = mat.onBeforeCompile ? mat.onBeforeCompile.bind(mat) : null;
      mat.onBeforeCompile = (shader) => {
        if (prevOBC) prevOBC(shader);
        shader.uniforms.uFogOriginMode = _uFogOriginMode;
        // 頂点シェーダー: fog_vertex を差し替え
        //   ・既定 (uFogOriginMode<0.5): -mvPosition.z (= カメラ距離、Three.js 標準)
        //   ・原点モード (>=0.5):          length((modelMatrix * vec4(transformed,1)).xyz)
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uFogOriginMode;')
          .replace('#include <fog_vertex>', [
            '#ifdef USE_FOG',
            '  if (uFogOriginMode > 0.5) {',
            '    vec4 _wpFog = vec4(transformed, 1.0);',
            '    #ifdef USE_INSTANCING',
            '      _wpFog = instanceMatrix * _wpFog;',
            '    #endif',
            '    _wpFog = modelMatrix * _wpFog;',
            '    vFogDepth = length(_wpFog.xyz);',
            '  } else {',
            '    vFogDepth = -mvPosition.z;',
            '  }',
            '#endif',
          ].join('\n'));
      };
      mat.needsUpdate = true;
    }
    function _patchSceneFog() {
      scene.traverse((obj) => {
        if (!obj) return;
        if (obj.material) {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          mats.forEach(_patchMaterialFog);
        }
      });
    }
    window.__patchSceneFog = _patchSceneFog;
    function _applyFogOriginMode(wantOrigin) {
      _uFogOriginMode.value = wantOrigin ? 1 : 0;
      _patchSceneFog();   // 新しく追加されたマテリアルも含めて再走査
      try { log('fog center → ' + (wantOrigin ? 'ORIGIN (fixed)' : 'CAMERA (default)'), 'ok'); } catch (_) {}
    }
    window.__applyFogOriginMode = _applyFogOriginMode;

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

    // alpha:true にすると scene.background=null 時に canvas が透過し、下敷きの
    //   #bg-video (getUserMedia の背面カメラ映像) が透けて見える (camera role の AR モード)。
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.getElementById('stage').appendChild(renderer.domElement);

    // canvas レイアウト: canvas は常に window 全体を占有 (letterbox しない)。
    //   同期 ON/OFF はカメラ視野内で「self の視錐台 base 面が canvas をちょうど埋める」
    //   ように、self avatar 側の base 距離 (depth) を動的計算することで実現する。
    //   → 視野やアスペクトは変えず、base=canvas viewport の見え方だけを変える。
    function applyCanvasLayout() {
      const winW = window.innerWidth;
      const winH = window.innerHeight;
      camera.aspect = winW / winH;
      camera.updateProjectionMatrix();
      renderer.setSize(winW, winH);
    }

    window.addEventListener('resize', () => {
      applyCanvasLayout();
    });

    // ライト (床は白でフラットに見せるため、環境光を強めに)
    // space3 環境光: master スライダーで動的に intensity を変更可能。
    //   個別 light タグオブジェクトからの寄与とは別途、全体を底上げする AmbientLight。
    const sceneAmbient = new THREE.AmbientLight(0xffffff, 0.85);
    scene.add(sceneAmbient);
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.35);
    dirLight.position.set(10, 20, 10);
    scene.add(dirLight);

    // ========== 床: 60m × 60m at origin (白) ==========
    const FIELD_SIZE = 60;
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

    // ===== モノクロ格子表示 (恒常) =====
    //   タイル機能は廃止。1m グレー + 5m 濃グレー格子を常時表示する。
    //   AR passthrough 中は従来通り非表示に。
    const grid = new THREE.GridHelper(FIELD_SIZE, FIELD_SIZE, 0x374151, 0x6b7280);
    grid.position.set(0, 0.015, 0);
    scene.add(grid);
    const majorGrid = new THREE.GridHelper(FIELD_SIZE, FIELD_SIZE / 5, 0x1f2937, 0x1f2937);
    majorGrid.position.set(0, 0.018, 0);
    scene.add(majorGrid);
    const monoGrid = grid;             // 参照互換 (dummy)
    const monoMajorGrid = majorGrid;   // 参照互換 (dummy)
    // 60m 境界 (ほぼ黒) — 外周の 1 本枠だけ残す
    const boundary = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(FIELD_SIZE, 0.02, FIELD_SIZE)),
      new THREE.LineBasicMaterial({ color: 0x111827 })
    );
    boundary.position.set(0, 0.025, 0);
    scene.add(boundary);

    // 中心マーカー (原点確認用)
    const centerMarker = new THREE.Mesh(
      new THREE.BoxGeometry(0.15, 0.07, 0.15),
      new THREE.MeshBasicMaterial({ color: 0xc0c0c6 })
    );
    centerMarker.position.set(0, 0.035, 0);
    scene.add(centerMarker);

    // ===== 移動 Box (cube1..4) =====
    //   ・1m 立方体、物理挙動 (重力 + 床反発 + 摩擦)
    //   ・observer/master: マウス/タッチでドラッグ → XZ 平面 1m スナップ移動 (従来)
    //   ・camera (スマホ): タップで掴む/離す (phone forward の 1.5m 先に追従、離すと投げ or 落下)
    //   ・全ロールで physics tick が動く。emit された objectPose で位置は逐次上書きされる
    //   ・objectPose で全クライアント同期
    function makeMovableCube(name, x, y, z, colorHex) {
      const c = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial({
          color: colorHex, roughness: 0.8, metalness: 0.0,
        })
      );
      c.position.set(x, y, z);
      c.name = name;
      scene.add(c);
      // 選択ハイライト (黄色 edges)
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(c.geometry),
        new THREE.LineBasicMaterial({
          color: 0xfbbf24, transparent: true, opacity: 1.0,
          depthTest: false, fog: false,
        })
      );
      edges.renderOrder = 999;
      edges.visible = false;
      c.add(edges);
      // 物理状態
      c.userData.__movable = true;
      c.userData.vel    = new THREE.Vector3(0, 0, 0);   // 並進速度 m/s
      c.userData.angVel = new THREE.Vector3(0, 0, 0);   // 角速度 rad/s (world 軸)
      c.userData.held   = false;
      c.userData.mass   = 10.0;                         // 質量 kg (基準 10、空気抵抗の効きを制御)
      // Sleep システム (微振動抑制): 一定時間ほぼ静止したら物理 tick をスキップ、
      //   grab/衝突/サーバー同期で起こされる。
      c.userData.sleeping   = false;
      c.userData.restFrames = 0;
      // 掴み中の Spring-Damper 目標位置 (null で未設定)
      c.userData.targetPos  = null;
      // Ownership: 最後に掴んだクライアント socket.id (null = 未所有)
      //   ・オーナーのみ物理 tick + objectPose emit を実行
      //   ・非オーナーは受信位置を適用するだけ (ローカル物理は停止)
      //   → 複数クライアントが同じ cube を同時シミュレートする相互上書きループを防ぐ
      c.userData.ownerId    = null;
      // 初期位置 (resetSpace イベントでここに戻す)
      c.userData.initialPos = new THREE.Vector3(x, y, z);
      return c;
    }
    const cube1 = makeMovableCube('cube1',  1.5, 0.5, -0.5, 0x6b7280); // 灰
    const cube2 = makeMovableCube('cube2', -1.5, 0.5, -0.5, 0xef4444); // 赤
    const cube3 = makeMovableCube('cube3',  1.5, 0.5,  1.5, 0x22c55e); // 緑
    const cube4 = makeMovableCube('cube4', -1.5, 0.5,  1.5, 0x3b82f6); // 青
    // 追加 7 個 (原点中心 20m × 20m エリア内に散開配置、Y=0.5 = 床置き)
    const cube5  = makeMovableCube('cube5',   6.5, 0.5, -6.5, 0xf59e0b); // 橙
    const cube6  = makeMovableCube('cube6',  -6.5, 0.5, -6.5, 0xa855f7); // 紫
    const cube7  = makeMovableCube('cube7',   6.5, 0.5,  6.5, 0x14b8a6); // 青緑
    const cube8  = makeMovableCube('cube8',  -6.5, 0.5,  6.5, 0xec4899); // ピンク
    const cube9  = makeMovableCube('cube9',   0.5, 0.5, -9.5, 0xeab308); // 黄
    const cube10 = makeMovableCube('cube10', -9.5, 0.5,  0.5, 0x06b6d4); // シアン
    const cube11 = makeMovableCube('cube11',  9.5, 0.5,  0.5, 0x84cc16); // ライム
    const movableCubes = [cube1, cube2, cube3, cube4, cube5, cube6, cube7, cube8, cube9, cube10, cube11];

    // ===== スプレー描画: 原点中心 直径 20m (半径 10m) 半球 =====
    //   ・半球は透明基材 + CanvasTexture で、塗った部分だけ色が付く
    //   ・空の空間を 4 秒長押しで発射開始 → 離すと停止
    //   ・色はアバター color (state.myColor)
    //   ・入力はカメラ前方の 1 本レイで、半球にヒットした UV に円形ブラシを塗る
    //   ・送信は 10 Hz スロットル + サーバー履歴に蓄積 → 新規接続時に再生で同期
    const SPRAY_RADIUS_M = 10;
    const SPRAY_CANVAS_W = 1024;
    const SPRAY_CANVAS_H = 512;
    const SPRAY_HOLD_MS  = 4000;   // 4 秒
    const SPRAY_EMIT_HZ  = 10;     // 送信頻度
    const SPRAY_BRUSH_R  = 22;     // canvas 上のブラシ半径 (px) — ~1.4m 実寸相当
    const SPRAY_BRUSH_ALPHA = 0.35;

    const _sprayCanvas = document.createElement('canvas');
    _sprayCanvas.width  = SPRAY_CANVAS_W;
    _sprayCanvas.height = SPRAY_CANVAS_H;
    const _sprayCtx = _sprayCanvas.getContext('2d');
    _sprayCtx.clearRect(0, 0, SPRAY_CANVAS_W, SPRAY_CANVAS_H);
    const _sprayTex = new THREE.CanvasTexture(_sprayCanvas);
    _sprayTex.wrapS = THREE.RepeatWrapping;   // phi 方向 (継ぎ目を環状にする)
    _sprayTex.wrapT = THREE.ClampToEdgeWrapping;
    _sprayTex.anisotropy = 4;
    const _sprayMat = new THREE.MeshBasicMaterial({
      map: _sprayTex,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      alphaTest: 0.01,
      fog: false,
    });
    // 上半球 (theta ∈ [0, π/2])。UV は SphereGeometry 標準。
    const _sprayGeom = new THREE.SphereGeometry(SPRAY_RADIUS_M, 64, 32, 0, Math.PI * 2, 0, Math.PI / 2);
    const sprayDome = new THREE.Mesh(_sprayGeom, _sprayMat);
    sprayDome.name = 'spray-dome';
    sprayDome.renderOrder = 500;   // 他オブジェクトより後に描画 (ブレンドが正しく出るように)
    scene.add(sprayDome);
    // raycast 専用リスト (selectables とは分離 — 選択ロジックに影響させない)
    const _sprayables = [sprayDome];

    // キャンバスにブラシ 1 発描く (u,v は 0..1、color は #rrggbb or 数値)
    function _drawSprayDot(u, v, colorStr) {
      const x = u * SPRAY_CANVAS_W;
      const y = (1 - v) * SPRAY_CANVAS_H;   // three.js UV は左下原点、canvas は左上原点
      const r = SPRAY_BRUSH_R;
      const g = _sprayCtx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0.0, _sprayAlphaStr(colorStr, SPRAY_BRUSH_ALPHA));
      g.addColorStop(1.0, _sprayAlphaStr(colorStr, 0));
      _sprayCtx.fillStyle = g;
      _sprayCtx.beginPath();
      _sprayCtx.arc(x, y, r, 0, Math.PI * 2);
      _sprayCtx.fill();
      // 継ぎ目 (u ≒ 0 / 1) 対応: 近縁側にもミラー描画
      if (x < r)                       _sprayDotRaw(x + SPRAY_CANVAS_W, y, r, colorStr);
      else if (x > SPRAY_CANVAS_W - r) _sprayDotRaw(x - SPRAY_CANVAS_W, y, r, colorStr);
      _sprayTex.needsUpdate = true;
    }
    function _sprayDotRaw(x, y, r, colorStr) {
      const g = _sprayCtx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0.0, _sprayAlphaStr(colorStr, SPRAY_BRUSH_ALPHA));
      g.addColorStop(1.0, _sprayAlphaStr(colorStr, 0));
      _sprayCtx.fillStyle = g;
      _sprayCtx.beginPath();
      _sprayCtx.arc(x, y, r, 0, Math.PI * 2);
      _sprayCtx.fill();
    }
    // #rrggbb / 0xRRGGBB → rgba(r,g,b,a) 文字列
    function _sprayAlphaStr(c, alpha) {
      let hex;
      if (typeof c === 'number') hex = c;
      else if (typeof c === 'string') {
        hex = parseInt(c.replace('#', ''), 16);
      } else return 'rgba(255,255,255,' + alpha + ')';
      const r = (hex >> 16) & 0xff;
      const g = (hex >> 8) & 0xff;
      const b = hex & 0xff;
      return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
    }
    // スプレー状態 (self): press-and-hold で発射開始、release で停止
    const _spraySelf = {
      pressStartT: 0,          // press 開始時刻 (ms)、0 = press 中でない
      armed: false,            // 4 秒経過して発射中か
      lastEmitT: 0,            // 直近送信時刻
    };
    const _sprayRay = new THREE.Raycaster();
    const _sprayOrigin = new THREE.Vector3();
    const _sprayDir    = new THREE.Vector3();
    // tick から呼ばれる (updaters 経由)。_spraySelf.pressStartT > 0 の間動く。
    function _sprayTick() {
      if (!_spraySelf.pressStartT) return;
      const now = performance.now();
      const held = now - _spraySelf.pressStartT;
      if (held < SPRAY_HOLD_MS) return;
      if (!_spraySelf.armed) {
        _spraySelf.armed = true;
        log('spray armed (4s hold)', 'ok');
      }
      // 送信スロットル
      if (now - _spraySelf.lastEmitT < 1000 / SPRAY_EMIT_HZ) return;
      _spraySelf.lastEmitT = now;
      // カメラ前方レイで半球にヒット → UV 取得 → 塗る + emit
      camera.getWorldPosition(_sprayOrigin);
      camera.getWorldDirection(_sprayDir);
      _sprayRay.set(_sprayOrigin, _sprayDir);
      const hits = _sprayRay.intersectObjects(_sprayables, false);
      if (hits.length === 0 || !hits[0].uv) return;
      const uv = hits[0].uv;
      const colorHex = (state.myColor || '#ffffff').replace('#', '');
      _drawSprayDot(uv.x, uv.y, '#' + colorHex);
      if (socket && socket.connected) {
        socket.emit('spray', { u: +uv.x.toFixed(4), v: +uv.y.toFixed(4), c: colorHex });
      }
    }

    // selectables: raycast 対象。movable cube 全部を含める。
    const selectables = [...movableCubes];
    let selectedObject = null;
    // Box 表示 (observer avatar の box オブジェクト + 格子 + 選択ハイライト) の ON/OFF フラグ。
    //   ・false: box.visible = false + avatar 選択枠 (apex/base edges) も強制非表示
    //   ・true : box.visible = true + 選択枠は選択状態に応じて表示
    //   ・light オブジェクトの選択枠 (__isAvatarEdge を持たない) は影響を受けない
    //   ・入室時は OFF にして、必要に応じて obs-box-toggle で手動 ON する運用。
    let boxVisibilityEnabled = false;

    // ============================================================
    // シーンオブジェクト (master が右クリックメニューで生成する光源等)
    //   sceneLightObjects: id → { obj, sphere, light, config, tags, edgesLine }
    //   ・sphere : 選択可能な 2cm 透明球体 (marker)、selectables に登録
    //   ・light  : タグに 'light' があれば AmbientLight を scene に配置 (position は無関係)
    //   ・edges  : 選択時のオレンジ枠 (isLineSegments 子として sphere に付ける)
    // ============================================================
    const sceneLightObjects = new Map();
    function makeSceneObject(o) {
      // o: { id, type, tags, x, y, z, config: { intensity } }
      const id = o.id;
      const tags = (o.tags || []).slice();
      const cfg = Object.assign({ intensity: 0.5 }, o.config || {});
      const grp = new THREE.Group();
      grp.name = 'scene-' + id;
      grp.position.set(o.x || 0, o.y || 0, o.z || 0);
      // 直径 2cm = 半径 0.01m、透明 (opacity 0.15 で微かに視認可能)
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.01, 20, 12),
        new THREE.MeshBasicMaterial({
          color: 0xffffff, transparent: true, opacity: 0.15,
          depthWrite: false, fog: false,
        })
      );
      sphere.name = 'light-' + id;
      sphere.userData.sceneObjectId = id;
      sphere.userData.tags = tags.slice();
      grp.add(sphere);
      // オレンジ選択枠: isLineSegments 子として付けると selectObject が可視/不可視を toggle する。
      //   ・sphere 本体 (2cm) は小さいので、球ラップと大円リング (直径 6cm) の両方を用意し
      //     近距離/遠距離のどちらでも明確に見えるようにする。
      //   ・depthTest:false + renderOrder:999 で他オブジェクトの手前に常に描画。
      const orangeMat = new THREE.LineBasicMaterial({
        color: 0xff8c00, transparent: true, opacity: 1.0,
        depthTest: false, fog: false, linewidth: 2,
      });
      // 内側の wireframe ラップ (球体本体を包む)
      const edges = new THREE.LineSegments(
        new THREE.WireframeGeometry(new THREE.SphereGeometry(0.013, 12, 8)),
        orangeMat
      );
      edges.renderOrder = 999;
      edges.visible = false;
      sphere.add(edges);
      // 大きめの選択オーラ (3 本の大円: XY / XZ / YZ)、半径 3cm
      const RING_R = 0.03;
      const RING_SEG = 64;
      function makeRing(planeNormal) {
        const pts = [];
        for (let i = 0; i < RING_SEG; i++) {
          const a0 = (i     / RING_SEG) * Math.PI * 2;
          const a1 = ((i+1) / RING_SEG) * Math.PI * 2;
          let p0, p1;
          if (planeNormal === 'z') {           // XY 平面
            p0 = [Math.cos(a0)*RING_R, Math.sin(a0)*RING_R, 0];
            p1 = [Math.cos(a1)*RING_R, Math.sin(a1)*RING_R, 0];
          } else if (planeNormal === 'y') {    // XZ 平面
            p0 = [Math.cos(a0)*RING_R, 0, Math.sin(a0)*RING_R];
            p1 = [Math.cos(a1)*RING_R, 0, Math.sin(a1)*RING_R];
          } else {                              // YZ 平面
            p0 = [0, Math.cos(a0)*RING_R, Math.sin(a0)*RING_R];
            p1 = [0, Math.cos(a1)*RING_R, Math.sin(a1)*RING_R];
          }
          pts.push(...p0, ...p1);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        return new THREE.LineSegments(g, orangeMat);
      }
      const ringXY = makeRing('z');
      const ringXZ = makeRing('y');
      const ringYZ = makeRing('x');
      [ringXY, ringXZ, ringYZ].forEach((r) => {
        r.renderOrder = 999;
        r.visible = false;
        sphere.add(r);
      });
      // PointLight (light タグ付きの時のみ、オブジェクト位置から放射する光源)
      //   ・grp の子として付けるので grp.position の移動に追従
      //   ・distance=20m (床全体をカバー)、decay=1 (線形減衰、扱いやすい)
      let light = null;
      if (tags.indexOf('light') >= 0) {
        light = new THREE.PointLight(0xffffff, cfg.intensity, 20, 1);
        light.position.set(0, 0, 0); // grp のローカル原点 = sphere と同位置
        grp.add(light);
      }
      // master は常時 border を表示 (light オブジェクトの位置を常に把握できるように)
      //   ・edges + 3 リングを visible=true にし、__alwaysVisible フラグ付けで
      //     selectObject の deselect 時にも非表示にならないようマーク。
      if (ROLE === 'master' && tags.indexOf('light') >= 0) {
        [edges, ringXY, ringXZ, ringYZ].forEach((ls) => {
          ls.visible = true;
          ls.userData.__alwaysVisible = true;
        });
      }
      scene.add(grp);
      selectables.push(sphere);
      const rec = { id, tags, config: cfg, grp, sphere, light };
      sceneLightObjects.set(id, rec);
      return rec;
    }
    function updateSceneObjectConfig(id, config) {
      const rec = sceneLightObjects.get(id);
      if (!rec) return;
      if (config && typeof config.intensity === 'number') {
        rec.config.intensity = Math.max(0, Math.min(1, config.intensity));
        if (rec.light) rec.light.intensity = rec.config.intensity;
      }
    }
    function removeSceneObject(id) {
      const rec = sceneLightObjects.get(id);
      if (!rec) return;
      const idx = selectables.indexOf(rec.sphere);
      if (idx >= 0) selectables.splice(idx, 1);
      if (selectedObject === rec.sphere) selectObject(null);
      if (rec.light) scene.remove(rec.light);
      scene.remove(rec.grp);
      sceneLightObjects.delete(id);
    }
    const CUBE_STEP = 1.0;
    const CUBE_HALF = 0.5;   // 1m キューブ半分 = 床上面までの距離
    // ドラッグ移動感度 (px / 1m)。master が変更 → server 経由で全クライアントへ配信される
    let moveSensitivity = 60;
    function selectObject(obj) {
      if (selectedObject === obj) return;
      // 選択枠は子孫の LineSegments (isLineSegments===true) 全てを対象。
      //   ・apex/base hit は 1 個の LineSegments、light sphere は 4 個
      //   ・traverse で全 descendant を toggle
      function _toggleEdges(target, on) {
        if (!target) return;
        target.traverse((n) => {
          if (!n.isLineSegments) return;
          // __alwaysVisible フラグ (master の light border 等) は選択解除で消さない
          if (n.userData && n.userData.__alwaysVisible) { n.visible = true; return; }
          // Box表示 OFF の間は avatar 選択枠 (__isAvatarEdge) を出さない
          if (n.userData && n.userData.__isAvatarEdge && !boxVisibilityEnabled) {
            n.visible = false; return;
          }
          n.visible = on;
        });
      }
      _toggleEdges(selectedObject, false);
      selectedObject = obj;
      if (obj) {
        _toggleEdges(obj, true);
        log('select: ' + (obj.name || '(unnamed)'), 'ok');
      } else {
        log('deselect', 'ok');
      }
      updateSelectionHint();
    }
    function updateSelectionHint() {
      const el = document.getElementById('obs-sel-info');
      if (el) el.textContent = selectedObject ? selectedObject.name : '--';
    }

    // ========================================================
    // 物理シミュレーション (cube1..4 の重力/床反発/摩擦)
    //   ・全ロール共通で tick 毎に更新
    //   ・held=true (掴まれ中) はスキップ (位置は grabber が制御)
    //   ・cube 底面 y = center.y - 0.5 が床 (y=0) に触れる時: 反発 + 摩擦
    //   ・object の外周が field を越えたら弾性壁で戻す
    // ========================================================
    const GRAVITY = 9.81;
    const REST_COEFF = 0.35;   // 床反発
    const CUBE_HALF_Y = 0.5;
    // 空気抵抗係数 (kg/m): 抵抗力 F = k · |v|·v、加速度 = F/m
    //   ・軽い (mass 小) → 抵抗の効きが強く落下ゆっくり (羽のようにフラフラ)
    //   ・重い (mass 大) → 抵抗の効きが弱く落下速い (鉛玉のように直落)
    //   終端速度 v_term = sqrt(g · m / k):
    //     m=0.1: ~4.4 m/s   m=1: ~14 m/s   m=10: ~44 m/s
    const AIR_DRAG = 0.05;
    // 簡易剛体力学パラメータ:
    //   ・CUBE_INERTIA_FACTOR = L²/6 (1m 立方体の慣性モーメント係数)
    //     → 実効 I = mass × 1/6
    //   ・FRICTION_COEFF = Coulomb 摩擦係数 (接触点の tangent 方向の impulse 上限)
    //     ・前回の velocity 減衰 0.90 → 実効 μ ~0.3 相当 → 倍増して μ = 0.6
    //   ・ANGULAR_DAMP = 空気抵抗 (回転)、1 frame 毎
    const CUBE_INERTIA_FACTOR = 1 / 6;
    const FRICTION_COEFF = 0.6;
    const ANGULAR_DAMP = 0.995;
    // 掴み中 (held) の Spring-Damper 係数 (質量比例)
    //   ・k_eff = SPRING_K_PER_KG × mass, d_eff = SPRING_DAMPING_PER_KG × mass
    //   ・加速度 a = (k·(target-pos) - d·v) / m = SPRING_K_PER_KG·x - SPRING_DAMPING_PER_KG·v
    //     → 質量が変わっても追従感・振り感は一定 (ω = sqrt(k/m) = sqrt(SPRING_K_PER_KG) ≈ 5.5 rad/s、周期 ~1.1s)
    //   ・ζ = SPRING_DAMPING_PER_KG / (2·sqrt(SPRING_K_PER_KG)) ≈ 0.55 (弱振動 = ほどよい振り返し)
    const SPRING_K_PER_KG = 45;   // 22.5 × 2: 引っ張り力を 2 倍に
    const SPRING_DAMPING_PER_KG = 6;
    const SPRING_VEL_CAP = 20;    // 速度上限 m/s (発散防止)
    const _phys_lastEmit = new Map();   // name → last emit ms
    function _emitCubePoseThrottled(cube, forceMs) {
      if (!socket || !socket.connected) return;
      // Ownership guard: 自分がオーナーの時のみ emit (未所有 null でも emit しない)
      //   → 初期状態 (ownerId=null、誰も掴んでいない) では一切 emit されず、
      //     複数クライアントが同じ cube の位置を競合送信して往復する問題が消滅。
      //     cubes は決定論的な初期物理 (同じ初期条件 → 同じ settling) でローカル一致。
      if (cube.userData.ownerId !== myId) return;
      const now = performance.now();
      const last = _phys_lastEmit.get(cube.name) || 0;
      const interval = (typeof forceMs === 'number') ? forceMs : 33; // 30Hz
      if (now - last < interval) return;
      _phys_lastEmit.set(cube.name, now);
      socket.emit('objectPose', {
        name: cube.name,
        x: cube.position.x, y: cube.position.y, z: cube.position.z,
        qx: cube.quaternion.x, qy: cube.quaternion.y, qz: cube.quaternion.z, qw: cube.quaternion.w,
      });
    }
    // 剛体力学用の一時変数 (allocation 削減)
    const _phTmpV1 = new THREE.Vector3();
    const _phTmpV2 = new THREE.Vector3();
    const _phTmpMat = new THREE.Matrix4();
    const _phUpY   = new THREE.Vector3(0, 1, 0);
    const _phZero  = new THREE.Vector3(0, 0, 0);
    const _phTmpV3 = new THREE.Vector3();
    const _phTmpV4 = new THREE.Vector3();
    const _phTmpQ  = new THREE.Quaternion();
    const _phNormal = new THREE.Vector3(0, 1, 0);
    // 1m 立方体の 8 頂点 (local coord) と world 回転済みキャッシュ
    const _cubeCorners = [
      new THREE.Vector3(-0.5,-0.5,-0.5), new THREE.Vector3(+0.5,-0.5,-0.5),
      new THREE.Vector3(-0.5,+0.5,-0.5), new THREE.Vector3(+0.5,+0.5,-0.5),
      new THREE.Vector3(-0.5,-0.5,+0.5), new THREE.Vector3(+0.5,-0.5,+0.5),
      new THREE.Vector3(-0.5,+0.5,+0.5), new THREE.Vector3(+0.5,+0.5,+0.5),
    ];
    const _rotatedCorners = [];
    for (let i = 0; i < 8; i++) _rotatedCorners.push(new THREE.Vector3());
    const _phCentroid = new THREE.Vector3();

    // 入力 quaternion に最も近い軸整列 (24 cardinal rotations) を見つけて outQuat に書き込む。
    //   立方体の対称性から 24 通りの rotation が同じ外見 (面着地)。
    //   実装簡略化: 現在の rotation 行列から各 face 法線が world ±Y に最も近いペアを選び、
    //   そこから最も近い yaw 90° stepping で spin を snap。
    const _snapM = new THREE.Matrix4();
    const _snapE = new THREE.Euler();
    function _snapToNearestCardinal(curQuat, outQuat) {
      _snapM.makeRotationFromQuaternion(curQuat);
      _snapE.setFromRotationMatrix(_snapM, 'YXZ');
      // Yaw/Pitch/Roll を π/2 単位にスナップ
      const q = Math.PI / 2;
      const snap = (x) => Math.round(x / q) * q;
      _snapE.y = snap(_snapE.y);
      _snapE.x = snap(_snapE.x);
      _snapE.z = snap(_snapE.z);
      outQuat.setFromEuler(_snapE);
    }

    // 微振動抑制 (sleep) 閾値
    //   ・resting-contact の short-circuit で v.y がゼロ化された後、
    //     水平摩擦と角速度減衰で全成分が小さくなった時 sleep へ遷移。
    //   ・閾値は "重力 1 フレーム分の v.y 累積 (~0.16 m/s)" を少し超える値に設定し、
    //     resting 中は毎フレーム法線成分がゼロ化されるので余裕を持って sleep に乗る。
    const SLEEP_LIN2 = 0.04;      // |v|² < 0.04 → |v| < 0.2 m/s
    const SLEEP_ANG2 = 0.04;      // |ω|² < 0.04 → |ω| < 0.2 rad/s
    const SLEEP_HOLD_FRAMES = 12; // 連続安定フレーム数
    function _wakeCube(c) {
      if (c && c.userData) {
        c.userData.sleeping = false;
        c.userData.restFrames = 0;
      }
    }
    function _physicsTick(dt) {
      for (const c of movableCubes) {
        // Ownership チェック: 他クライアントが所有している cube の物理はスキップ
        //   (受信した位置を描画するだけ、ローカルシミュレーションしない → 競合消失)
        const owner = c.userData.ownerId;
        if (owner && owner !== myId) continue;
        const v  = c.userData.vel;
        const av = c.userData.angVel;
        const mass = c.userData.mass || 1.0;
        // held: Spring-Damper で targetPos へ引っ張る (アームの先端 → バネ紐 → 物体)
        //   ・v += ((k·x - d·v) / m) · dt、ただし k/m と d/m は定数化
        //   ・gravity は加え続ける (紐で吊るされてわずかに垂れる)
        //   ・float しないよう速度上限クランプ
        //   ・床衝突は held でも実行 (下にぶつかればゴリゴリこする)
        if (c.userData.held) {
          const t = c.userData.targetPos;
          if (t) {
            // 効果4 (しなりモード): 2 段ばね + 低剛性 K
            //   ・OFF: 従来通り targetPos へダイレクト Spring-Damper (K=45)
            //   ・ON : heldAnchor が targetPos へ遅延追従 (1 段目) → heldAnchor へ Spring (2 段目、K=25)
            //          → 手首を振るほど cube が「遅れて」ついてくる = しなり & 遠心力的な弧
            const whippy = !!(window.__effect && window.__effect[4]);
            let anchor = t;
            let springK = SPRING_K_PER_KG;
            if (whippy) {
              springK = 25;
              if (!c.userData.heldAnchor) c.userData.heldAnchor = c.position.clone();
              // alpha は dt 依存: 時定数 τ ≈ 0.1s → α = 1 - exp(-dt/τ)
              const alpha = 1 - Math.exp(-dt / 0.1);
              c.userData.heldAnchor.lerp(t, alpha);
              anchor = c.userData.heldAnchor;
            } else {
              c.userData.heldAnchor = null;
            }
            _phTmpV1.copy(anchor).sub(c.position).multiplyScalar(springK);     // k/m · x
            _phTmpV2.copy(v).multiplyScalar(-SPRING_DAMPING_PER_KG);           // -d/m · v
            _phTmpV1.add(_phTmpV2);                                            // 加速度 (m/s²)
            v.addScaledVector(_phTmpV1, dt);
          }
          v.y -= GRAVITY * dt;
          // 発散防止: 速度上限
          if (v.length() > SPRING_VEL_CAP) v.setLength(SPRING_VEL_CAP);
          c.position.addScaledVector(v, dt);
          // 効果4 ON: cube の向きを速度方向へ緩やかに slerp (しなり視覚効果)
          //   ・|v| が小さい時は追従しない (静止時のガタつき防止)
          //   ・up = +Y 固定で lookAt 行列から quaternion を導出
          if (window.__effect && window.__effect[4] && v.lengthSq() > 0.5) {
            _phTmpV1.copy(v).normalize();
            // local -Z (forward) を v 方向へ向ける → lookAt(eye=0, target=-v, up=+Y)
            _phTmpMat.lookAt(_phZero, _phTmpV2.copy(_phTmpV1).negate(), _phUpY);
            _phTmpQ.setFromRotationMatrix(_phTmpMat);
            c.quaternion.slerp(_phTmpQ, 0.08);
          }
          _resolveFloorContactRigid(c, dt);
          // 壁反発
          if (c.position.x >  FIELD_HALF - CUBE_HALF_Y) { c.position.x =  FIELD_HALF - CUBE_HALF_Y; v.x = -v.x * 0.5; }
          if (c.position.x < -FIELD_HALF + CUBE_HALF_Y) { c.position.x = -FIELD_HALF + CUBE_HALF_Y; v.x = -v.x * 0.5; }
          if (c.position.z >  FIELD_HALF - CUBE_HALF_Y) { c.position.z =  FIELD_HALF - CUBE_HALF_Y; v.z = -v.z * 0.5; }
          if (c.position.z < -FIELD_HALF + CUBE_HALF_Y) { c.position.z = -FIELD_HALF + CUBE_HALF_Y; v.z = -v.z * 0.5; }
          continue;
        }
        if (c.userData.sleeping) continue;   // sleep 中は tick 全スキップ
        // 重力
        v.y -= GRAVITY * dt;
        // 空気抵抗 (質量が大きいほど効きが弱い)
        const sp = v.length();
        if (sp > 0.01) {
          const dragMag = AIR_DRAG * sp * sp / mass;
          _phTmpV1.copy(v).normalize().multiplyScalar(-dragMag * dt);
          v.add(_phTmpV1);
        }
        // 位置更新
        c.position.addScaledVector(v, dt);
        // 回転更新 (quaternion integration、world 軸基準角速度)
        if (av.lengthSq() > 1e-6) {
          const angSp = av.length();
          _phTmpV1.copy(av).divideScalar(angSp);
          _phTmpQ.setFromAxisAngle(_phTmpV1, angSp * dt);
          c.quaternion.premultiply(_phTmpQ).normalize();
          av.multiplyScalar(ANGULAR_DAMP);   // 空気抵抗
        }
        // 床接地 (簡易剛体: 最下頂点検出 + 法線反力 + Coulomb 摩擦 + トルク)
        _resolveFloorContactRigid(c, dt);
        // 場所範囲: FIELD_HALF (10m) 壁で反発 (center ベース、簡易)
        if (c.position.x >  FIELD_HALF - CUBE_HALF_Y) { c.position.x =  FIELD_HALF - CUBE_HALF_Y; v.x = -v.x * 0.5; }
        if (c.position.x < -FIELD_HALF + CUBE_HALF_Y) { c.position.x = -FIELD_HALF + CUBE_HALF_Y; v.x = -v.x * 0.5; }
        if (c.position.z >  FIELD_HALF - CUBE_HALF_Y) { c.position.z =  FIELD_HALF - CUBE_HALF_Y; v.z = -v.z * 0.5; }
        if (c.position.z < -FIELD_HALF + CUBE_HALF_Y) { c.position.z = -FIELD_HALF + CUBE_HALF_Y; v.z = -v.z * 0.5; }
        // Sleep 判定: ほぼ静止が連続した時 sleep フラグ ON → tick 全スキップ
        if (v.lengthSq() < SLEEP_LIN2 && av.lengthSq() < SLEEP_ANG2) {
          c.userData.restFrames++;
          if (c.userData.restFrames >= SLEEP_HOLD_FRAMES) {
            c.userData.sleeping = true;
            v.set(0, 0, 0);
            av.set(0, 0, 0);
          }
        } else {
          c.userData.restFrames = 0;
        }
      }
      // Box-Box 衝突判定 + 分離
      _resolveCubeCollisions();
      // 動いていれば objectPose emit (throttle 30Hz)
      for (const c of movableCubes) {
        if (c.userData.vel.lengthSq() > 0.0001 || c.userData.angVel.lengthSq() > 1e-4) {
          _emitCubePoseThrottled(c);
        }
      }
    }

    // 床接地 (剛体力学): 回転 cube が床に当たった時、
    //   ・8 頂点の worldY を計算 → min y に近い (0.01m 以内) 頂点全ての centroid を
    //     "有効 pivot" とすることで、面接触=4corners→centroid が面中央 (0,-0.5,0) で安定、
    //     辺接触=2corners→辺中央で一軸トルク→面に倒れる、角接触=1corner→強トルクで倒れる。
    //   ・最下点を 0 まで押し戻し + 法線反力 + Coulomb 摩擦 + 重力 couple トルクを適用
    //   ・θ ≈ 面水平 で angVel ≈ 0 の時は orientation snap で axis-aligned にスナップ
    function _resolveFloorContactRigid(cube, dt) {
      const mass = cube.userData.mass || 1.0;
      const I = mass * CUBE_INERTIA_FACTOR;
      const v  = cube.userData.vel;
      const av = cube.userData.angVel;
      const CONTACT_TOL = 0.01;
      // 8 頂点を world 回転適用、キャッシュに保存。最下点 minY を記録。
      let minY = Infinity;
      for (let k = 0; k < 8; k++) {
        _rotatedCorners[k].copy(_cubeCorners[k]).applyQuaternion(cube.quaternion);
        const worldY = cube.position.y + _rotatedCorners[k].y;
        if (worldY < minY) minY = worldY;
      }
      if (minY >= 0) return;
      // 床突き抜け補正: 最下点が y=0 になるよう center を押し上げ
      cube.position.y -= minY;
      // 接触する頂点 (minY + CONTACT_TOL 以内) の centroid を有効 pivot とする
      _phCentroid.set(0, 0, 0);
      let contactCount = 0;
      for (let k = 0; k < 8; k++) {
        const worldY = cube.position.y + _rotatedCorners[k].y;
        if (worldY <= (0 + CONTACT_TOL)) {
          _phCentroid.add(_rotatedCorners[k]);
          contactCount++;
        }
      }
      if (contactCount === 0) return;
      _phCentroid.divideScalar(contactCount);
      const r = _phCentroid;   // 接触点 - center のオフセット (world 座標)
      // 接触点速度 = v_center + ω × r
      _phTmpV2.copy(av).cross(r);
      _phTmpV3.copy(v).add(_phTmpV2);
      const vn = _phTmpV3.dot(_phNormal);
      if (vn >= 0) return;   // 既に離れる方向
      // ====== 静止接触 short-circuit (微振動抑制 + 角立ち転倒) ======
      //   ・centroid pivot により face 接触では r.x=r.z=0 → couple トルク=0 → 振動なし
      //   ・edge/corner 接触では r.x または r.z ≠ 0 → couple トルクで面着地へ転倒
      if (minY > -0.01 && vn > -0.5) {
        // 法線成分ゼロ化 (重力累積キャンセル)
        _phTmpV2.copy(_phNormal).multiplyScalar(vn);
        v.sub(_phTmpV2);
        v.multiplyScalar(0.80);
        // 重力 couple トルク Δω = (r × F_up) / I · dt
        _phTmpV2.set(0, mass * GRAVITY, 0);
        _phTmpV4.copy(r).cross(_phTmpV2);
        av.addScaledVector(_phTmpV4, dt / I);   // ← dt 掛け忘れを修正 (以前 60× overdrive)
        av.multiplyScalar(0.90);
        // ★ Orientation snap: contact が複数 corners (面 or 辺) で角速度ほぼ 0 の時、
        //   最寄の axis-aligned 向きへゆっくり補間 → 傾いた固定を解消
        if (contactCount >= 2 && av.lengthSq() < 0.05) {
          _phTmpQ.copy(cube.quaternion);
          // 最寄 cardinal (XYZ 軸整列) quaternion を探し、slerp で近づける
          _snapToNearestCardinal(cube.quaternion, _phTmpQ);
          cube.quaternion.slerp(_phTmpQ, Math.min(1.0, dt * 6.0));
        }
        return;
      }
      // 法線 impulse
      _phTmpV2.copy(r).cross(_phNormal);        // r × n
      const inertialN = _phTmpV2.dot(_phTmpV2) / I;
      const j = -(1 + REST_COEFF) * vn / (1 / mass + inertialN);
      _phTmpV4.copy(_phNormal).multiplyScalar(j);  // normal impulse
      v.addScaledVector(_phTmpV4, 1 / mass);
      _phTmpV2.copy(r).cross(_phTmpV4);
      av.addScaledVector(_phTmpV2, 1 / I);
      // 摩擦 (tangent 方向、Coulomb)
      _phTmpV2.copy(_phNormal).multiplyScalar(vn);
      _phTmpV3.sub(_phTmpV2);                     // v_tangential
      const vtLen = _phTmpV3.length();
      if (vtLen > 0.001) {
        _phTmpV3.divideScalar(vtLen).negate();     // tangent unit (opposing)
        _phTmpV2.copy(r).cross(_phTmpV3);
        const inertialT = _phTmpV2.dot(_phTmpV2) / I;
        const jtMax = FRICTION_COEFF * j;
        const jtNeeded = vtLen / (1 / mass + inertialT);
        const jt = Math.min(jtMax, jtNeeded);
        _phTmpV4.copy(_phTmpV3).multiplyScalar(jt);
        v.addScaledVector(_phTmpV4, 1 / mass);
        _phTmpV2.copy(r).cross(_phTmpV4);
        av.addScaledVector(_phTmpV2, 1 / I);
      }
      // 微小振動抑制 (静止判定)
      if (v.lengthSq() < 0.001 && av.lengthSq() < 0.01) {
        v.set(0, 0, 0);
        av.set(0, 0, 0);
      }
    }
    // AABB (軸整列) 衝突判定 — cube1..4 は 1×1×1 の立方体で回転なし
    //   ・重なりが 3 軸すべてにある時、最小侵入軸で押し離す
    //   ・両方 free: 半分ずつ押し離し + 速度弾性反射 (係数 0.7)
    //   ・片方 held: held を動かさず、free 側を全量押し離し + 速度反転で跳ね返す
    function _resolveCubeCollisions() {
      for (let i = 0; i < movableCubes.length; i++) {
        for (let j = i + 1; j < movableCubes.length; j++) {
          const a = movableCubes[i], b = movableCubes[j];
          const dx = b.position.x - a.position.x;
          const dy = b.position.y - a.position.y;
          const dz = b.position.z - a.position.z;
          const ox = 1 - Math.abs(dx);
          const oy = 1 - Math.abs(dy);
          const oz = 1 - Math.abs(dz);
          if (ox <= 0 || oy <= 0 || oz <= 0) continue;
          // 最小侵入軸を選択
          let ax = 'x', min = ox, d = dx;
          if (oy < min) { ax = 'y'; min = oy; d = dy; }
          if (oz < min) { ax = 'z'; min = oz; d = dz; }
          const sign = d >= 0 ? 1 : -1;
          const va = a.userData.vel, vb = b.userData.vel;
          const aHeld = a.userData.held, bHeld = b.userData.held;
          if (aHeld && bHeld) continue;   // 両方保持中は無視
          if (aHeld && !bHeld) {
            b.position[ax] += min * sign;
            vb[ax] = Math.abs(vb[ax]) * sign * 0.5;
            _wakeCube(b);
          } else if (!aHeld && bHeld) {
            a.position[ax] -= min * sign;
            va[ax] = -Math.abs(va[ax]) * sign * 0.5;
            _wakeCube(a);
          } else {
            const half = (min / 2) * sign;
            a.position[ax] -= half;
            b.position[ax] += half;
            // 弾性: 相対速度を反射 (係数 0.7)
            const tmp = va[ax];
            va[ax] = vb[ax] * 0.7;
            vb[ax] = tmp * 0.7;
            _wakeCube(a); _wakeCube(b);
          }
          // ★ 対策 1 + 3: 垂直積み重ね時の摩擦 + 重力累積キャンセル
          //   ・ax === 'y' = 垂直衝突 (積み重ね)
          //   ・top/bottom を dy の符号で判定 (dy > 0 なら b が上)
          //   ・top cube の v.y を 0 寄せ (重力累積で下方向に加速してしまうのを抑制)
          //   ・両 cube の XZ 速度を減衰 (タンジェント摩擦) → 横滑りを防ぐ
          //   ・角速度も減衰
          if (ax === 'y') {
            const STACK_FRICTION = 0.80;
            const STACK_ANG_DAMP = 0.85;
            va.x *= STACK_FRICTION; va.z *= STACK_FRICTION;
            vb.x *= STACK_FRICTION; vb.z *= STACK_FRICTION;
            a.userData.angVel.multiplyScalar(STACK_ANG_DAMP);
            b.userData.angVel.multiplyScalar(STACK_ANG_DAMP);
            // 重力累積キャンセル: top cube の下方向 v.y をゼロに近づける
            //   (床の resting-contact short-circuit と同等の効果を cube-cube で実現)
            if (dy > 0) {
              // b が上 → b の下方向 v.y をキャンセル
              if (vb.y < 0) vb.y = 0;
            } else {
              // a が上 → a の下方向 v.y をキャンセル
              if (va.y < 0) va.y = 0;
            }
          }
        }
      }
    }

    // ========================================================
    // Grab / Release (camera role: スマホでタップして掴む・離す)
    //   ・_heldCube: 現在掴んでいる cube (最大 1 個)
    //   ・held 中は毎フレーム camera.position + forward * GRAB_DIST に位置更新
    //   ・release 時に直前フレームからの Δpos/Δt で初速を計算 (1.4倍で投げる感)
    //   ・emit は throttle 30Hz、release 時は force emit
    // ========================================================
    const GRAB_DIST = 1.5;      // 掴んだ物を保持するデフォルト距離 (m)
    const GRAB_DIST_MIN = 0.5;  // スワイプ調整の下限 (m)
    const GRAB_DIST_MAX = 10;   // スワイプ調整の上限 (m)
    const GRAB_DIST_SENS = 0.015; // スワイプの Δy (px) → 距離 (m) の変換係数
    // 勢いスワイプ投擲の閾値と倍率
    //   ・|swipeVel| (px/s) がこの値を超えたら touchend 時に奥 (camera forward) へ投げる
    //   ・|swipeVel| × SWIPE_THROW_SCALE_M_PER_PX が初速 (m/s)、上限 SPRING_VEL_CAP
    const SWIPE_THROW_THRESHOLD_PX_PER_S = 1200;
    const SWIPE_THROW_SCALE_M_PER_PX = 0.005;
    const RELEASE_BOOST = 1.4;
    let _heldCube = null;
    function grabCube(cube) {
      if (!cube || cube.userData.held) return;
      cube.userData.held = true;
      // Ownership を自分に設定 (他クライアントに emit で伝達 → 二重シミュを防ぐ)
      cube.userData.ownerId = myId;
      cube.userData.vel.set(0, 0, 0);
      cube.userData.angVel.set(0, 0, 0);
      // targetPos を現在位置で seed (grab 瞬間の "引っ張り" を 0 からスタート、テレポ防止)
      if (!cube.userData.targetPos) cube.userData.targetPos = new THREE.Vector3();
      cube.userData.targetPos.copy(cube.position);
      // アーム長 = 掴んだ瞬間のアバターからの距離を保持 (clamp)。以後 _heldTick で
      //   target = camera + forward · grabDist に設定され、cube はこの距離を維持。
      //   camera role は後からスワイプで距離を変更可能 (cubeAdjust 内で grabDist を更新)。
      const d = cube.position.distanceTo(camera.position);
      cube.userData.grabDist = Math.max(GRAB_DIST_MIN, Math.min(GRAB_DIST_MAX, d));
      cube.userData._prevPos  = cube.position.clone();
      cube.userData._prevQuat = cube.quaternion.clone();
      cube.userData._prevTime = performance.now();
      _wakeCube(cube);   // sleep 解除
      _heldCube = cube;
      // Ownership transfer を即時 broadcast (専用イベント cubeOwnership)
      //   他クライアントが受信 → ownerId を自分以外に設定 → 物理+emit 停止
      if (socket && socket.connected) {
        socket.emit('cubeOwnership', { name: cube.name, owner: myId });
      }
      // 掴み後の初回 pose を force emit (遅延なく位置同期)
      _emitCubePoseThrottled(cube, 0);
      log('grab: ' + cube.name + ' dist=' + cube.userData.grabDist.toFixed(2) + 'm', 'ok');
    }
    // quaternion 差分 → 角速度 (Vector3, XYZ 軸周り rad/s) を近似
    function _quatDeltaToAngVel(qFrom, qTo, dt) {
      const qInv = qFrom.clone().invert();
      const qDelta = qTo.clone().multiply(qInv);   // = qTo * qFrom^-1
      // Euler XYZ で近似
      const e = new THREE.Euler().setFromQuaternion(qDelta, 'XYZ');
      return new THREE.Vector3(e.x, e.y, e.z).divideScalar(Math.max(0.001, dt));
    }
    function releaseCube(cube) {
      if (!cube || !cube.userData.held) return;
      const now = performance.now();
      const prevQ = cube.userData._prevQuat;
      const dt = Math.max(0.001, (now - (cube.userData._prevTime || now)) / 1000);
      // vel は Spring-Damper で既に自然な速度が積分されているのでそのまま継続。
      //   釣竿を振って離すような動作で vel が大きければそのまま飛ぶ。
      //   極端値だけクランプ。
      if (cube.userData.vel.length() > SPRING_VEL_CAP) cube.userData.vel.setLength(SPRING_VEL_CAP);
      // angVel は spring 対象外 (quaternion を rigid に camera 追従していたため)。
      //   quaternion delta から計算 → RELEASE_BOOST 倍 (手首フリック)
      if (prevQ) {
        const av = _quatDeltaToAngVel(prevQ, cube.quaternion, dt);
        av.multiplyScalar(RELEASE_BOOST);
        if (av.length() > 15) av.setLength(15);
        cube.userData.angVel.copy(av);
      }
      cube.userData.held = false;
      cube.userData.targetPos = null;    // spring 目標解除
      _wakeCube(cube);
      _heldCube = null;
      _emitCubePoseThrottled(cube, 0);
      log('release: ' + cube.name +
          ' vel=' + cube.userData.vel.length().toFixed(2) + 'm/s' +
          ' angVel=' + cube.userData.angVel.length().toFixed(2) + 'rad/s', 'ok');
    }
    function _heldTick(dt) {
      // 旧 camera 専用の "camera 前方へ cube を固定追従" 機能は廃止。
      //   camera (スマホ) も observer/master と同じく _pressCheck 内で
      //   レイヒット点を targetPos に設定する方式に統一。
      //   関数は updaters から呼ばれるため no-op として残置。
      return;
    }
    // space3: 移動機能撤去 (選択のみ)。以下 snapAndClamp/moveSelected/emitObjectPose は
    //   関数定義は残すが呼び出しは削除済み。参照は起きないので事実上デッドコード。
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
    // space3: 移動機能は撤去。Escape で選択解除のみ。
    window.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
      if (e.code === 'Escape') {
        selectObject(null);
        e.preventDefault();
      }
    });

    // ========== 他クライアントのアバター管理 ==========
    // avatars: id → { grp, mesh, color, role }
    //   space3: observer ロールのアバターは "視錐台" ワイヤ (apex→base 4 隅 + base 矩形)
    //     ・入室時 (avatar 生成時) の myDisplay.width/height を「描画領域」として参照
    //     ・apex = 頭 (avatar 位置)、base = 視線 forward 方向に FRUSTUM_DEPTH m 先、W×H の矩形
    //     ・他ロール (camera / master) は従来の色付き球体 (直径 15cm)
    //     ・視錐台は color で塗り、fog: false で遠くでも見える
    const FRUSTUM_DEPTH = 0.5;   // apex ↔ 矩形 の距離 (m) — depthOverride/FOV が未指定時のフォールバック
    // self 用 apex 距離 override (FOV 由来): null = computeApexDepth を使用
    let SELF_FRUSTUM_DEPTH = null;
    // 矩形 (W×H) が垂直/水平 FOV に収まる距離を camera.fov から算出
    //   d = min( H/(2 tan(vfov/2)), W/(2 tan(hfov/2)) )
    //   camera 未初期化時は FRUSTUM_DEPTH にフォールバック
    function computeApexDepth(W, H) {
      try {
        const vfov = (camera.fov || 60) * Math.PI / 180;
        const asp  = camera.aspect || (window.innerWidth / Math.max(1, window.innerHeight));
        const hfov = 2 * Math.atan(Math.tan(vfov / 2) * asp);
        const dV = H / (2 * Math.tan(vfov / 2));
        const dH = W / (2 * Math.tan(hfov / 2));
        const d = Math.min(dV, dH);
        return (isFinite(d) && d > 0.02) ? d : FRUSTUM_DEPTH;
      } catch (_) {
        return FRUSTUM_DEPTH;
      }
    }
    // 視錐台レイアウト計算 (効果2 で切替):
    //   mode OFF (既定、Canvas-plane モード):
    //     ・base (= Canvas 相当の矩形、物理 W×H) at Z=0 (= avatar 位置)
    //     ・apex at Z=+d (背後、仮想観測点、d = FOV で base を内接させる距離)
    //   mode ON (案 A、実視点モード):
    //     ・apex at Z=0 (= avatar 位置 = 実際の camera.position)
    //     ・base at Z=-D (forward 方向、D m 前方)
    //     ・base サイズは camera.fov と camera.aspect から導出: 2D·tan(hfov/2) × 2D·tan(vfov/2)
    //       → Canvas の縦横比に一致し、実レンダリングの視錐台と apex・形状が揃う
    function _computeFrustumLayout(W, H, depthOverride) {
      const modeA = !!(window.__effect && window.__effect[2]);
      if (modeA) {
        const vfov = (camera.fov || 60) * Math.PI / 180;
        const asp  = camera.aspect || (window.innerWidth / Math.max(1, window.innerHeight));
        const hfov = 2 * Math.atan(Math.tan(vfov / 2) * asp);
        const D = (typeof depthOverride === 'number' && depthOverride > 0)
          ? depthOverride : computeApexDepth(W, H);
        const bhw = D * Math.tan(hfov / 2);
        const bhh = D * Math.tan(vfov / 2);
        return {
          modeA: true,
          apexZ: 0,
          baseZ: -D,
          baseHW: bhw,
          baseHH: bhh,
          baseW: bhw * 2,
          baseH: bhh * 2,
          D,
        };
      }
      const d = (typeof depthOverride === 'number' && depthOverride > 0)
        ? depthOverride : computeApexDepth(W, H);
      return {
        modeA: false,
        apexZ: +d,
        baseZ: 0,
        baseHW: W * 0.5,
        baseHH: H * 0.5,
        baseW: W,
        baseH: H,
        D: d,
      };
    }
    function makeAvatarFrustum(color, W, H, depthOverride) {
      const c = new THREE.Color(color || '#fbbf24');
      const L = _computeFrustumLayout(W, H, depthOverride);
      const bl = [-L.baseHW, -L.baseHH, L.baseZ];
      const br = [+L.baseHW, -L.baseHH, L.baseZ];
      const tl = [-L.baseHW, +L.baseHH, L.baseZ];
      const tr = [+L.baseHW, +L.baseHH, L.baseZ];
      const apex = [0, 0, L.apexZ];
      const p = [];
      // apex → 各矩形 隅 (4 稜線)
      p.push(...apex, ...bl);   p.push(...apex, ...br);
      p.push(...apex, ...tl);   p.push(...apex, ...tr);
      // 矩形の 4 辺 (= Canvas 枠)
      p.push(...bl, ...br);   p.push(...br, ...tr);
      p.push(...tr, ...tl);   p.push(...tl, ...bl);
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
      const mat = new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: 0.9, fog: false });
      const lines = new THREE.LineSegments(geom, mat);
      lines.frustumCulled = false;
      lines.userData.__frustumParams = { W, H, D: L.D, modeA: L.modeA };
      return lines;
    }
    const APEX_CUBE_SIZE = 0.01;   // 1cm 立方体 = apex 選択判定域

    // observer avatar の box 生成
    //   ・寸法: W × H × D  (D = W/2)
    //   ・前壁 (z = -FRUSTUM_DEPTH、apex 側)  = 視錐台底面と重複 → 生成しない (透過)
    //   ・後壁 + 上下左右壁 = 実体オブジェクト (白 MeshBasicMaterial、DoubleSide、不透明)
    //   ・全内面に 3cm × 3cm の格子 LineSegments を貼付 (壁より僅かに内側にオフセット)
    //   ・12 稜線 (別壁との接辺) に border LineSegments (黒)
    function makeAvatarBox(color, W, H, depthOverride, hasHole) {
      const grp = new THREE.Group();
      grp.name = 'avatar-box';
      const D = W / 2;
      const frontDist = (typeof depthOverride === 'number' && depthOverride > 0) ? depthOverride : FRUSTUM_DEPTH;
      // hole_test タグが付いた時、奥壁中心に半径 = H/4 (=直径 H/2) の円形穴を開ける
      const HOLE_RADIUS = hasHole ? (H * 0.25) : 0;
      const CELL = 0.03;   // 3cm 格子

      // 壁: 白の不透明面 (両面描画 = 内外どちらから見ても白い実体)
      //   MeshLambertMaterial に変更: 拡散光 (Ambient + Directional + 各 light 球) の
      //   影響を受けるので、環境光スライダー / 光源球の intensity 変化に応じて明暗が変わる。
      //   ・ambient=1.0 → ほぼ真っ白  ・ambient=0.0 → 真っ黒
      //   ・DirectionalLight (10,20,10) により上壁と下壁で自然な明るさの違い (陰影) が付く
      const wallMat = new THREE.MeshLambertMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
        fog: false,
      });
      // 内面格子: 中グレー
      const GRID_COLOR   = 0x6b7280;
      const BORDER_COLOR = 0x111827;

      // 2D 格子生成 (原点中心 XY 平面、局所座標)
      //   holeR > 0 の時は中心の半径 holeR 円内部を除外
      //   ・垂直線 (x = const): |x| >= holeR → 全部描画
      //                          |x| <  holeR → y ∈ [-√(r²-x²), +√(r²-x²)] を除外
      //   ・水平線 (y = const): 同様
      function makeGridLines(w, h, cell, colorHex, holeR) {
        const positions = [];
        const HR = (holeR > 0) ? holeR : 0;
        const HR2 = HR * HR;
        function addSeg(x0, y0, x1, y1) {
          positions.push(x0, y0, 0,  x1, y1, 0);
        }
        // 垂直線 (x = const, y から -h/2 ..+h/2)
        const nx = Math.max(1, Math.round(w / cell));
        for (let i = 0; i <= nx; i++) {
          const x = -w/2 + i * cell;
          if (HR > 0 && Math.abs(x) < HR) {
            const yh = Math.sqrt(HR2 - x * x);
            // 上 (+): +yh から +h/2
            if (+yh < +h/2) addSeg(x, +yh, x, +h/2);
            // 下 (-): -h/2 から -yh
            if (-yh > -h/2) addSeg(x, -h/2, x, -yh);
          } else {
            addSeg(x, -h/2, x, +h/2);
          }
        }
        // 水平線 (y = const)
        const ny = Math.max(1, Math.round(h / cell));
        for (let j = 0; j <= ny; j++) {
          const y = -h/2 + j * cell;
          if (HR > 0 && Math.abs(y) < HR) {
            const xh = Math.sqrt(HR2 - y * y);
            if (+xh < +w/2) addSeg(+xh, y, +w/2, y);
            if (-xh > -w/2) addSeg(-w/2, y, -xh, y);
          } else {
            addSeg(-w/2, y, +w/2, y);
          }
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        return new THREE.LineSegments(
          geom,
          new THREE.LineBasicMaterial({ color: colorHex, transparent: true, opacity: 0.75, fog: false })
        );
      }

      // ShapeGeometry で長方形壁 (オプション: 中心に円形穴)。
      //   ・hole=0 なら通常の矩形 (PlaneGeometry と同等)
      //   ・hole>0 なら中心に穴 → 穴の向こう側は透過して背景が見える
      function makeWallGeom(pw, ph, holeRadius) {
        const shape = new THREE.Shape();
        shape.moveTo(-pw / 2, -ph / 2);
        shape.lineTo(+pw / 2, -ph / 2);
        shape.lineTo(+pw / 2, +ph / 2);
        shape.lineTo(-pw / 2, +ph / 2);
        shape.lineTo(-pw / 2, -ph / 2);
        if (holeRadius > 0 && holeRadius < Math.min(pw, ph) * 0.5) {
          const hole = new THREE.Path();
          hole.absarc(0, 0, holeRadius, 0, Math.PI * 2, false);
          shape.holes.push(hole);
        }
        return new THREE.ShapeGeometry(shape, 64);
      }

      // 1 面 (壁 + 内面格子) を作って grp に加える
      //   pw × ph: 面のローカル寸法
      //   pos:     面中心の box-local 位置
      //   rot:     面の姿勢 (ローカル +Z が box の内側を向くように設定)
      //   opt.holeRadius: 面中心の円形穴半径 (0 = 穴なし)
      //   opt.isBack:     稜線 border に穴の輪郭を追加するか
      function addWall(pw, ph, pos, rot, opt) {
        const holeR = (opt && opt.holeRadius) || 0;
        const g = new THREE.Group();
        // 壁 mesh (ShapeGeometry で穴対応)
        const wall = new THREE.Mesh(makeWallGeom(pw, ph, holeR), wallMat);
        g.add(wall);
        // 内面格子 (壁の +Z 方向 = 内側へ 0.5mm オフセット → z-fighting 回避)
        //   holeR > 0 の時は格子線も円内部で除外
        const grid = makeGridLines(pw, ph, CELL, GRID_COLOR, holeR);
        grid.position.z = 0.0005;
        g.add(grid);
        // 穴の輪郭 (border color) を面の内側にも描いておく (視覚的な明示)
        if (holeR > 0) {
          const seg = 64;
          const pts = [];
          for (let i = 0; i < seg; i++) {
            const a0 = (i     / seg) * Math.PI * 2;
            const a1 = ((i+1) / seg) * Math.PI * 2;
            pts.push(Math.cos(a0)*holeR, Math.sin(a0)*holeR, 0.0005);
            pts.push(Math.cos(a1)*holeR, Math.sin(a1)*holeR, 0.0005);
          }
          const ring = new THREE.LineSegments(
            new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)),
            new THREE.LineBasicMaterial({ color: BORDER_COLOR, fog: false })
          );
          g.add(ring);
        }
        g.position.copy(pos);
        g.rotation.copy(rot);
        grp.add(g);
      }

      // 新コード: 矩形 (= avatar 位置、Z=0 の前壁相当) から -Z (forward) 方向へ D m 延びる箱
      //   前壁 (Z=0) = 矩形 → 透過。後壁 Z=-D、側壁は zMid = -D/2 中心。
      //   frontDist パラメータは API 互換のため受け付けるが、新規配置では使用しない。
      void frontDist;
      const zBack = -D;
      const zMid  = -D * 0.5;

      // 5 面 (前壁を除く)。すべて「ローカル +Z が box 内側」になるよう rotation を選択:
      //   ・後壁: rot=(0,0,0)      → +Z 内側 = +Z 世界 (=apex 側)
      //   ・上壁: rot.x=+π/2       → +Z 内側 = -Y 世界 (=下へ)
      //   ・下壁: rot.x=-π/2       → +Z 内側 = +Y 世界 (=上へ)
      //   ・左壁: rot.y=+π/2       → +Z 内側 = +X 世界 (=右へ)
      //   ・右壁: rot.y=-π/2       → +Z 内側 = -X 世界 (=左へ)
      // 後壁は hasHole 時のみ穴付き ShapeGeometry。
      addWall(W, H, new THREE.Vector3(0,      0,     zBack), new THREE.Euler( 0,             0, 0), { holeRadius: HOLE_RADIUS, isBack: true }); // 後壁
      addWall(W, D, new THREE.Vector3(0,   +H/2,     zMid),  new THREE.Euler( +Math.PI/2,    0, 0));     // 上壁
      addWall(W, D, new THREE.Vector3(0,   -H/2,     zMid),  new THREE.Euler( -Math.PI/2,    0, 0));     // 下壁
      addWall(D, H, new THREE.Vector3(-W/2,   0,     zMid),  new THREE.Euler( 0,   +Math.PI/2, 0));      // 左壁
      addWall(D, H, new THREE.Vector3(+W/2,   0,     zMid),  new THREE.Euler( 0,   -Math.PI/2, 0));      // 右壁
      // 前壁 (zFront) は視錐台底面と重複するため生成しない (透過)

      // 12 稜線 border (別壁との接辺、box 全体の輪郭)
      const borderGeom = new THREE.EdgesGeometry(new THREE.BoxGeometry(W, H, D));
      const borderMat  = new THREE.LineBasicMaterial({ color: BORDER_COLOR, fog: false });
      const borders    = new THREE.LineSegments(borderGeom, borderMat);
      borders.position.set(0, 0, zMid);
      grp.add(borders);
      // 奥壁の穴の輪郭 (box 外側から見た時の縁取り)
      if (HOLE_RADIUS > 0) {
        const seg = 64;
        const pts = [];
        for (let i = 0; i < seg; i++) {
          const a0 = (i     / seg) * Math.PI * 2;
          const a1 = ((i+1) / seg) * Math.PI * 2;
          pts.push(Math.cos(a0)*HOLE_RADIUS, Math.sin(a0)*HOLE_RADIUS, 0);
          pts.push(Math.cos(a1)*HOLE_RADIUS, Math.sin(a1)*HOLE_RADIUS, 0);
        }
        const ring = new THREE.LineSegments(
          new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)),
          new THREE.LineBasicMaterial({ color: BORDER_COLOR, fog: false })
        );
        ring.position.set(0, 0, zBack);
        grp.add(ring);
      }

      grp.userData.__boxDims = { W, H, D, CELL };
      return grp;
    }

    // observer avatar の全構成要素を作る: frustum ワイヤ + apex/base hit mesh + 各 highlight edges + box
    //   ・apex hit: 1cm 立方体、透明 (raycast 用)、子に橙 edges を持ち選択時のみ visible
    //   ・base hit: W×H 平面、透明 (raycast 用)、子に黄 edges を持ち選択時のみ visible
    //   ・box: W×H×(W/2) の 5 面 (前壁=frustum base を透過)
    //   ・userData: {selectType: 'apex'|'base', avatarId, avatarObj}
    function makeObserverFrustumMeshes(color, W, H, id, depthOverride, hasHole, omitBox) {
      const L = _computeFrustumLayout(W, H, depthOverride);
      const frustumLines = makeAvatarFrustum(color, W, H, depthOverride);

      // apex hit (raycast 用透明立方体)
      //   mode OFF: avatar 位置から +Z (背後) 方向 d m
      //   mode A  : avatar 位置そのもの (= 実視点)
      const apexHit = new THREE.Mesh(
        new THREE.BoxGeometry(APEX_CUBE_SIZE, APEX_CUBE_SIZE, APEX_CUBE_SIZE),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
      );
      apexHit.position.set(0, 0, L.apexZ);
      apexHit.name = 'avatar-apex-hit';
      apexHit.userData.selectType = 'apex';
      apexHit.userData.avatarId = id;
      const apexEdges = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(APEX_CUBE_SIZE, APEX_CUBE_SIZE, APEX_CUBE_SIZE)),
        new THREE.LineBasicMaterial({ color: 0xff8c00, transparent: true, opacity: 1.0, depthTest: false, fog: false, linewidth: 2 })
      );
      apexEdges.renderOrder = 999;
      apexEdges.visible = false;
      apexEdges.userData.__isAvatarEdge = true;
      apexHit.add(apexEdges);

      // base hit (raycast 用透明平面)
      //   mode OFF: W×H (物理ディスプレイサイズ) at Z=0
      //   mode A  : fov 由来のサイズ at Z=-D (前方)
      const baseHit = new THREE.Mesh(
        new THREE.PlaneGeometry(L.baseW, L.baseH),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide })
      );
      baseHit.position.set(0, 0, L.baseZ);
      baseHit.name = 'avatar-base-hit';
      baseHit.userData.selectType = 'base';
      baseHit.userData.avatarId = id;
      const baseEdges = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.PlaneGeometry(L.baseW, L.baseH)),
        new THREE.LineBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 1.0, depthTest: false, fog: false, linewidth: 2 })
      );
      baseEdges.renderOrder = 999;
      baseEdges.visible = false;
      baseEdges.userData.__isAvatarEdge = true;
      baseHit.add(baseEdges);

      // box は「アバターのロール」が camera (スマホ) の時のみ生成しない。
      //   mode A では apex が avatar 位置なので従来の box 配置 (base 前方) と自然に整合する。
      //   box geometry 自体は mode に関わらず W×H×W/2 のまま (modeA でも物理サイズを維持)。
      const box = omitBox ? null : makeAvatarBox(color, W, H, L.D, !!hasHole);
      return { frustumLines, apexHit, apexEdges, baseHit, baseEdges, box };
    }

    const avatars = new Map();
    // display: {width, height} — サーバー join/init/displayConfig で運ばれてくる
    //   remote client の物理ディスプレイサイズ。observer frustum の base 寸法として使う。
    //   未指定なら local myDisplay をフォールバック
    function makeAvatar(id, color, role, display) {
      const grp = new THREE.Group();
      grp.userData.__avatarId = id;
      // entryTag: 入室順 (#1,#2,...) — server が付与。customTags: master が付与。
      const av = { grp, color: color || '#ffffff', role: role || 'camera', entryTag: null, customTags: [] };
      // frustum を描くのは:
      //   ・observer ロール (全クライアントで表示、通常機能)
      //   ・camera ロール + local ROLE が master (master にのみ視錐台として表示)
      const wantsFrustum = (role === 'observer')
                        || (role === 'camera' && ROLE === 'master');
      av._hasFrustum = wantsFrustum;
      if (wantsFrustum) {
        const dW = (display && typeof display.width  === 'number' && display.width  > 0)
          ? display.width  : (myDisplay.width  || 0.3);
        const dH = (display && typeof display.height === 'number' && display.height > 0)
          ? display.height : (myDisplay.height || 0.2);
        // 初期生成時点で hole 情報は未確定 (customTags は後から入る場合が多い) — false で作り、
        //   tag 受信 or displayConfig 受信で rebuildAvatarFrustum が正しい hasHole で作り直す。
        //   omitBox = 対象アバターが camera ロール (スマホ) の時 true。閲覧側の ROLE は無関係。
        const omitBox = (role === 'camera');
        const parts = makeObserverFrustumMeshes(av.color, dW, dH, id, null, false, omitBox);
        av.frustumLines = parts.frustumLines;
        av.apexHit  = parts.apexHit;  av.apexEdges = parts.apexEdges;
        av.baseHit  = parts.baseHit;  av.baseEdges = parts.baseEdges;
        av.box      = parts.box;
        av.mesh     = parts.frustumLines;   // 後方互換 (mesh フィールド)
        av.remoteDisplay = { width: dW, height: dH };   // 効果2 切替時の再構築用
        // 視錐台ワイヤー: master は常に表示 (Box表示トグルと独立)、他は Box トグルに従う
        parts.frustumLines.visible = (ROLE === 'master') ? true : boxVisibilityEnabled;
        grp.add(parts.frustumLines);
        grp.add(parts.apexHit);
        grp.add(parts.baseHit);
        // box は camera role では null。observer / master のみ scene に追加。
        //   Box 表示トグル (boxVisibilityEnabled) が OFF なら非表示で追加。
        if (parts.box) {
          parts.box.visible = boxVisibilityEnabled;
          grp.add(parts.box);
        }
        // selectables 登録 (raycast 対象、master 側のみ実質的に使う)
        selectables.push(parts.apexHit);
        selectables.push(parts.baseHit);
        try {
          log('frustum init: ' + role + ' ' + id.substring(0,6) + ' ' +
              dW.toFixed(3) + '×' + dH.toFixed(3) + 'm ' +
              (display ? '(remote)' : '(fallback)') +
              (role === 'camera' ? ' [master-only view]' : ''), 'ok');
        } catch (_) {}
      } else {
        av.mesh = new THREE.Mesh(
          new THREE.SphereGeometry(0.15, 24, 16),
          new THREE.MeshStandardMaterial({ color: color || '#ffffff', roughness: 0.6 })
        );
        grp.add(av.mesh);
      }
      // ---- スマホ (camera role): 姿勢センサー由来の 3D レイ ----
      //   ・camera.quaternion は setupDeviceOrientation により phone の実姿勢を反映
      //   ・grp.quaternion は毎フレーム camera pose と同期 (tick 内)
      //   ・スマホの「上方向」(端末の top edge = local +Y) を基準に、
      //     avatar 位置 (apex, grp 原点) から +Y 方向へ 5m の Line を伸ばす
      if (role === 'camera') {
        const ray = makeAvatarPointerRay(av.color);
        av.pointer = ray;
        grp.add(ray);
      }
      scene.add(grp);
      // 効果3 (fog 原点固定) が ON の場合、新規マテリアルも patch
      if (typeof _patchSceneFog === 'function') _patchSceneFog();
      return av;
    }

    // スマホの上方向を基準にした 3D レイ (LineSegments)。
    //   ・原点 (0,0,0) = apex (avatar 位置)
    //   ・終点 (0, +DIST, 0) = 端末上方向 (local +Y) → grp.quaternion で world 変換
    //   ・fog:false で遠くでも視認可能
    function makeAvatarPointerRay(color) {
      const c = new THREE.Color(color || '#ff4444');
      const DIST = 5.0;
      const pts = new Float32Array([0, 0, 0,  0, DIST, 0]);
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      const line = new THREE.Line(
        geom,
        new THREE.LineBasicMaterial({
          color: c, transparent: true, opacity: 0.9, fog: false,
        })
      );
      line.name = 'avatar-pointer-ray';
      return line;
    }

    // observer 用アバターの hit mesh を selectables から取り除く (leave/rebuild 時)
    function _removeAvatarSelectables(a) {
      if (!a) return;
      [a.apexHit, a.baseHit].forEach((m) => {
        if (!m) return;
        const idx = selectables.indexOf(m);
        if (idx >= 0) selectables.splice(idx, 1);
        // 選択中なら解除
        if (selectedObject === m) selectObject(null);
      });
    }
    // observer avatar のサブメッシュ全 dispose
    function _disposeAvatarSubMeshes(a) {
      ['frustumLines','apexHit','apexEdges','baseHit','baseEdges'].forEach((k) => {
        const n = a[k];
        if (!n) return;
        if (n.parent) n.parent.remove(n);
        if (n.geometry) n.geometry.dispose();
        if (n.material) {
          if (Array.isArray(n.material)) n.material.forEach((mm) => mm.dispose());
          else n.material.dispose();
        }
        a[k] = null;
      });
      // box は Group なので子孫を辿って dispose
      if (a.box) {
        if (a.box.parent) a.box.parent.remove(a.box);
        a.box.traverse((n) => {
          if (n.geometry) n.geometry.dispose();
          if (n.material) {
            if (Array.isArray(n.material)) n.material.forEach((mm) => mm.dispose());
            else n.material.dispose();
          }
        });
        a.box = null;
      }
    }

    // 既存 avatar の frustum + hit mesh を作り直し (displayConfig / tag 変化時)
    //   depthOverride: self avatar (canvas 同期 ON) の base 距離を上書きするために渡す
    //   hasHole は avatar.customTags から derive
    function rebuildAvatarFrustum(id, display, depthOverride) {
      const a = avatars.get(id);
      if (!a) { log('rebuild frustum: avatar ' + id.substring(0,6) + ' 未生成、スキップ', 'err'); return; }
      // observer 常時、camera は local ROLE が master の時のみ (_hasFrustum フラグ判定)
      if (!a._hasFrustum) return;
      if (!display) return;
      const dW = (typeof display.width  === 'number' && display.width  > 0) ? display.width  : 0.3;
      const dH = (typeof display.height === 'number' && display.height > 0) ? display.height : 0.2;
      const hasHole = !!(a.customTags && a.customTags.indexOf('hole_test') >= 0);
      _removeAvatarSelectables(a);
      _disposeAvatarSubMeshes(a);
      const omitBox = (a.role === 'camera');
      const parts = makeObserverFrustumMeshes(a.color, dW, dH, id, depthOverride, hasHole, omitBox);
      a.frustumLines = parts.frustumLines;
      a.apexHit = parts.apexHit;  a.apexEdges = parts.apexEdges;
      a.baseHit = parts.baseHit;  a.baseEdges = parts.baseEdges;
      a.box     = parts.box;
      a.mesh    = parts.frustumLines;
      a.remoteDisplay = { width: dW, height: dH };   // 効果2 切替時の再構築用
      // 視錐台ワイヤー: master は常に表示 (Box表示トグルと独立)
      parts.frustumLines.visible = (ROLE === 'master') ? true : boxVisibilityEnabled;
      a.grp.add(parts.frustumLines);
      a.grp.add(parts.apexHit);
      a.grp.add(parts.baseHit);
      // box は camera role では null。observer / master のみ追加 (Box表示 OFF 時は不可視で保持)。
      if (parts.box) {
        parts.box.visible = boxVisibilityEnabled;
        a.grp.add(parts.box);
      }
      selectables.push(parts.apexHit);
      selectables.push(parts.baseHit);
      // 効果3 (fog 原点固定) 対応: 再構築で生成された新マテリアルも patch
      if (typeof _patchSceneFog === 'function') _patchSceneFog();
      const dTag = (typeof depthOverride === 'number' && depthOverride > 0) ? (' D=' + depthOverride.toFixed(3) + 'm') : '';
      const hTag = hasHole ? ' [hole]' : '';
      log('frustum rebuilt: ' + id.substring(0,6) + ' → ' + dW.toFixed(3) + '×' + dH.toFixed(3) + 'm' + dTag + hTag, 'ok');
    }
    function ensureAvatar(id, color, role, display) {
      let a = avatars.get(id);
      if (!a) {
        a = makeAvatar(id, color, role, display);
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
    // 手動編集フラグ: obs-display-w/h をユーザーが変更した後は自動値で上書きしない
    let _displaySizeManuallyEdited = false;

    // 視錐台 base + box に使う "実効表示サイズ" (canvas 物理サイズ)。
    //   ・入室時 と フルスクリーン切替 (fullscreenchange) 時にのみ再計算
    //   ・他のイベント (対角+解像度入力、W/H 手入力) では変わらない
    //   ・計算: canvas_css × (myDisplay / screen_css) = canvas 物理サイズ (m)
    let effectiveDisplaySize = { width: 0.30, height: 0.20 };
    // canvas 同期モード: ON なら resize/DPR 変化のたびに base/box を再計算 (フルスクリーン、
    // ウィンドウリサイズ、モニタ移動を追跡)。OFF なら init + fullscreenchange の 2 タイミングのみ。
    let canvasSyncEnabled = false;
    function computeEffectiveDisplaySize() {
      const rect = renderer.domElement.getBoundingClientRect();
      const sw = screen.width  || rect.width  || 1;
      const sh = screen.height || rect.height || 1;
      const w = (rect.width  / sw) * (myDisplay.width  || 0.3);
      const h = (rect.height / sh) * (myDisplay.height || 0.2);
      return { width: w, height: h };
    }
    // canvas 同期 ON 時の self base 距離:
    //   base H が canvas viewport (vfov, aspect) をちょうど埋める距離 d を計算する。
    //   計算: d = H / (2 tan(vfov/2))   (垂直 FOV から)
    //   ※ 水平 FOV から d = W / (2 tan(hfov/2)) でも同じ (canvas aspect = base aspect の時)
    //   ※ 実装は「小さい方の d」= min(H/2tan(vfov/2), W/2tan(hfov/2)) を採用し、
    //      canvas と base のアスペクトにズレがあっても base 全体が確実に viewport 内に収まる。
    function computeSelfSyncDepth() {
      const vfov = (camera.fov || 60) * Math.PI / 180;
      const asp  = camera.aspect || (window.innerWidth / window.innerHeight);
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * asp);
      const H = effectiveDisplaySize.height || 0.2;
      const W = effectiveDisplaySize.width  || 0.3;
      const dV = H / (2 * Math.tan(vfov / 2));
      const dH = W / (2 * Math.tan(hfov / 2));
      return Math.max(0.02, Math.min(dV, dH));
    }
    // 実効サイズを再計算 → 保存 → self avatar 再構築 → server に emit
    //   canvas 同期 ON 時は base 距離を canvas viewport ぴったりに合わせる
    function computeAndApplyEffectiveSize(tag) {
      effectiveDisplaySize = computeEffectiveDisplaySize();
      // 同期 ON なら base 距離を canvas 完全埋めに調整、OFF なら null (デフォルト 0.5m)
      SELF_FRUSTUM_DEPTH = canvasSyncEnabled ? computeSelfSyncDepth() : null;
      log('effective size ' + (tag || '') + ': canvas=' +
          Math.round(renderer.domElement.getBoundingClientRect().width) + '×' +
          Math.round(renderer.domElement.getBoundingClientRect().height) + 'px' +
          ' → ' + effectiveDisplaySize.width.toFixed(3) + '×' + effectiveDisplaySize.height.toFixed(3) + 'm' +
          (SELF_FRUSTUM_DEPTH ? ' D=' + SELF_FRUSTUM_DEPTH.toFixed(3) + 'm (sync)' : ' D=0.5m (default)'), 'ok');
      if (myId) rebuildAvatarFrustum(myId, effectiveDisplaySize, SELF_FRUSTUM_DEPTH);
      if (socket && socket.connected) {
        socket.emit('displaySize', {
          width: effectiveDisplaySize.width,
          height: effectiveDisplaySize.height,
        });
      }
    }

    // ============================================================
    // 物理ディスプレイサイズ推定
    //   ブラウザは物理 DPI を直接返さないので、以下を組み合わせて推測:
    //     1. UA + native 解像度 (screen.width × devicePixelRatio) で機種を特定
    //     2. 機種毎の代表 PPI テーブル参照
    //     3. width_m = nativePx / PPI × 0.0254 で メートル換算
    //   fallback: PPI=96 (CSS 標準) or DPR×160 (Android)
    //   詳細な情報 (機種名, PPI) は log に出るので、調整時の参考にできる
    // ============================================================
    function detectPhysicalDisplaySize() {
      const cssW = screen.width || window.innerWidth;
      const cssH = screen.height || window.innerHeight;
      const dpr = window.devicePixelRatio || 1;
      const nW = Math.round(cssW * dpr);
      const nH = Math.round(cssH * dpr);
      const nMin = Math.min(nW, nH);
      const nMax = Math.max(nW, nH);
      const ua = navigator.userAgent || '';
      const isIOS = /iPhone|iPad|iPod/i.test(ua)
        || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1); // iPadOS 13+
      let ppi = null;
      let deviceName = 'unknown';

      if (/iPhone/i.test(ua) || (isIOS && !/iPad/i.test(ua) && nMax < 2500)) {
        // iPhone 系: nativeMax 長辺 で機種推定 → 代表 PPI
        //   代表機種: 一部世代でわずかにズレるが、off-axis 用途では十分な近似値
        if (nMax >= 2796) { ppi = 460; deviceName = 'iPhone 14/15/16 Pro Max'; }
        else if (nMax >= 2778) { ppi = 458; deviceName = 'iPhone 11-13 Pro Max / Plus'; }
        else if (nMax >= 2688) { ppi = 458; deviceName = 'iPhone XS Max / 11 Pro Max'; }
        else if (nMax >= 2556) { ppi = 460; deviceName = 'iPhone 14/15/16 / 14 Pro'; }
        else if (nMax >= 2532) { ppi = 460; deviceName = 'iPhone 12/13/14'; }
        else if (nMax >= 2436) { ppi = 458; deviceName = 'iPhone X/XS/11 Pro'; }
        else if (nMax >= 2340) { ppi = 476; deviceName = 'iPhone 12/13 mini'; }
        else if (nMax >= 1920) { ppi = 401; deviceName = 'iPhone 6/7/8 Plus'; }
        else if (nMax >= 1792) { ppi = 326; deviceName = 'iPhone XR / 11'; }
        else if (nMax >= 1334) { ppi = 326; deviceName = 'iPhone SE 2/3 / 6/7/8'; }
        else { ppi = 326; deviceName = 'iPhone (older)'; }
      } else if (/iPad/i.test(ua) || isIOS) {
        if (nMax >= 2732) { ppi = 264; deviceName = 'iPad Pro 12.9"'; }
        else if (nMax >= 2388) { ppi = 264; deviceName = 'iPad Pro 11" / Air'; }
        else if (nMax >= 2266) { ppi = 326; deviceName = 'iPad mini 6'; }
        else if (nMax >= 2224) { ppi = 264; deviceName = 'iPad Pro 10.5"'; }
        else if (nMax >= 2160) { ppi = 264; deviceName = 'iPad 10.2"'; }
        else if (nMax >= 2048) { ppi = 264; deviceName = 'iPad 9.7"'; }
        else { ppi = 264; deviceName = 'iPad (older)'; }
      } else if (/Android/i.test(ua)) {
        // Android は端末依存が大きい。DPR × 160 が Android 標準 baseline (mdpi=160)
        ppi = Math.max(96, dpr * 160);
        deviceName = 'Android (DPR estimate)';
      } else if (/Macintosh|Mac OS X/i.test(ua)) {
        // Mac 系: Retina Mac は screen.width × dpr が機種代表 native px と一致するため識別可
        //   ・native 解像度が完全一致するものは機種名 + 実測 PPI
        //   ・不明な Retina 系は 220 PPI (安全側)
        //   ・非 Retina は 27" iMac 系 = 109 PPI 相当を採用
        //   ※ ユーザー側で対角インチを入力すればこれを上書き可能
        const nSet = nMax + ':' + nMin;
        const M = {
          '3456:2234': { ppi: 254, name: 'MacBook Pro 16" (Liquid Retina XDR)' },
          '3024:1964': { ppi: 254, name: 'MacBook Pro 14" (Liquid Retina XDR)' },
          '2880:1864': { ppi: 224, name: 'MacBook Pro 13" M2' },
          '2560:1664': { ppi: 224, name: 'MacBook Air 13" M2/M3' },
          '2880:1800': { ppi: 220, name: 'MacBook Pro 15/16" (Retina)' },
          '2560:1600': { ppi: 227, name: 'MacBook Pro/Air 13" (Retina)' },
          '2304:1440': { ppi: 226, name: 'MacBook 12" (Retina)' },
          '5120:2880': { ppi: 218, name: 'Studio Display 27" / iMac 27" 5K' },
          '4480:2520': { ppi: 218, name: 'iMac 24" M1/M3' },
          '6016:3384': { ppi: 218, name: 'Pro Display XDR 32"' },
          '2560:1440': { ppi: 109, name: '27" 1440p non-Retina' },
          '1920:1080': { ppi:  92, name: '21.5" 1080p (Full HD)' },
        };
        const hit = M[nSet];
        if (hit) { ppi = hit.ppi; deviceName = hit.name; }
        else if (dpr >= 2) { ppi = 220; deviceName = 'Mac Retina (unknown model)'; }
        else { ppi = 109; deviceName = 'Mac non-Retina (推定)'; }
      } else if (/Windows|Linux|X11|CrOS/i.test(ua)) {
        // Windows/Linux: DPR がスケーリング率をそのまま反映するので、
        //   CSS 標準の 96 dpi × dpr を採用。
        //   100% → 96 PPI, 125% → 120, 150% → 144, 200% → 192 相当
        //   (実機の物理 PPI とはズレるが CSS 世界での "1 CSS inch = 96 CSS px" が保たれるので
        //    off-axis 投影の視差計算では概ね正しい)
        ppi = 96 * dpr;
        deviceName = 'Windows/Linux (' + Math.round(dpr * 100) + '% scale, ' + ppi.toFixed(0) + ' PPI 相当)';
      } else {
        ppi = 96 * dpr;
        deviceName = 'Desktop 汎用 (96 × DPR)';
      }

      // 対角インチ override: ユーザーがモニターの実対角を入力していれば、
      //   PPI = sqrt(nW² + nH²) / diagInch で厳密に補正。UA テーブルよりも優先。
      //   localStorage キー 'space2.diagonalInch' に float で保存されている。
      let usedOverride = false;
      try {
        const raw = localStorage.getItem('space2.diagonalInch');
        const dInch = raw ? parseFloat(raw) : NaN;
        if (isFinite(dInch) && dInch > 3 && dInch < 100) {
          const diagPx = Math.hypot(nW, nH);
          ppi = diagPx / dInch;
          deviceName = 'Manual diagonal ' + dInch.toFixed(1) + '"';
          usedOverride = true;
        }
      } catch (_) {}

      const inch = 0.0254;
      const width_m  = (nW / ppi) * inch;
      const height_m = (nH / ppi) * inch;
      return {
        width: width_m,
        height: height_m,
        ppi, deviceName,
        nativeW: nW, nativeH: nH,
        cssW, cssH, dpr,
        usedOverride,
      };
    }

    // ディスプレイサイズを再検出 → myDisplay 更新 → server 通知 → UI 入力欄同期
    //   force=true: 手動編集フラグを無視して強制上書き
    function refreshMyDisplaySize(force) {
      try {
        const est = detectPhysicalDisplaySize();
        log('display: ' + est.deviceName +
            ' native=' + est.nativeW + '×' + est.nativeH +
            ' DPR=' + est.dpr.toFixed(2) +
            ' PPI=' + est.ppi.toFixed(0) +
            (est.usedOverride ? ' [対角 override]' : '') +
            ' → ' + est.width.toFixed(3) + '×' + est.height.toFixed(3) + 'm',
            'ok');
        if (!_displaySizeManuallyEdited || force) {
          myDisplay.width  = est.width;
          myDisplay.height = est.height;
          // 入力欄同期 (フォーカス中は上書きしない)
          const winp = document.getElementById('obs-display-w');
          const hinp = document.getElementById('obs-display-h');
          if (winp && document.activeElement !== winp) winp.value = est.width.toFixed(3);
          if (hinp && document.activeElement !== hinp) hinp.value = est.height.toFixed(3);
          // ※ space3: emit / avatar rebuild はここでは行わない (入室時とフルスクリーン時のみ)
        }
      } catch (e) {
        log('display detect err: ' + e.message, 'err');
      }
    }
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
          const a = ensureAvatar(id, u.color, u.role, u.display);
          a.grp.position.set(u.x, u.y, u.z);
          a.grp.quaternion.set(u.qx, u.qy, u.qz, u.qw);
          if (u.entryTag)   a.entryTag   = u.entryTag;
          if (u.customTags) a.customTags = u.customTags.slice();
        }
        // ★ テスト: 自分自身のプレビュー avatar も生成 (option A)
        //   myDisplay がまだ default 値だが、直後の refreshMyDisplaySize →
        //   computeAndApplyEffectiveSize('init') で正確な canvas 物理サイズに置き換わる。
        //   tick 内で毎フレーム grp = camera pose に追従。
        ensureAvatar(myId, state.myColor, ROLE, effectiveDisplaySize);
        log('self preview avatar: ' + myId.substring(0,6) + ' (テスト: 自視点で自身表示)', 'ok');

        rebuildClientSelect();
        log('init: id=' + myId + ' others=' + Object.keys(data.users || {}).length, 'ok');
        // ディスプレイサイズを自動推定 → 報告 (space3 は入室時 1 回のみ)
        refreshMyDisplaySize(true);
        if (ROLE !== 'camera') {
          // observer/master: canvas 物理サイズを確定して self avatar 再構築 + emit
          computeAndApplyEffectiveSize('init');
        } else {
          // camera (スマホ): 自身の視錐台は無いが server の u.display をここで更新しないと
          //   後で first pose → join broadcast が default {0.5,0.3} (横長) のまま master に飛び
          //   master 側で横長 frustum が生成されてしまう。
          //   → init 直後に myDisplay (portrait) を emit しておくと、server が u.display を
          //     更新 → その後の join broadcast は portrait 寸法を含む。
          if (socket && socket.connected) {
            const w = (myDisplay.width  && myDisplay.width  > 0) ? myDisplay.width  : 0.07;
            const h = (myDisplay.height && myDisplay.height > 0) ? myDisplay.height : 0.15;
            socket.emit('displaySize', { width: w, height: h });
            log('camera init displaySize emit: ' + w.toFixed(3) + '×' + h.toFixed(3) + 'm', 'ok');
          }
        }
      });

      socket.on('join', (u) => {
        const a = ensureAvatar(u.id, u.color, u.role, u.display);
        a.grp.position.set(u.x, u.y, u.z);
        a.grp.quaternion.set(u.qx, u.qy, u.qz, u.qw);
        if (u.entryTag)   a.entryTag   = u.entryTag;
        if (u.customTags) a.customTags = u.customTags.slice();
        rebuildClientSelect();
        log('join: ' + (u.entryTag ? u.entryTag + ' ' : '') + u.id.substring(0, 6) +
            (u.display ? ' display=' + u.display.width.toFixed(3) + '×' + u.display.height.toFixed(3) + 'm' : ''),
            'ok');
      });

      socket.on('pose', (u) => {
        const a = avatars.get(u.id);
        if (!a) return;
        a.grp.position.set(u.x, u.y, u.z);
        a.grp.quaternion.set(u.qx, u.qy, u.qz, u.qw);
        if (u.role) a.role = u.role;
        // observer に遷移した瞬間 server が entryTag を配信するので反映
        if (u.entryTag && a.entryTag !== u.entryTag) {
          a.entryTag = u.entryTag;
          rebuildClientSelect();
          log('entry tag: ' + a.entryTag + ' ← ' + u.id.substring(0,6), 'ok');
        }
      });

      // カスタムタグ (hole_test 等) の付与/解除を全クライアントで反映
      socket.on('avatarTag', (data) => {
        if (!data || typeof data.id !== 'string') return;
        const a = avatars.get(data.id);
        if (a) {
          a.customTags = Array.isArray(data.tags) ? data.tags.slice() : [];
        }
        rebuildClientSelect();
        // master: 選択中クライアントなら tag ボタンの表示を更新
        if (ROLE === 'master' && data.id === selectedClientId && window.__syncMasterTagButtons) {
          window.__syncMasterTagButtons();
        }
        // hole_test トグルは box 形状に影響 → 対象 observer avatar を rebuild
        if (a && a.role === 'observer' && data.tag === 'hole_test') {
          // self なら effectiveDisplaySize + SELF_FRUSTUM_DEPTH、他は保持中の display で再構築
          if (data.id === myId) {
            rebuildAvatarFrustum(myId, effectiveDisplaySize, SELF_FRUSTUM_DEPTH);
          } else {
            // 他 observer は最後に受信した display サイズを持たない場合があるため、
            // avatar 側の frustum サイズ (userData.__frustumParams) から復元
            const params = a.frustumLines && a.frustumLines.userData && a.frustumLines.userData.__frustumParams;
            const disp = params ? { width: params.W, height: params.H } : { width: 0.3, height: 0.2 };
            rebuildAvatarFrustum(data.id, disp);
          }
        }
        log('avatarTag: ' + data.id.substring(0,6) + ' ' + data.tag + ' = ' + (data.on ? 'ON' : 'OFF'), 'ok');
      });

      // シーンオブジェクト (光源等) の生成 / 更新 を受信
      socket.on('sceneObjectCreated', (o) => {
        if (!o || !o.id) return;
        if (sceneLightObjects.has(o.id)) return; // 冪等
        makeSceneObject(o);
        log('sceneObject created: ' + o.id + ' tags=[' + (o.tags||[]).join(',') + ']', 'ok');
        // master: 選択済なら intensity スライダーを反映
        if (window.__syncMasterLightSlider) window.__syncMasterLightSlider();
        rebuildClientSelect();
      });
      socket.on('sceneObjectUpdated', (data) => {
        if (!data || !data.id) return;
        updateSceneObjectConfig(data.id, data.config);
        if (window.__syncMasterLightSlider) window.__syncMasterLightSlider();
      });
      // シーンオブジェクトの位置更新 (master が WASD/QE で移動)
      socket.on('sceneObjectPose', (data) => {
        if (!data || !data.id) return;
        const rec = sceneLightObjects.get(data.id);
        if (!rec) return;
        // ローカルで送信済みの位置は上書きしない ( _selfMovingObjId 中は skip )
        if (window.__selfMovingObjId === data.id) return;
        if (typeof data.x === 'number') rec.grp.position.x = data.x;
        if (typeof data.y === 'number') rec.grp.position.y = data.y;
        if (typeof data.z === 'number') rec.grp.position.z = data.z;
      });
      // space3 グローバル環境光 (light タグ PointLight とは別系統): master スライダー変更 → 全クライアント配信
      socket.on('sceneAmbient', (data) => {
        if (!data || typeof data.intensity !== 'number') return;
        const v = Math.max(0, Math.min(1, data.intensity));
        if (sceneAmbient) sceneAmbient.intensity = v;
        if (window.__syncMasterAmbientSlider) window.__syncMasterAmbientSlider(v);
      });

      socket.on('leave', (u) => {
        const a = avatars.get(u.id);
        if (a) {
          _removeAvatarSelectables(a);
          _disposeAvatarSubMeshes(a);
          scene.remove(a.grp);
          avatars.delete(u.id);
        }
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
        // observer avatar の frustum を新しい display サイズで再構築 (self / 他 いずれも)
        if (data.display) {
          rebuildAvatarFrustum(data.id, data.display);
        }
        // master パネル: 選択中クライアントの表示更新
        if (ROLE === 'master' && data.id === selectedClientId) {
          syncMasterOaBtn(data.display);
        }
      });

      // 移動 Box の ownership transfer (grab した時の宣言、全クライアントに配信)
      socket.on('cubeOwnership', (data) => {
        if (!data || typeof data.name !== 'string') return;
        const c = movableCubes.find((m) => m.name === data.name);
        if (!c) return;
        c.userData.ownerId = (typeof data.owner === 'string') ? data.owner : null;
        // 他人がオーナーになった時、自分のローカル物理はリセット (競合防止)
        if (c.userData.ownerId !== myId) {
          c.userData.vel.set(0, 0, 0);
          c.userData.angVel.set(0, 0, 0);
          c.userData.sleeping = false;   // 以後 receive で描画
        }
      });

      // 移動 Box の質量更新 (master スライダー由来、全クライアントで共有)
      socket.on('cubeMass', (data) => {
        if (!data || typeof data.name !== 'string' || typeof data.mass !== 'number') return;
        const c = movableCubes.find((m) => m.name === data.name);
        if (!c) return;
        c.userData.mass = Math.max(0.01, Math.min(1000, data.mass));
        if (window.__syncMasterMassInput) window.__syncMasterMassInput();
      });

      // 他クライアントからの objectPose (cube1..4 の位置更新)
      //   selectables に登録された name 一致する Mesh の position を反映
      //   ・ローカルで drag 中 (observer/master) は無視 (自身がオーナー)
      //   ・ローカルで grab 中 (camera) は無視 (自身がオーナー)
      //   ・その他は受信位置を採用 + 速度をリセット (物理は他者の emit が優先)
      socket.on('objectPose', (data) => {
        if (!data || typeof data.name !== 'string') return;
        const target = selectables.find((m) => m && m.name === data.name);
        if (!target) return;
        if (selectedObject === target && window.__cubeDragActive) return;
        if (_heldCube === target) return;
        // objectPose では ownership を変更しない (別イベント cubeOwnership で管理)
        if (typeof data.x === 'number') target.position.x = data.x;
        if (typeof data.y === 'number') target.position.y = data.y;
        if (typeof data.z === 'number') target.position.z = data.z;
        if (typeof data.qx === 'number' && typeof data.qw === 'number') {
          target.quaternion.set(data.qx, data.qy || 0, data.qz || 0, data.qw);
        }
        // 受信で強制上書きされたので、ローカル物理速度/角速度をリセット + sleep も解除
        //   (このクライアントは非オーナーとして受信位置だけを描画する、物理は走らない)
        if (target.userData && target.userData.vel)    target.userData.vel.set(0, 0, 0);
        if (target.userData && target.userData.angVel) target.userData.angVel.set(0, 0, 0);
        if (target.userData) {
          target.userData.sleeping = false;
          target.userData.restFrames = 0;
        }
      });

      socket.on('moveConfig', (data) => {
        if (!data || typeof data.sensitivity !== 'number') return;
        moveSensitivity = Math.max(5, Math.min(500, data.sensitivity));
        const inp = document.getElementById('m-move-sens');
        const dirty = window.__mIsDirty || (() => false);
        if (inp && document.activeElement !== inp && !dirty('m-move-sens')) inp.value = moveSensitivity;
        const cur = document.getElementById('m-move-sens-current');
        if (cur) cur.textContent = moveSensitivity;
        log('move sensitivity → ' + moveSensitivity + ' px/m', 'ok');
      });

      socket.on('fogConfig', (data) => {
        if (!data || !scene.fog) return;
        if (typeof data.density === 'number' && isFinite(data.density)) {
          scene.fog.density = Math.max(0, Math.min(1, data.density));
          // master パネルの入力欄と現在値表示を同期 (dirty 中は上書きしない)
          const inp = document.getElementById('m-fog-density');
          const dirty = window.__mIsDirty || (() => false);
          if (inp && document.activeElement !== inp && !dirty('m-fog-density')) inp.value = scene.fog.density.toFixed(3);
          const cur = document.getElementById('m-fog-current');
          if (cur) cur.textContent = scene.fog.density.toFixed(3);
          log('fog density → ' + scene.fog.density.toFixed(3), 'ok');
        }
      });

      // スプレー描画: 他クライアントからの発射を受信してローカルの dome canvas に反映
      //   データ: { u, v, c (hex without #) }
      socket.on('spray', (data) => {
        if (!data || typeof data.u !== 'number' || typeof data.v !== 'number') return;
        const color = (typeof data.c === 'string') ? ('#' + data.c) : '#ffffff';
        _drawSprayDot(data.u, data.v, color);
      });
      // スプレー履歴バッチ (新規接続時にサーバーから届く)
      socket.on('sprayBatch', (list) => {
        if (!Array.isArray(list)) return;
        for (const d of list) {
          if (!d || typeof d.u !== 'number' || typeof d.v !== 'number') continue;
          const color = (typeof d.c === 'string') ? ('#' + d.c) : '#ffffff';
          _drawSprayDot(d.u, d.v, color);
        }
        log('sprayBatch recv: ' + list.length + ' pts', 'ok');
      });
      // 空間リセット: 塗り canvas 全消去 + cube1..N を初期位置へ復元
      socket.on('resetSpace', () => {
        _sprayCtx.clearRect(0, 0, SPRAY_CANVAS_W, SPRAY_CANVAS_H);
        _sprayTex.needsUpdate = true;
        for (const c of movableCubes) {
          const ip = c.userData.initialPos;
          if (!ip) continue;
          c.position.copy(ip);
          c.quaternion.identity();
          if (c.userData.vel) c.userData.vel.set(0, 0, 0);
          if (c.userData.angVel) c.userData.angVel.set(0, 0, 0);
          c.userData.sleeping = false;
          c.userData.restFrames = 0;
          c.userData.held = false;
          c.userData.targetPos = null;
          c.userData.ownerId = null;
        }
        log('resetSpace: 塗り + 全 cube を初期位置へ復元', 'ok');
      });

      // 検証用トグル (effect1..3) の全クライアント同期
      //   ・window.__effect[n] を上書き
      //   ・master はボタン UI を同期 (dirty なし、サーバー値が真)
      //   ・camera + effect1 の場合は空間表示モード (AR / VR) を即時切替
      socket.on('effectState', (data) => {
        if (!data || typeof data !== 'object') return;
        const n = data.effect;
        if (n !== 1 && n !== 2 && n !== 3 && n !== 4) return;
        const on = !!data.on;
        window.__effect = window.__effect || { 1: false, 2: false, 3: false, 4: false };
        window.__effect[n] = on;
        // master UI 同期 (ボタン見た目を on/off に合わせる)
        if (ROLE === 'master') {
          const btn = document.getElementById('m-effect-' + n);
          if (btn) {
            btn.dataset.on = on ? '1' : '0';
            btn.textContent = '効果' + n + ': ' + (on ? 'ON' : 'OFF');
            btn.style.background = on ? '#22c55e' : '#475569';
            btn.style.color = on ? '#052e16' : 'white';
          }
        }
        // 効果1: camera 空間表示モード切替
        if (n === 1 && ROLE === 'camera' && typeof window.__applyCameraSpaceMode === 'function') {
          window.__applyCameraSpaceMode(on);
        }
        // 効果2: 視錐台レイアウト切替 — 既定 (Canvas-plane) ↔ 案 A (実視点)
        //   全アバターの frustum を再構築 (makeObserverFrustumMeshes が window.__effect[2] を参照)
        if (n === 2) {
          avatars.forEach((a, aid) => {
            if (!a._hasFrustum) return;
            // self は effectiveDisplaySize + SELF_FRUSTUM_DEPTH、他は displayConfig で持っている W/H を使う
            const isSelf = (aid === myId);
            const disp = isSelf
              ? effectiveDisplaySize
              : (a.remoteDisplay || { width: 0.3, height: 0.2 });
            const dOverride = isSelf ? SELF_FRUSTUM_DEPTH : null;
            rebuildAvatarFrustum(aid, disp, dOverride);
          });
          log('frustum mode → ' + (on ? 'A (apex=実視点)' : 'default (base=avatar)'), 'ok');
        }
        // 効果3: Fog 中心をフィールド原点に固定 ↔ カメラ (= アバター) に戻す
        if (n === 3 && typeof window.__applyFogOriginMode === 'function') {
          window.__applyFogOriginMode(on);
        }
        log('effectState recv: 効果' + n + ' → ' + (on ? 'ON' : 'OFF'), 'ok');
      });

      socket.on('viewerEye', (data) => {
        if (!data) return;
        if (typeof data.x === 'number') viewerEye.x = data.x;
        if (typeof data.y === 'number') viewerEye.y = data.y;
        if (typeof data.z === 'number') viewerEye.z = data.z;
        // master の入力欄も同期 (dirty 中は上書きしない)
        if (ROLE === 'master') {
          const vex = document.getElementById('ve-x');
          const vey = document.getElementById('ve-y');
          const vez = document.getElementById('ve-z');
          const dirty = window.__mIsDirty || (() => false);
          if (vex && document.activeElement !== vex && !dirty('ve-x')) vex.value = viewerEye.x.toFixed(2);
          if (vey && document.activeElement !== vey && !dirty('ve-y')) vey.value = viewerEye.y.toFixed(2);
          if (vez && document.activeElement !== vez && !dirty('ve-z')) vez.value = viewerEye.z.toFixed(2);
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
    // camera role の held cube 追従 (毎フレーム targetPos を camera + forward·GRAB_DIST に更新)
    //   ・物理 tick より先に実行することで、Spring-Damper が最新 targetPos を即座に参照できる
    //     → スマホ回転 → 1 フレーム以内に spring 加速度が反映 → cube が phone 方向に追従
    updaters.push(_heldTick);
    // 物理シミュレーション: 全ロールで cube1..4 に重力/spring/衝突を適用
    updaters.push(_physicsTick);
    // スプレー発射 tick (press 継続中 + 4 秒経過で発射)
    updaters.push(_sprayTick);

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
        // 空間表示モード: 効果1 (サーバー同期) で分岐 — 2026-10-06 ON/OFF 入れ替え
        //   OFF (既定、恒常): VR 空間 — passthrough をスキップ、通常の 3D シーン (床 + 格子 + fog) で入室
        //   ON               : AR passthrough — 背面カメラ映像を getUserMedia で取得して canvas 背景に敷く
        //   新規 camera クライアントもサーバーから届く effectState で上書きされる
        _capturePassthroughDefaults();
        const wantAR = !!(window.__effect && window.__effect[1]);
        if (wantAR) await enableCameraPassthrough();
        else log('入室時モード: VR 空間 (既定、effect1 OFF)', 'ok');
        enterAsCamera();
      });
    }

    // ========== AR 疑似モード (getUserMedia + DeviceOrientation) ==========
    //   iOS Safari は WebXR immersive-ar 非対応だが、背面カメラ映像を <video> に流して
    //   その上に透過 canvas を重ねれば "見た目の AR" が実現できる。
    //   位置追跡 (SLAM) は無いので、端末を並進移動しても 3D オブジェクトは動かない (回転のみ追従)。
    //
    // VR 空間モードとの切り替え (効果1 トグル):
    //   AR 側 (passthrough ON): scene.background=null, scene.fog=null, floor/grid 非表示, body.ar-mode
    //   VR 側 (passthrough OFF): scene.background/fog を初期値に復元, floor/grid 表示, body.ar-mode 外す
    //   enterAsCamera 時: window.__effect[1] (= 現在のサーバー状態) を見てどちらで入室するか決める
    //   既入室中: socket.on('effectState') が effect=1 を受けたら即時切り替え
    const _passthroughState = {
      active: false,
      stream: null,
      // 元の scene 設定を保存 (初期化後に捕捉)
      saved: null,
    };
    function _capturePassthroughDefaults() {
      if (_passthroughState.saved) return;
      _passthroughState.saved = {
        background: scene.background,
        fog: scene.fog,
        clearAlpha: renderer.getClearAlpha(),
        clearColor: renderer.getClearColor(new THREE.Color()).getHex(),
      };
    }
    async function enableCameraPassthrough() {
      const video = document.getElementById('bg-video');
      if (!video) { log('bg-video 要素なし', 'err'); return false; }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        log('getUserMedia 非対応ブラウザ', 'err');
        return false;
      }
      _capturePassthroughDefaults();
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },   // 背面カメラ優先
            width:  { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        _passthroughState.stream = stream;
        video.srcObject = stream;
        await video.play();
        // 3D シーン側を透過モードに (現実映像を透かす)
        document.body.classList.add('ar-mode');
        scene.background = null;
        scene.fog = null;
        renderer.setClearColor(0x000000, 0);
        // 床/格子/境界/タイル は現実の床が見える AR モードでは邪魔になるので非表示
        if (typeof floor      !== 'undefined' && floor)      floor.visible      = false;
        if (typeof grid       !== 'undefined' && grid)       grid.visible       = false;
        if (typeof majorGrid  !== 'undefined' && majorGrid)  majorGrid.visible  = false;
        if (typeof boundary   !== 'undefined' && boundary)   boundary.visible   = false;
        _passthroughState.active = true;
        log('AR passthrough ON (背面カメラ + gyro)', 'ok');
        return true;
      } catch (e) {
        log('camera passthrough err: ' + (e && e.message ? e.message : e), 'err');
        return false;
      }
    }
    // VR 空間モードへ戻す: カメラストリームを止めて scene 既定値を復元
    function disableCameraPassthrough() {
      const video = document.getElementById('bg-video');
      try {
        if (_passthroughState.stream) {
          _passthroughState.stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
        }
      } catch (_) {}
      _passthroughState.stream = null;
      if (video) { try { video.pause(); } catch (_) {} video.srcObject = null; }
      document.body.classList.remove('ar-mode');
      _capturePassthroughDefaults();
      const s = _passthroughState.saved;
      if (s) {
        scene.background = s.background;
        scene.fog = s.fog;
        renderer.setClearColor(s.clearColor, s.clearAlpha);
      }
      // 床/格子/境界を再表示
      if (typeof floor      !== 'undefined' && floor)      floor.visible      = true;
      if (typeof grid       !== 'undefined' && grid)       grid.visible       = true;
      if (typeof majorGrid  !== 'undefined' && majorGrid)  majorGrid.visible  = true;
      if (typeof boundary   !== 'undefined' && boundary)   boundary.visible   = true;
      _passthroughState.active = false;
      log('AR passthrough OFF (VR 空間モードへ切替)', 'ok');
    }
    // 効果1 の現在値に基づいてモードを適用 (ROLE が camera の時のみ実効)
    //   on=true → AR, on=false → VR (2026-10-06: ON/OFF を入れ替え、VR を既定=恒常状態に)
    async function applyCameraSpaceMode(wantAR) {
      if (ROLE !== 'camera') return;
      if (!state.entered) return;   // 入室前は enterAsCamera 側で初期モードを決める
      if (wantAR) {
        if (!_passthroughState.active) await enableCameraPassthrough();
      } else {
        if (_passthroughState.active) disableCameraPassthrough();
      }
    }
    window.__applyCameraSpaceMode = applyCameraSpaceMode;

    function enterAsCamera() {
      state.entered = true;
      // camera (スマホ) 専用の spawn: 目線高さ 1.7m
      const CAM_SPAWN = { x: 0, y: 2.0, z: 0 };
      camera.position.set(CAM_SPAWN.x, CAM_SPAWN.y, CAM_SPAWN.z);
      // 初期方向: +X (Start 押下時のスマホ方位が +X 正方向にマップされる)
      camera.quaternion.setFromEuler(new THREE.Euler(INIT_PITCH, INIT_YAW, 0, 'YXZ'));
      log('spawn(camera): (' + CAM_SPAWN.x + ',' + CAM_SPAWN.y + ',' + CAM_SPAWN.z + ') 初期 +X 向き', 'ok');
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
      // 入室時に最初の alpha を捕捉して基準化。以後は (alpha - alphaOffset + INIT_YAW) を
      //   使うことで、Start ボタン押下時のスマホが向いていた方位が +X 正方向にマッピングされる。
      let alphaOffset = null;
      let screenOrient = (typeof window.orientation === 'number') ? window.orientation : 0;

      window.addEventListener('orientationchange', () => {
        screenOrient = window.orientation || 0;
      });

      window.addEventListener('deviceorientation', (e) => {
        if (e.alpha === null) return;
        const alphaRaw = THREE.MathUtils.degToRad(e.alpha);
        if (alphaOffset === null) {
          // 初回イベント: この方位を「Start 時の基準」とする
          //   camera が +X (yaw = INIT_YAW = -π/2) を向くように補正
          alphaOffset = alphaRaw;
          log('camera 基準方位を捕捉: raw α=' + e.alpha.toFixed(1) + '° → +X 正方向にマップ', 'ok');
        }
        alpha = alphaRaw - alphaOffset + INIT_YAW;
        beta  = THREE.MathUtils.degToRad(e.beta || 0);
        gamma = THREE.MathUtils.degToRad(e.gamma || 0);
        hasEvent = true;
      }, true);

      _cameraTickFn = () => {
        if (!hasEvent) return;  // gyro が来るまで初期 +X 向きを維持
        const orient = THREE.MathUtils.degToRad(screenOrient);
        euler.set(beta, alpha, -gamma, 'YXZ');
        camera.quaternion.setFromEuler(euler);
        camera.quaternion.multiply(q1);
        camera.quaternion.multiply(q0.setFromAxisAngle(zee, -orient));
      };
      log('DeviceOrientation listener attached', 'ok');
    }

    // ============================================================
    // 共有 canvas インタラクション: master 限定の視錐台選択 + base drag で回転
    //   ・ROLE !== 'master' → 選択も drag も無視 (通常のカメラ回転などが競合なく走る)
    //   ・master:
    //     - tap on apex/base → 選択 (highlight)
    //     - drag on base   → 対象 avatar の Yaw/Pitch 更新 (apex を軸に回転) + controlPose emit
    //     - drag on apex   → 選択のみ (移動なし、要件外)
    //   ・回転感度: deg/px = 15 / moveSensitivity  (sens=60 → 0.25 deg/px)
    // 外部互換: window.__cubeDragActive は false 固定
    // ============================================================
    window.__cubeDragActive = false;
    {
      const _canvas = renderer.domElement;
      const _rayTap = new THREE.Raycaster();
      const _ndcTap = new THREE.Vector2();
      let _pressAt = null;
      let _tapMoved = false;
      let _dragState = null;    // { type:'base', avatarId, startX, startY, startPos, startQuat, lastSend }
      const TAP_SLOP_MOUSE = 6;
      const TAP_SLOP_TOUCH = 10;
      const _tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');
      const _tmpQuat  = new THREE.Quaternion();

      // 現在の press 座標で raycast → 最初のヒット (mesh) を返す (なければ null)
      //   ・選択安定化: 移動 Box (cube1..4) を最優先。距離が近くても apex/base/light を
      //     間違って掴まないよう、まず movable cube のヒットを探し、無ければ他 selectable。
      function _raycastAt(x, y) {
        const rect = _canvas.getBoundingClientRect();
        _ndcTap.x = ((x - rect.left) / rect.width) * 2 - 1;
        _ndcTap.y = -((y - rect.top) / rect.height) * 2 + 1;
        _rayTap.setFromCamera(_ndcTap, camera);
        const hits = _rayTap.intersectObjects(selectables, false);
        if (hits.length === 0) return null;
        // Priority 1: movable cube
        for (const h of hits) {
          if (h.object.userData && h.object.userData.__movable) return h;
        }
        return hits[0];
      }
      // カメラ基準の水平 right / forward ベクトル (XZ 平面へ投影して正規化)
      //   cube1 の drag 移動方向計算に使用
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
        _dragState = null;
        window.__cubeDragActive = false;
        const hit = _raycastAt(x, y);
        // 空の空間 (selectable に当たらず) + 何も選択していない → スプレーの候補として長押し計測開始
        //   移動は許容しない (tapMoved=true になった時点でキャンセル)。release で停止。
        if (!hit && !selectedObject) {
          _spraySelf.pressStartT = performance.now();
          _spraySelf.armed = false;
          _spraySelf.lastEmitT = 0;
        }
        if (!hit) return;
        const obj = hit.object;

        // 移動 Box (cube1..4) — 全ロール共通仕様:
        //   press で grab → drag でレイ先端 (grabDist) に向けて Spring-Damper で追従 → release で物理再開
        //   camera (スマホ) もこの仕様に統一 (旧: スワイプ奥行き調整 + 投擲 は廃止)
        if (obj.userData && obj.userData.__movable) {
          selectObject(obj);
          if (obj.userData.held) return;
          grabCube(obj);
          // 掴んだ瞬間のマウス位置に相当する world 上の "ハンドル点" を保存
          //   drag sensitivity 適用時: (rayHitNow - handleStart) × sens を startCubePos に加算
          const dist0 = camera.position.distanceTo(obj.position);
          const rectG = _canvas.getBoundingClientRect();
          _ndcTap.x = ((x - rectG.left) / rectG.width) * 2 - 1;
          _ndcTap.y = -((y - rectG.top) / rectG.height) * 2 + 1;
          _rayTap.setFromCamera(_ndcTap, camera);
          const handleStart = _rayTap.ray.origin.clone()
            .addScaledVector(_rayTap.ray.direction, dist0);
          _dragState = {
            type: 'cubeGrab',
            targetObj: obj,
            startX: x, startY: y,
            grabDist: dist0,
            startCubePos: obj.position.clone(),
            handleStart: handleStart,
            moved: false,
          };
          window.__cubeDragActive = true;
          return;
        }

        // avatar apex/base 選択・視錐台回転 (master のみ)
        if (ROLE !== 'master') return;
        const type = obj.userData && obj.userData.selectType;
        const avId = obj.userData && obj.userData.avatarId;
        if (!type || !avId) return;
        const av = avatars.get(avId);
        if (!av) return;
        // hit の瞬間に選択 → highlight 表示 (drag 中も見える)
        selectObject(obj);
        // base の場合のみ drag 準備 (apex は drag 無効)
        if (type === 'base') {
          _dragState = {
            type: 'base',
            avatarId: avId,
            startX: x, startY: y,
            startPos:  av.grp.position.clone(),
            startQuat: av.grp.quaternion.clone(),
            lastSend: 0,
          };
        }
      }

      function _pressCheck(x, y, slop) {
        if (!_pressAt) return;
        const dx = x - _pressAt.x, dy = y - _pressAt.y;
        if (Math.hypot(dx, dy) > slop) {
          _tapMoved = true;
          // 指が動いた → スプレー候補をキャンセル
          if (_spraySelf.pressStartT && !_spraySelf.armed) {
            _spraySelf.pressStartT = 0;
          }
        }
        if (!_dragState || !_tapMoved) return;

        // cube grab (全ロール共通): マウス/タップ位置からレイ先端 (grabDist) を計算 → targetPos
        //   実際の cube 位置は Spring-Damper で targetPos に遅延追従 (慣性感)
        //   ・drag sensitivity: (rayHit - handleStart) × sens
        if (_dragState.type === 'cubeGrab') {
          const rect = _canvas.getBoundingClientRect();
          _ndcTap.x = ((x - rect.left) / rect.width) * 2 - 1;
          _ndcTap.y = -((y - rect.top) / rect.height) * 2 + 1;
          _rayTap.setFromCamera(_ndcTap, camera);
          const rayHit = _rayTap.ray.origin.clone()
            .addScaledVector(_rayTap.ray.direction, _dragState.grabDist);
          const sens = (typeof window.__dragSensitivity === 'number') ? window.__dragSensitivity : 1.0;
          const delta = rayHit.clone().sub(_dragState.handleStart).multiplyScalar(sens);
          const target = _dragState.startCubePos.clone().add(delta);
          // 床貫通防止 + Field 範囲クランプ
          if (target.y < CUBE_HALF_Y) target.y = CUBE_HALF_Y;
          target.x = Math.max(-FIELD_HALF + CUBE_HALF_Y, Math.min(FIELD_HALF - CUBE_HALF_Y, target.x));
          target.z = Math.max(-FIELD_HALF + CUBE_HALF_Y, Math.min(FIELD_HALF - CUBE_HALF_Y, target.z));
          const t = _dragState.targetObj;
          // 直接位置更新をやめ、Spring-Damper 目標位置として保存
          if (!t.userData.targetPos) t.userData.targetPos = new THREE.Vector3();
          t.userData.targetPos.copy(target);
          // 投擲時の初速が自然に出るよう _prevPos は維持 (release で参照されるが基本 spring の vel をそのまま使う)
          t.userData._prevPos = t.position.clone();
          t.userData._prevTime = performance.now();
          _dragState.moved = true;
          _emitCubePoseThrottled(t);
          return;
        }

        // base drag → apex 軸で Yaw/Pitch 回転
        if (_dragState.type !== 'base') return;
        const degPerPx = 15 / Math.max(5, moveSensitivity);
        const dYaw   = -dx * degPerPx * (Math.PI / 180);   // 右ドラッグ = -yaw
        const dPitch = -dy * degPerPx * (Math.PI / 180);   // 下ドラッグ = -pitch (下を見る)
        _tmpEuler.setFromQuaternion(_dragState.startQuat, 'YXZ');
        const PL = Math.PI/2 - 0.02;
        const newPitch = Math.max(-PL, Math.min(PL, _tmpEuler.x + dPitch));
        const newYaw   = _tmpEuler.y + dYaw;
        const newRoll  = _tmpEuler.z;   // roll は据え置き
        _tmpEuler.set(newPitch, newYaw, newRoll, 'YXZ');
        _tmpQuat.setFromEuler(_tmpEuler);
        // ローカルで即時反映 (見た目の遅延を回避)
        const av = avatars.get(_dragState.avatarId);
        if (av) av.grp.quaternion.copy(_tmpQuat);
        // 25 Hz スロットルで controlPose emit (server 経由で対象 client と全体に反映)
        const now = performance.now();
        if (now - _dragState.lastSend > 40 && socket && socket.connected) {
          _dragState.lastSend = now;
          const p = _dragState.startPos;
          socket.emit('controlPose', {
            targetId: _dragState.avatarId,
            x: p.x, y: p.y, z: p.z,
            qx: _tmpQuat.x, qy: _tmpQuat.y, qz: _tmpQuat.z, qw: _tmpQuat.w,
          });
        }
      }

      function _pressEnd(x, y) {
        const savedDrag = _dragState;
        _dragState = null;
        window.__cubeDragActive = false;
        // スプレー停止 (press 終了)
        if (_spraySelf.pressStartT) {
          if (_spraySelf.armed) log('spray released', 'ok');
          _spraySelf.pressStartT = 0;
          _spraySelf.armed = false;
        }

        // cube grab 終了 (全ロール共通) → releaseCube で velocity 計算 + 物理再開
        //   drag 有無に関わらず必ず release (短クリックは vel≒0 で落下、drag ありは投げる)
        if (savedDrag && savedDrag.type === 'cubeGrab') {
          releaseCube(savedDrag.targetObj);
          _pressAt = null;
          return;
        }

        const hadDrag = savedDrag && _tapMoved;

        // base drag 終了 (master のみ)
        if (hadDrag && savedDrag && savedDrag.type === 'base') {
          const av = avatars.get(savedDrag.avatarId);
          if (av && socket && socket.connected) {
            const q = av.grp.quaternion;
            const p = savedDrag.startPos;
            socket.emit('controlPose', {
              targetId: savedDrag.avatarId,
              x: p.x, y: p.y, z: p.z,
              qx: q.x, qy: q.y, qz: q.z, qw: q.w,
            });
            try {
              const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
              log('base drag end: ' + savedDrag.avatarId.substring(0,6) +
                  ' Yaw=' + THREE.MathUtils.radToDeg(e.y).toFixed(0) +
                  '° Pit=' + THREE.MathUtils.radToDeg(e.x).toFixed(0) + '°', 'ok');
            } catch (_) {}
          }
          _pressAt = null;
          return;
        }

        const wasTap = _pressAt && !_tapMoved;
        _pressAt = null;
        if (!wasTap) return;
        // tap の判定
        const hit = _raycastAt(x, y);
        if (!hit) {
          // 空 tap: 選択解除 (全ロール共通。cubeGrab は _dragState 側で既に release 済み)
          selectObject(null);
          return;
        }
        const obj = hit.object;
        // 移動 Box (cube1..4): tap で選択 (grab は mousedown 時の cubeGrab 分岐が担当)
        if (obj.userData && obj.userData.__movable) {
          selectObject(obj);
          return;
        }
        // それ以外 (apex/base/light sphere) は master のみ選択可
        if (ROLE !== 'master') { selectObject(null); return; }
        selectObject(obj);
      }

      // Mouse
      _canvas.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        _pressBegin(e.clientX, e.clientY);
      });
      window.addEventListener('mousemove', (e) => _pressCheck(e.clientX, e.clientY, TAP_SLOP_MOUSE));
      window.addEventListener('mouseup',   (e) => {
        if (e.button !== 0) return;
        _pressEnd(e.clientX, e.clientY);
      });

      // Touch (mobile) — space3 の視錐台操作は master 限定なので通常発火しないが実装は同等
      _canvas.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) { _pressAt = null; _dragState = null; return; }
        const t = e.touches[0]; _pressBegin(t.clientX, t.clientY);
      }, { passive: true });
      _canvas.addEventListener('touchmove', (e) => {
        const t = e.touches[0]; if (!t) return;
        _pressCheck(t.clientX, t.clientY, TAP_SLOP_TOUCH);
      }, { passive: true });
      _canvas.addEventListener('touchend', (e) => {
        const t = e.changedTouches[0]; if (!t) { _pressAt = null; _dragState = null; return; }
        _pressEnd(t.clientX, t.clientY);
      }, { passive: true });
      _canvas.addEventListener('touchcancel', () => { _pressAt = null; _dragState = null; });
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

      // 左ドラッグ = look (yaw/pitch)。ただし master が selectable にヒットして
      //   いる場合は共有 handler の drag/select を優先し、カメラ回転はスキップ。
      const _obsRay = new THREE.Raycaster();
      const _obsNDC = new THREE.Vector2();
      function _mousedownHitsSelectable(clientX, clientY) {
        if (selectables.length === 0) return false;
        const rect = renderer.domElement.getBoundingClientRect();
        _obsNDC.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        _obsNDC.y = -((clientY - rect.top) / rect.height) * 2 + 1;
        _obsRay.setFromCamera(_obsNDC, camera);
        const hits = _obsRay.intersectObjects(selectables, false);
        if (hits.length === 0) return false;
        const obj = hits[0].object;
        // 移動 Box (cube1..4) は全ロールで cube grab に譲る (camera 回転はスキップ)
        if (obj.userData && obj.userData.__movable) return true;
        // apex/base/light sphere などは master のみ選択優先
        return ROLE === 'master';
      }
      let dragging = false, lastX = 0, lastY = 0;
      dom.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (_mousedownHitsSelectable(e.clientX, e.clientY)) return;   // master 選択/drag 優先
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
      let _sceneObjSentAt = 0;
      function updateMove(dt) {
        // 移動 Box を掴んでいる間は WASD/QE / camera 移動を全て凍結 (画面固定)
        for (const c of movableCubes) {
          if (c.userData.held) return;
        }
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
        // Master + シーンオブジェクト選択中 → オブジェクトを移動 (カメラは動かさない)
        if (ROLE === 'master' && selectedObject && selectedObject.userData
            && selectedObject.userData.sceneObjectId) {
          const oid = selectedObject.userData.sceneObjectId;
          const rec = sceneLightObjects.get(oid);
          if (rec && (moveTmp.x || moveTmp.y || moveTmp.z)) {
            rec.grp.position.add(moveTmp);
            // 床下貫通防止 + 大きな範囲外へ飛ばないようクランプ
            const HL2 = FIELD_HALF * 2;
            rec.grp.position.x = Math.max(-HL2, Math.min(HL2, rec.grp.position.x));
            rec.grp.position.z = Math.max(-HL2, Math.min(HL2, rec.grp.position.z));
            rec.grp.position.y = Math.max(0.05, Math.min(50, rec.grp.position.y));
            // サーバー送信 (throttle 40ms)、エコー抑制フラグ
            const now = performance.now();
            if (now - _sceneObjSentAt > 40) {
              _sceneObjSentAt = now;
              window.__selfMovingObjId = oid;
              // 少し後にフラグを解除 (echo 到着後)
              clearTimeout(window.__selfMovingObjTimer);
              window.__selfMovingObjTimer = setTimeout(() => {
                window.__selfMovingObjId = null;
              }, 200);
              if (socket && socket.connected) {
                socket.emit('sceneObjectPose', {
                  id: oid,
                  x: rec.grp.position.x,
                  y: rec.grp.position.y,
                  z: rec.grp.position.z,
                });
              }
            }
          }
          return; // camera は動かさない
        }
        camera.position.add(moveTmp);
        // 床範囲外へ大きく飛ばないよう緩やかにクランプ
        const HL = FIELD_HALF * 2;
        camera.position.x = Math.max(-HL, Math.min(HL, camera.position.x));
        camera.position.z = Math.max(-HL, Math.min(HL, camera.position.z));
        camera.position.y = Math.max(0.1, Math.min(50, camera.position.y));
      }
      // update ループへ登録
      updaters.push(updateMove);

      // テレポート系 — XYZ + YPR (deg) をまとめて camera に反映
      //   ・yawDeg/pitchDeg/rollDeg が渡されればそれで上書き
      //   ・roll は observer 標準の yaw/pitch 内部変数以外に Euler(pitch, yaw, roll) で直接 quat を組む
      function teleport(x, y, z, yawDeg, pitchDeg, rollDeg) {
        camera.position.set(x, y, z);
        if (typeof yawDeg   === 'number') yaw   = THREE.MathUtils.degToRad(yawDeg);
        if (typeof pitchDeg === 'number') pitch = THREE.MathUtils.degToRad(pitchDeg);
        const rollRad = (typeof rollDeg === 'number') ? THREE.MathUtils.degToRad(rollDeg) : 0;
        // Roll があるときは applyYawPitch では扱えないので Euler 全成分で直接構築
        if (rollRad !== 0) {
          _e.set(pitch, yaw, rollRad, 'YXZ');
          camera.quaternion.setFromEuler(_e);
        } else {
          applyYawPitch();
        }
      }
      // 「移動」ボタン: mousedown 時点で値を読む (click では focus 抜けで sync が走る前の値を確保)
      //   さらに dirty フラグを解除して以降は sync 復帰
      function _applyObsTeleport() {
        const x = parseFloat((_by('obs-x') || {}).value) || 0;
        const y = parseFloat((_by('obs-y') || {}).value) || 1;
        const z = parseFloat((_by('obs-z') || {}).value) || 0;
        const yawD   = parseFloat((_by('obs-yaw')   || {}).value);
        const pitchD = parseFloat((_by('obs-pitch') || {}).value);
        const rollD  = parseFloat((_by('obs-roll')  || {}).value);
        teleport(x, y, z,
          isFinite(yawD)   ? yawD   : undefined,
          isFinite(pitchD) ? pitchD : undefined,
          isFinite(rollD)  ? rollD  : undefined);
        log('teleport (' + x.toFixed(2) + ',' + y.toFixed(2) + ',' + z.toFixed(2) +
            ') YPR=(' + (isFinite(yawD)?yawD:'-') + ',' + (isFinite(pitchD)?pitchD:'-') + ',' + (isFinite(rollD)?rollD:'-') + ')', 'ok');
        if (typeof window.__obsClearDirty === 'function') window.__obsClearDirty();
      }
      // mousedown で発火 → focus 抜けによる sync 上書きを回避
      const tpBtn = _by('obs-teleport');
      if (tpBtn) {
        tpBtn.addEventListener('mousedown', (e) => { e.preventDefault(); _applyObsTeleport(); });
        tpBtn.addEventListener('touchstart', (e) => { e.preventDefault(); _applyObsTeleport(); }, { passive: false });
      }
      _bind('obs-overview', 'click', () => { teleport(0, 15, 20, 0, -40, 0); if (window.__obsClearDirty) window.__obsClearDirty(); });
      _bind('obs-top',      'click', () => { teleport(0, 20, 0, 0, -89, 0);  if (window.__obsClearDirty) window.__obsClearDirty(); });
      // Enter で apply (XYZ / YPR どのフィールドからも直接 _applyObsTeleport を呼ぶ)
      //   ・keydown Enter 時点では入力欄が focus 中 = 値は最新 = dirty ガードで sync に触られていない
      //   ・そのまま _applyObsTeleport() を呼べば入力値が確実に反映される
      ['obs-x','obs-y','obs-z','obs-yaw','obs-pitch','obs-roll'].forEach((id) => {
        _bind(id, 'keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            _applyObsTeleport();
            // 入力欄から focus を外して sync 復帰を即発生させる
            if (e.target && typeof e.target.blur === 'function') e.target.blur();
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

      // ========== Canvas 同期 トグル ==========
      //   ON  : window resize / DPR 変化のたびに base/box を canvas 物理サイズに追従
      //   OFF : init と fullscreenchange のみで rebuild (デフォルト)
      const obsCsBtn = _by('obs-canvasync-toggle');
      function syncObsCsBtn() {
        if (!obsCsBtn) return;
        obsCsBtn.textContent = canvasSyncEnabled ? 'ON' : 'OFF';
        obsCsBtn.style.background = canvasSyncEnabled ? '#22c55e' : '#475569';
        obsCsBtn.style.color = canvasSyncEnabled ? '#052e16' : 'white';
      }
      syncObsCsBtn();
      // resize イベント → デバウンス → sync ON なら effective 再計算 + rebuild
      let _csResizeTimer = null;
      let _csLastDpr = window.devicePixelRatio || 1;
      function _canvasSyncOnResize() {
        if (!canvasSyncEnabled) return;
        if (_csResizeTimer) clearTimeout(_csResizeTimer);
        _csResizeTimer = setTimeout(() => {
          _csResizeTimer = null;
          applyCanvasLayout();
          computeAndApplyEffectiveSize('resize sync');
        }, 120);
      }
      window.addEventListener('resize', _canvasSyncOnResize);
      // DPR 変化 (モニタ間ドラッグ, ズーム) → matchMedia で監視
      function _watchDpr() {
        const mq = matchMedia('(resolution: ' + _csLastDpr + 'dppx)');
        const onChange = () => {
          _csLastDpr = window.devicePixelRatio || 1;
          _canvasSyncOnResize();
          _watchDpr(); // 新しい DPR で再監視
        };
        if (mq.addEventListener) mq.addEventListener('change', onChange, { once: true });
        else mq.addListener(onChange);
      }
      try { _watchDpr(); } catch (_) {}

      _bind('obs-canvasync-toggle', 'click', () => {
        canvasSyncEnabled = !canvasSyncEnabled;
        syncObsCsBtn();
        log('canvas 同期 → ' + (canvasSyncEnabled ? 'ON (myDisplay aspect に letterbox)' : 'OFF (window 全体)'), 'ok');
        // canvas レイアウトを即時切替 (letterbox ↔ full window)
        applyCanvasLayout();
        // 実効サイズ再計算 + self avatar base/box 再構築
        computeAndApplyEffectiveSize('sync toggle ' + (canvasSyncEnabled ? 'ON' : 'OFF'));
      });

      // ========== Box表示 トグル ==========
      //   box (壁 + 3cm 内面格子 + hole/border) と avatar 選択枠 (apex/base edges) を
      //   まとめて ON/OFF する。light オブジェクトの選択枠 (__alwaysVisible/__isAvatarEdge 無し)
      //   は影響を受けない。
      const obsBoxBtn = _by('obs-box-toggle');
      function syncObsBoxBtn() {
        if (!obsBoxBtn) return;
        obsBoxBtn.textContent = boxVisibilityEnabled ? 'ON' : 'OFF';
        obsBoxBtn.style.background = boxVisibilityEnabled ? '#22c55e' : '#475569';
        obsBoxBtn.style.color      = boxVisibilityEnabled ? '#052e16' : 'white';
      }
      syncObsBoxBtn();
      function applyBoxVisibility() {
        avatars.forEach((a) => {
          if (a.box) a.box.visible = boxVisibilityEnabled;
          // 視錐台ワイヤー: master は Box トグルと独立で常時表示
          if (a.frustumLines) a.frustumLines.visible = (ROLE === 'master') ? true : boxVisibilityEnabled;
          // 選択中の avatar edge は選択状態に合わせて再評価
          if (a.apexEdges) {
            const sel = (selectedObject === a.apexHit);
            a.apexEdges.visible = boxVisibilityEnabled && sel;
          }
          if (a.baseEdges) {
            const sel = (selectedObject === a.baseHit);
            a.baseEdges.visible = boxVisibilityEnabled && sel;
          }
        });
      }
      _bind('obs-box-toggle', 'click', () => {
        boxVisibilityEnabled = !boxVisibilityEnabled;
        syncObsBoxBtn();
        applyBoxVisibility();
        log('box 表示 → ' + (boxVisibilityEnabled ? 'ON' : 'OFF') + ' (box + 内面格子 + 選択枠)', 'ok');
      });

      // ========== FOV 入力 (Enter で適応) ==========
      //   camera.fov (vertical) を書き換え + apex-base 距離 d = H / (2 tan(fov/2)) を再計算。
      //   base サイズは effectiveDisplaySize (m) のまま → FOV に応じて apex が近づく/遠ざかる。
      //   他の observer 入力欄と同じく: input で dirty、Enter で apply + blur、
      //   tick で camera.fov を入力欄に反映 (dirty/focus 中は上書きしない)。
      let _obsFovDirty = false;
      const _obsFovInput = _by('obs-fov');
      if (_obsFovInput) _obsFovInput.value = String(Math.round(camera.fov));

      function applyObsFov() {
        const el = _by('obs-fov');
        if (!el) return;
        const v = parseFloat(el.value);
        if (!isFinite(v) || v < 10 || v > 170) {
          log('FOV 不正 (10 〜 170°)', 'err');
          return;
        }
        camera.fov = v;
        camera.updateProjectionMatrix();
        // apex-base 距離 d を FOV から算出 (垂直/水平の小さい方 = base 全体が viewport 内に収まる距離)
        const vfov = v * Math.PI / 180;
        const asp  = camera.aspect || (window.innerWidth / window.innerHeight);
        const hfov = 2 * Math.atan(Math.tan(vfov / 2) * asp);
        const H = (effectiveDisplaySize && effectiveDisplaySize.height) || 0.2;
        const W = (effectiveDisplaySize && effectiveDisplaySize.width)  || 0.3;
        const dV = H / (2 * Math.tan(vfov / 2));
        const dH = W / (2 * Math.tan(hfov / 2));
        const d = Math.max(0.02, Math.min(dV, dH));
        SELF_FRUSTUM_DEPTH = d;
        if (myId) rebuildAvatarFrustum(myId, effectiveDisplaySize, d);
        log('FOV → ' + v.toFixed(0) + '° / apex-base = ' + d.toFixed(3) + 'm', 'ok');
      }
      _bind('obs-fov', 'input',   () => { _obsFovDirty = true; });
      _bind('obs-fov', 'change',  () => { applyObsFov(); _obsFovDirty = false; });
      _bind('obs-fov', 'keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          applyObsFov();
          _obsFovDirty = false;
          if (e.target && e.target.blur) e.target.blur();
        }
      });
      // tick からも呼ばれる: camera.fov → 入力欄 (dirty/focus 中は上書きしない)
      window.__obsSyncFovInput = function() {
        if (!_obsFovInput) return;
        if (_obsFovDirty) return;
        if (document.activeElement === _obsFovInput) return;
        _obsFovInput.value = Math.round(camera.fov).toString();
      };
      // 表示サイズ入力: ユーザーが手入力したら自動再取得を停止 (手動優先)
      function pushDisplaySize() {
        const w = parseFloat((_by('obs-display-w') || {}).value) || 0.3;
        const h = parseFloat((_by('obs-display-h') || {}).value) || 0.2;
        myDisplay.width = w; myDisplay.height = h;
        _displaySizeManuallyEdited = true;
        // ※ space3: myDisplay の更新のみ。avatar rebuild / emit は行わない
        //   (base/box サイズ変更は入室時と fullscreen 時のみ)
        log('display 手動: ' + w.toFixed(3) + '×' + h.toFixed(3) + 'm (myDisplay 更新、avatar は据置)', 'ok');
      }
      _bind('obs-display-w', 'change', pushDisplaySize);
      _bind('obs-display-h', 'change', pushDisplaySize);

      // ========== 対角インチ + ネイティブ解像度 → PPI 再計算 ==========
      //   入室時の自動推定 (screen.width × dpr) をそのまま解像度入力欄に埋めておき、
      //   ユーザーは対角インチを追記/修正 + Enter or「再計算」ボタンで W×H を厳密算出。
      //   ※ localStorage 継承しない (毎起動で入力し直し、明示的操作を尊重)
      //   ※ screen.width × dpr は Mac Retina では native 解像度と一致するが、Windows 100%
      //      スケーリングでは 96 dpi 基準となり実 native と異なることがあるので、
      //      ユーザーが実測値に置き換える運用を推奨。
      const _initSW = Math.round((screen.width  || 0) * (window.devicePixelRatio || 1));
      const _initSH = Math.round((screen.height || 0) * (window.devicePixelRatio || 1));
      {
        const rwInp = _by('obs-display-res-w');
        const rhInp = _by('obs-display-res-h');
        if (rwInp && _initSW > 0) rwInp.value = _initSW;
        if (rhInp && _initSH > 0) rhInp.value = _initSH;
      }
      function applyDiagResCalc() {
        const inch = parseFloat((_by('obs-display-diag')   || {}).value);
        const rw   = parseFloat((_by('obs-display-res-w') || {}).value);
        const rh   = parseFloat((_by('obs-display-res-h') || {}).value);
        if (!isFinite(inch) || inch < 3 || inch > 100) {
          log('対角インチが不正 (3-100)', 'err'); return;
        }
        if (!isFinite(rw) || !isFinite(rh) || rw < 200 || rh < 200) {
          log('解像度が不正 (>= 200)', 'err'); return;
        }
        const diagPx = Math.hypot(rw, rh);
        const ppi = diagPx / inch;
        const wm  = (rw / ppi) * 0.0254;
        const hm  = (rh / ppi) * 0.0254;
        myDisplay.width  = wm;
        myDisplay.height = hm;
        _displaySizeManuallyEdited = true;
        const winp = _by('obs-display-w');
        const hinp = _by('obs-display-h');
        if (winp) winp.value = wm.toFixed(4);
        if (hinp) hinp.value = hm.toFixed(4);
        // ※ space3: myDisplay の更新のみ。avatar rebuild / emit は行わない
        //   (base/box サイズ変更は入室時と fullscreen 時のみ)
        log('display 再計算: diag=' + inch.toFixed(1) + '" res=' + rw + '×' + rh +
            ' → PPI=' + ppi.toFixed(1) + ' → ' + wm.toFixed(4) + '×' + hm.toFixed(4) + 'm (myDisplay 更新、avatar は据置)', 'ok');
      }
      _bind('obs-display-calc', 'click', applyDiagResCalc);
      // Enter で発火 (どのフィールドからも)
      ['obs-display-diag','obs-display-res-w','obs-display-res-h'].forEach((id) => {
        _bind(id, 'keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            applyDiagResCalc();
            if (e.target && e.target.blur) e.target.blur();
          }
        });
      });

      // ========== camera XYZ + YPR リアルタイム反映 (dirty ガード付き) ==========
      //   毎フレーム camera.position/quaternion を入力欄に書き戻す。
      //   ただし:
      //     ・focus 中のフィールドは触らない
      //     ・ユーザーが `input` イベントで編集した field は dirty=true → 上書き停止
      //       (これにより「入力 → ボタンクリックで focus 抜け → 即上書き」レースを回避)
      //     ・「移動」ボタン適用完了で dirty をクリア → 以降 sync 復帰
      const _obsIds = ['obs-x','obs-y','obs-z','obs-yaw','obs-pitch','obs-roll'];
      const _obsInputs = _obsIds.map(_by);
      const _obsDirty  = { 'obs-x': false, 'obs-y': false, 'obs-z': false,
                           'obs-yaw': false, 'obs-pitch': false, 'obs-roll': false };
      _obsIds.forEach((id) => {
        _bind(id, 'input', () => { _obsDirty[id] = true; });
      });
      function _obsClearDirty() {
        for (const k in _obsDirty) _obsDirty[k] = false;
      }
      window.__obsClearDirty = _obsClearDirty;   // teleport から呼び戻す
      const _obsEulerRead = new THREE.Euler(0, 0, 0, 'YXZ');
      function _obsSyncInputsFromCamera() {
        const focused = document.activeElement;
        const [ix, iy, iz, iyaw, ip, ir] = _obsInputs;
        const put = (el, id, val) => {
          if (!el) return;
          if (focused === el) return;
          if (_obsDirty[id]) return;
          el.value = val;
        };
        put(ix, 'obs-x', camera.position.x.toFixed(2));
        put(iy, 'obs-y', camera.position.y.toFixed(2));
        put(iz, 'obs-z', camera.position.z.toFixed(2));
        _obsEulerRead.setFromQuaternion(camera.quaternion, 'YXZ');
        put(iyaw, 'obs-yaw',   THREE.MathUtils.radToDeg(_obsEulerRead.y).toFixed(0));
        put(ip,   'obs-pitch', THREE.MathUtils.radToDeg(_obsEulerRead.x).toFixed(0));
        put(ir,   'obs-roll',  THREE.MathUtils.radToDeg(_obsEulerRead.z).toFixed(0));
      }
      // updater として毎フレーム呼ぶ
      updaters.push(() => _obsSyncInputsFromCamera());
      // FOV 入力欄も毎フレーム camera.fov に同期 (dirty/focus 中は上書きしない)
      updaters.push(() => { if (window.__obsSyncFovInput) window.__obsSyncFovInput(); });
      // 起動直後にも一度反映
      _obsSyncInputsFromCamera();
      if (window.__obsSyncFovInput) window.__obsSyncFovInput();

      // ========== フルスクリーン (旧 /test/space から継承) ==========
      //   ・obs-fullscreen ボタン: html 要素で requestFullscreen
      //   ・解除は Enter キー (fs-exit-btn は廃止済み) — window keydown handler で処理
      //   ・fullscreenchange 監視: body.fs-mode class を付け外し
      //       → CSS で status/panel/log/ui-toggle 一括非表示
      //   ・resize もイベント経由で呼ばれるが念のため手動更新
      _bind('obs-fullscreen', 'click', () => {
        const el = document.documentElement;
        if (el.requestFullscreen) el.requestFullscreen().catch((e) => log('fullscreen err: ' + e.message, 'err'));
        else log('requestFullscreen 非対応ブラウザ', 'err');
      });
      // Enter キー: フルスクリーン中なら解除 (INPUT/SELECT フォーカス中は無視)
      window.addEventListener('keydown', (e) => {
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
        if (e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
        if (document.fullscreenElement) {
          e.preventDefault();
          if (document.exitFullscreen) document.exitFullscreen();
        }
      });
      document.addEventListener('fullscreenchange', () => {
        const active = !!document.fullscreenElement;
        document.body.classList.toggle('fs-mode', active);
        // canvas レイアウト再適用 (letterbox / 全体) + サイズ確定
        applyCanvasLayout();
        log('fullscreen ' + (active ? 'ON' : 'OFF'), 'ok');
        // canvas 物理サイズが変化 → 実効サイズを再計算 → self avatar 再構築 + emit
        //   ※ fullscreenchange は FS 遷移「開始時」にも発火することがあり、直後の
        //      canvas サイズはまだ切替わっていないケースがある。
        //   → 実際に canvas rect が安定するまで rAF ×2 + 250ms 待って rebuild。
        //      更にサイズが後から動く場合に備え、複数回チェックして変化があれば追加 rebuild。
        const tag = 'fullscreen ' + (active ? 'ON' : 'OFF');
        let lastW = 0, lastH = 0, attempts = 0;
        const settle = () => {
          const r = renderer.domElement.getBoundingClientRect();
          if (Math.abs(r.width - lastW) > 0.5 || Math.abs(r.height - lastH) > 0.5) {
            lastW = r.width; lastH = r.height;
            computeAndApplyEffectiveSize(tag + ' settle#' + attempts);
          }
          attempts++;
          if (attempts < 5) setTimeout(settle, 120);
        };
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(settle, 50)));
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
      // ========== dirty フラグ ヘルパ (input echo 焼き潰し防止) ==========
      //   ・全 master 入力欄で `input` イベント → dirty=true
      //   ・socket echo (viewerEye / moveConfig / fogConfig / forcePose) 受信時、
      //     dirty ならその field を上書きしない
      //   ・apply 完了で該当 field をクリア
      const _mDirty = {};
      function _mMarkDirty(id) { _mDirty[id] = true; }
      function _mIsDirty(id) { return !!_mDirty[id]; }
      function _mClearDirty(...ids) {
        if (ids.length === 0) { for (const k in _mDirty) _mDirty[k] = false; return; }
        for (const id of ids) _mDirty[id] = false;
      }
      // window に露出して socket ハンドラから参照可能に
      window.__mIsDirty = _mIsDirty;
      // input イベント一括登録
      ['m-x','m-y','m-z','m-yaw','m-pitch','m-roll',
       've-x','ve-y','ve-z',
       'm-move-sens','m-fog-density'
      ].forEach((id) => _bind(id, 'input', () => _mMarkDirty(id)));

      // ボタンを mousedown で即発火する共通バインダ
      //   click は mouseup 相当で focus 抜けの後に走るため、mousedown で先手
      function bindApplyMousedown(btnId, applyFn) {
        const btn = _by(btnId);
        if (!btn) return;
        btn.addEventListener('mousedown',  (e) => { e.preventDefault(); applyFn(); });
        btn.addEventListener('touchstart', (e) => { e.preventDefault(); applyFn(); }, { passive: false });
      }

      // Enter で直接 apply + blur を仕込む共通バインダ
      function bindEnterApply(inputIds, applyFn) {
        inputIds.forEach((id) => {
          _bind(id, 'keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              applyFn();
              if (e.target && typeof e.target.blur === 'function') e.target.blur();
            }
          });
        });
      }

      // クライアント選択
      //   ドロップダウン値の prefix で分岐:
      //     ・'av:<id>'  → クライアント (avatar) 選択 → selectedClientId 更新
      //     ・'obj:<id>' → シーンオブジェクト選択 → selectObject(sphere)
      //     ・空          → 選択解除
      const selEl = _by('m-client-select');
      _bind('m-client-select', 'change', () => {
        const raw = selEl ? selEl.value : '';
        if (raw.indexOf('av:') === 0) {
          selectedClientId = raw.substring(3);
          selectObject(null);
        } else if (raw.indexOf('obj:') === 0) {
          const oid = raw.substring(4);
          selectedClientId = '';
          const rec = sceneLightObjects.get(oid);
          if (rec) selectObject(rec.sphere);
        } else {
          selectedClientId = '';
          selectObject(null);
        }
        readCurrentToInputs();
        if (window.__syncMasterTagButtons)  window.__syncMasterTagButtons();
        if (window.__syncMasterLightSlider) window.__syncMasterLightSlider();
      });

      // ========== カスタムタグ付与 (hole_test 等) ==========
      //   ・選択中クライアントに entryTag がある (= observer) 時のみ行を表示
      //   ・ボタンクリックで avatarTag emit (server 経由で全クライアント反映)
      //   ・ボタン状態は選択中クライアントの customTags を反映
      const _tagRow = _by('m-avatar-tags-row');
      const _tagBtns = _tagRow ? Array.from(_tagRow.querySelectorAll('.m-tag-toggle')) : [];
      window.__syncMasterTagButtons = function() {
        if (!_tagRow) return;
        const a = selectedClientId ? avatars.get(selectedClientId) : null;
        const hasEntry = !!(a && a.entryTag);
        _tagRow.style.display = hasEntry ? 'flex' : 'none';
        if (!hasEntry) return;
        const cur = (a.customTags || []);
        _tagBtns.forEach((btn) => {
          const tag = btn.getAttribute('data-tag');
          const on  = cur.indexOf(tag) >= 0;
          btn.classList.toggle('on', on);
          btn.textContent = tag + (on ? ' ✓' : '');
        });
      };
      // クリックで tag ON/OFF を送信
      _tagBtns.forEach((btn) => {
        btn.addEventListener('click', () => {
          if (!selectedClientId) { log('未選択', 'err'); return; }
          const a = avatars.get(selectedClientId);
          if (!a || !a.entryTag) { log('entry tag 無しには付与不可', 'err'); return; }
          const tag = btn.getAttribute('data-tag');
          const cur = a.customTags || [];
          const nextOn = (cur.indexOf(tag) < 0);
          if (socket && socket.connected) {
            socket.emit('avatarTag', { targetId: selectedClientId, tag, on: nextOn });
          }
          log('avatarTag → ' + a.entryTag + ' ' + tag + ' = ' + (nextOn ? 'ON' : 'OFF'), 'ok');
        });
      });
      // 起動時にも 1 度呼んで初期非表示に
      if (window.__syncMasterTagButtons) window.__syncMasterTagButtons();

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
      bindApplyMousedown('m-apply', () => {
        applyForcePose();
        _mClearDirty('m-x','m-y','m-z','m-yaw','m-pitch','m-roll');
      });
      bindEnterApply(['m-x','m-y','m-z','m-yaw','m-pitch','m-roll'], () => {
        applyForcePose();
        _mClearDirty('m-x','m-y','m-z','m-yaw','m-pitch','m-roll');
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
      _bind('m-readcurrent', 'click', () => {
        _mClearDirty('m-x','m-y','m-z','m-yaw','m-pitch','m-roll');
        readCurrentToInputs();
      });

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
      function applyViewerEye() {
        const x = parseFloat((_by('ve-x') || {}).value) || 0;
        const y = parseFloat((_by('ve-y') || {}).value) || 2;
        const z = parseFloat((_by('ve-z') || {}).value) || 0;
        if (socket && socket.connected) socket.emit('viewerEye', { x, y, z });
        _mClearDirty('ve-x','ve-y','ve-z');
        log('viewerEye → (' + x + ',' + y + ',' + z + ')', 'ok');
      }
      bindApplyMousedown('ve-apply', applyViewerEye);
      bindEnterApply(['ve-x','ve-y','ve-z'], applyViewerEye);

      // 移動感度 (master が変更 → server 経由で全クライアントに配信)
      function applyMoveSens() {
        const el = _by('m-move-sens');
        if (!el) return;
        const v = parseFloat(el.value);
        if (isNaN(v)) return;
        if (socket && socket.connected) socket.emit('moveConfig', { sensitivity: v });
        _mClearDirty('m-move-sens');
        log('move sens emit → ' + v + ' px/m', 'ok');
      }
      bindApplyMousedown('m-move-sens-apply', applyMoveSens);
      bindEnterApply(['m-move-sens'], applyMoveSens);

      // FogExp2 密度 (master が変更 → server 経由で全クライアントに配信)
      function applyFogDensity() {
        const el = _by('m-fog-density');
        if (!el) return;
        const d = parseFloat(el.value);
        if (isNaN(d)) return;
        if (socket && socket.connected) socket.emit('fogConfig', { density: d });
        _mClearDirty('m-fog-density');
        log('fog density emit → ' + d.toFixed(3), 'ok');
      }
      bindApplyMousedown('m-fog-apply', applyFogDensity);
      bindEnterApply(['m-fog-density'], applyFogDensity);

      // ==================================================
      // 右クリック コンテキストメニュー (master のみ)
      // ==================================================
      const cmenu = document.getElementById('context-menu');
      function hideContextMenu() { if (cmenu) cmenu.style.display = 'none'; }
      if (renderer && renderer.domElement) {
        renderer.domElement.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          if (!cmenu) return;
          // 画面端で切れないよう左上位置を軽くクランプ
          const menuW = 160, menuH = 60;
          const x = Math.min(e.clientX, window.innerWidth  - menuW - 6);
          const y = Math.min(e.clientY, window.innerHeight - menuH - 6);
          cmenu.style.left = x + 'px';
          cmenu.style.top  = y + 'px';
          cmenu.style.display = 'block';
        });
      }
      // 外側クリック / Esc で閉じる
      document.addEventListener('click', (e) => {
        if (!cmenu) return;
        if (!cmenu.contains(e.target)) hideContextMenu();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') hideContextMenu();
      });
      // メニュー項目クリック
      if (cmenu) {
        cmenu.querySelectorAll('button[data-action]').forEach((btn) => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const action = btn.getAttribute('data-action');
            if (action === 'light') {
              if (socket && socket.connected) {
                socket.emit('sceneObjectCreate', { type: 'light', x: 0, y: 2, z: 0 });
              }
              log('sceneObjectCreate → light (0,2,0)', 'ok');
            }
            hideContextMenu();
          });
        });
      }

      // ==================================================
      // 選択中シーンオブジェクトの光強度スライダー
      // ==================================================
      const _lightRow = _by('m-light-intensity-row');
      const _lightInp = _by('m-light-intensity');
      const _lightVal = _by('m-light-intensity-val');
      // 選択中の scene light object id を返す (selectedObject 経由)
      function _currentSelectedLightId() {
        if (!selectedObject) return null;
        const id = selectedObject.userData && selectedObject.userData.sceneObjectId;
        if (!id) return null;
        const rec = sceneLightObjects.get(id);
        if (!rec) return null;
        return (rec.tags.indexOf('light') >= 0) ? id : null;
      }
      // スライダー UI 状態を選択中オブジェクトの config.intensity に同期
      window.__syncMasterLightSlider = function() {
        if (!_lightRow) return;
        const id = _currentSelectedLightId();
        if (!id) { _lightRow.style.display = 'none'; return; }
        const rec = sceneLightObjects.get(id);
        _lightRow.style.display = 'flex';
        if (_lightInp) _lightInp.value = String(rec.config.intensity);
        if (_lightVal) _lightVal.textContent = rec.config.intensity.toFixed(2);
      };
      // スライダー変更で intensity を server にリアルタイム送信 (スロットル 50ms)
      let _lightThrottle = 0;
      if (_lightInp) {
        _lightInp.addEventListener('input', () => {
          const id = _currentSelectedLightId();
          if (!id) return;
          const v = parseFloat(_lightInp.value);
          if (!isFinite(v)) return;
          const rec = sceneLightObjects.get(id);
          rec.config.intensity = v;
          if (rec.light) rec.light.intensity = v;
          if (_lightVal) _lightVal.textContent = v.toFixed(2);
          const now = performance.now();
          if (now - _lightThrottle < 50) return;
          _lightThrottle = now;
          if (socket && socket.connected) {
            socket.emit('sceneObjectConfig', { id, config: { intensity: v } });
          }
        });
        _lightInp.addEventListener('change', () => {
          const id = _currentSelectedLightId();
          if (!id) return;
          const v = parseFloat(_lightInp.value);
          if (!isFinite(v)) return;
          if (socket && socket.connected) {
            socket.emit('sceneObjectConfig', { id, config: { intensity: v } });
          }
        });
      }
      // 選択変化に反応 (selectObject をラップ)
      const _origSelectObject = selectObject;
      // 上書き不可なので、代替として updateSelectionHint 拡張
      const _origUpdateSelectionHint = window.__origUpdateSelectionHint || null;
      // 毎フレーム selectedObject を軽く監視 (簡素化) — 選択切替時のみ動く
      let _lastSelHint = null;
      updaters.push(() => {
        const cur = selectedObject;
        if (cur !== _lastSelHint) {
          _lastSelHint = cur;
          if (window.__syncMasterLightSlider) window.__syncMasterLightSlider();
        }
      });
      if (window.__syncMasterLightSlider) window.__syncMasterLightSlider();

      // ==================================================
      // space3 環境光 スライダー (AmbientLight 強度、全クライアント配信)
      //   light タグ PointLight とは別系統。全体ベース照度を制御。
      // ==================================================
      const _ambInp = _by('m-scene-ambient');
      const _ambVal = _by('m-scene-ambient-val');
      window.__syncMasterAmbientSlider = function(intensity) {
        if (!_ambInp || !_ambVal) return;
        if (typeof intensity !== 'number') intensity = sceneAmbient ? sceneAmbient.intensity : 0.85;
        _ambInp.value = String(intensity);
        _ambVal.textContent = intensity.toFixed(2);
      };
      let _ambThrottle = 0;
      if (_ambInp) {
        _ambInp.addEventListener('input', () => {
          const v = parseFloat(_ambInp.value);
          if (!isFinite(v)) return;
          if (sceneAmbient) sceneAmbient.intensity = v;
          if (_ambVal) _ambVal.textContent = v.toFixed(2);
          const now = performance.now();
          if (now - _ambThrottle < 50) return;
          _ambThrottle = now;
          if (socket && socket.connected) socket.emit('sceneAmbient', { intensity: v });
        });
        _ambInp.addEventListener('change', () => {
          const v = parseFloat(_ambInp.value);
          if (!isFinite(v)) return;
          if (socket && socket.connected) socket.emit('sceneAmbient', { intensity: v });
        });
      }
      if (window.__syncMasterAmbientSlider) window.__syncMasterAmbientSlider();

      // ==================================================
      // 移動 Box 質量 (cube 選択 + 数値入力、Enter で即時適用)
      //   ・cubeMass イベントで全クライアントに配信、物理 tick の空気抵抗で反映
      // ==================================================
      const _cubeSel  = _by('m-cube-select');
      const _cubeMass = _by('m-cube-mass');
      const _cubeMassCur = _by('m-cube-mass-current');
      window.__syncMasterMassInput = function() {
        if (!_cubeSel || !_cubeMass) return;
        const name = _cubeSel.value;
        if (name === '__all') {
          // 全ての cube の質量が同一ならそれを、異なれば "混在" 表示
          const masses = movableCubes.map((m) => m.userData.mass);
          const same = masses.every((v) => v === masses[0]);
          _cubeMass.value = same ? String(masses[0]) : '';
          if (_cubeMassCur) _cubeMassCur.textContent = same ? masses[0].toFixed(2) : '混在';
          return;
        }
        const c = movableCubes.find((m) => m.name === name);
        if (!c) return;
        _cubeMass.value = String(c.userData.mass);
        if (_cubeMassCur) _cubeMassCur.textContent = c.userData.mass.toFixed(2);
      };
      function _applyCubeMass() {
        if (!_cubeSel || !_cubeMass) return;
        const name = _cubeSel.value;
        const v = parseFloat(_cubeMass.value);
        if (!isFinite(v) || v < 0.01 || v > 1000) {
          log('質量が不正 (0.01 〜 1000)', 'err');
          return;
        }
        if (name === '__all') {
          // 全 cube に順次配信
          movableCubes.forEach((c) => {
            if (socket && socket.connected) {
              socket.emit('cubeMass', { name: c.name, mass: v });
            }
          });
          log('cubeMass emit (all): ' + v.toFixed(2) + ' kg × ' + movableCubes.length, 'ok');
        } else {
          if (socket && socket.connected) {
            socket.emit('cubeMass', { name, mass: v });
          }
          log('cubeMass emit: ' + name + ' = ' + v.toFixed(2) + ' kg', 'ok');
        }
      }
      if (_cubeSel) {
        _cubeSel.addEventListener('change', () => {
          if (window.__syncMasterMassInput) window.__syncMasterMassInput();
        });
      }
      if (_cubeMass) {
        _cubeMass.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            _applyCubeMass();
            if (e.target && e.target.blur) e.target.blur();
          }
        });
      }
      _bind('m-cube-mass-apply', 'click', _applyCubeMass);
      if (window.__syncMasterMassInput) window.__syncMasterMassInput();

      // ==================================================
      // ドラッグ感度 (Enter で適用、ローカル設定)
      //   _dragSensitivity は _pressCheck の cubeGrab 内で displacement 倍率として使う
      // ==================================================
      const _dragSensInp = _by('m-drag-sens');
      const _dragSensCur = _by('m-drag-sens-current');
      function _applyDragSens() {
        if (!_dragSensInp) return;
        const v = parseFloat(_dragSensInp.value);
        if (!isFinite(v) || v < 0.1 || v > 10) {
          log('ドラッグ感度が不正 (0.1 〜 10)', 'err');
          return;
        }
        window.__dragSensitivity = v;
        if (_dragSensCur) _dragSensCur.textContent = v.toFixed(2);
        log('ドラッグ感度 → ' + v.toFixed(2) + '×', 'ok');
      }
      if (_dragSensInp) {
        _dragSensInp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            _applyDragSens();
            if (e.target && e.target.blur) e.target.blur();
          }
        });
      }
      _bind('m-drag-sens-apply', 'click', _applyDragSens);
      _applyDragSens();

      // ==================================================
      // 空間リセット (master 専用): 塗り + Box 位置を全クライアントで初期化
      // ==================================================
      _bind('m-reset-space', 'click', () => {
        if (socket && socket.connected) {
          socket.emit('resetSpace');
          log('resetSpace emit', 'ok');
        }
      });

      // ==================================================
      // 検証用トグル (効果1〜3): 実装内容の効果 ON/OFF 確認
      //   ・master 側ボタンクリック → socket.emit('effectState') → サーバーが全体に broadcast
      //   ・受信側 (全ロール) で window.__effect[n] を更新 + 必要なら効果を適用
      //     - 効果1: ON=VR 空間 / OFF=AR passthrough (camera role のみ即時切替)
      //     - 効果2, 3: 未割当 (指示待ち)
      //   ・ボタン見た目の更新は socket.on('effectState') 側で行う (サーバー往復後に反映)
      // ==================================================
      window.__effect = window.__effect || { 1: false, 2: false, 3: false, 4: false };
      [1, 2, 3, 4].forEach((n) => {
        const btn = document.getElementById('m-effect-' + n);
        if (!btn) return;
        btn.addEventListener('click', () => {
          const next = btn.dataset.on !== '1';
          if (socket && socket.connected) {
            socket.emit('effectState', { effect: n, on: next });
          }
        });
      });
    }

    // ========== クライアント選択ドロップダウン ==========
    function rebuildClientSelect() {
      const sel = document.getElementById('m-client-select');
      if (!sel) return;
      const prev = sel.value;
      sel.innerHTML = '<option value="">-- 未選択 --</option>';
      // 並び順: entryTag 番号昇順 → 無タグ (role 別)
      const list = Array.from(avatars.entries());
      list.sort((A, B) => {
        const na = (A[1].entryTag || '').replace('#', '');
        const nb = (B[1].entryTag || '').replace('#', '');
        const ia = na ? parseInt(na, 10) : Infinity;
        const ib = nb ? parseInt(nb, 10) : Infinity;
        if (ia !== ib) return ia - ib;
        return A[0].localeCompare(B[0]);
      });
      list.forEach(([id, a]) => {
        const opt = document.createElement('option');
        opt.value = 'av:' + id;
        const tag  = a.entryTag ? a.entryTag + ' ' : '';
        const role = (a.role || '?').substring(0, 3);
        const cust = (a.customTags && a.customTags.length) ? ' [' + a.customTags.join(',') + ']' : '';
        opt.textContent = tag + role + ' ' + id.substring(0, 6) + cust;
        sel.appendChild(opt);
      });
      // シーンオブジェクト (light タグ持ち) も選択肢に追加
      const objList = Array.from(sceneLightObjects.entries())
        .filter(([, rec]) => rec.tags.indexOf('light') >= 0);
      if (objList.length) {
        const sep = document.createElement('option');
        sep.disabled = true;
        sep.textContent = '── scene objects ──';
        sel.appendChild(sep);
        objList.forEach(([id, rec]) => {
          const opt = document.createElement('option');
          opt.value = 'obj:' + id;
          const p = rec.grp.position;
          opt.textContent = '💡 ' + id + ' (' + p.x.toFixed(1) + ',' + p.y.toFixed(1) + ',' + p.z.toFixed(1) + ')';
          sel.appendChild(opt);
        });
      }
      if (prev && Array.from(sel.options).some(o => o.value === prev)) sel.value = prev;
      // 選択済み client の tag ボタン UI も再同期
      if (window.__syncMasterTagButtons) window.__syncMasterTagButtons();
      if (window.__syncMasterLightSlider) window.__syncMasterLightSlider();
    }

    // ========== UI 表示切替 + フルスクリーン連動 ==========
    //   ・非表示にした瞬間に requestFullscreen (物理ビューポート全域を canvas で使う)
    //   ・再度押したら exitFullscreen + UI 復帰
    //   ・ユーザーが Safari 側ジェスチャー等で fullscreen 解除した時は
    //     fullscreenchange handler で UI を自動復帰させる (下記グローバルハンドラ)
    _bind('ui-toggle', 'click', async () => {
      const btn = _by('ui-toggle');
      const nextHidden = !document.body.classList.contains('ui-hidden');
      document.body.classList.toggle('ui-hidden', nextHidden);
      if (btn) btn.textContent = nextHidden ? '◉' : 'UI';
      // Fullscreen 要求 (標準 API と Safari 用 webkit-prefix 両方に対応)
      //   iOS 17+ Safari は標準 API に対応、iOS 16 以前は不可 (video 以外は非対応)。
      //   非対応環境ではエラーログを残し、ユーザーには「ホーム画面追加で PWA 化」を案内。
      const el  = document.documentElement;
      const req = el.requestFullscreen || el.webkitRequestFullscreen || el.webkitRequestFullScreen;
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      try {
        if (nextHidden) {
          if (!fsEl && typeof req === 'function') {
            await req.call(el);
          } else if (!req) {
            log('requestFullscreen 非対応 (iOS 16 以前など)。ホーム画面追加で PWA 化を推奨', 'err');
          }
        } else {
          if (fsEl && typeof exit === 'function') {
            await exit.call(document);
          }
        }
      } catch (e) {
        log('fullscreen err: ' + (e && e.message ? e.message : e), 'err');
      }
    });
    // 全ロール共通の fullscreenchange 監視:
    //   ・canvas サイズを viewport 変化に追随 (camera ロールでも動く)
    //   ・fullscreen 解除時に UI 非表示状態も自動復帰
    //   ※ fs-mode class の付与は setupObserver 側の handler が担当 (observer/master のみ)
    //     camera ロールでは fs-mode を付けないので ui-toggle が残り、再タップで戻せる
    function _onFsChange() {
      const active = !!(document.fullscreenElement || document.webkitFullscreenElement);
      if (typeof camera !== 'undefined') {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
      }
      if (typeof renderer !== 'undefined') {
        renderer.setSize(window.innerWidth, window.innerHeight);
      }
      // 外部要因 (ジェスチャー / Esc / fs-exit-btn) で解除された時は UI 状態も戻す
      if (!active && document.body.classList.contains('ui-hidden')) {
        document.body.classList.remove('ui-hidden');
        const btn = _by('ui-toggle');
        if (btn) btn.textContent = 'UI';
      }
    }
    document.addEventListener('fullscreenchange', _onFsChange);
    document.addEventListener('webkitfullscreenchange', _onFsChange);

    // ========================================================
    // オフアクシス投影 (/test/space から移植)
    //   eye:           共通視点 (Vector3)
    //   displayCenter: 画面中心の world 座標 (Vector3)
    //   displayQuat:   画面向き。ローカル: 右=+X, 上=+Y, 法線 (視聴者側)=+Z
    //   w, h:          物理サイズ (m)
    //   near, far:     クリップ面
    //   戻り値: true=適用成功、false=退化 (eye が画面上)
    // ========================================================
    const _ax = new THREE.Vector3(), _ay = new THREE.Vector3(), _az = new THREE.Vector3();
    const _va = new THREE.Vector3(), _vb = new THREE.Vector3(), _vc = new THREE.Vector3();
    const _camLookMat = new THREE.Matrix4();
    const _oaSavePos   = new THREE.Vector3();
    const _oaSaveQuat  = new THREE.Quaternion();
    const _oaDispCenter = new THREE.Vector3();
    const _oaDispQuat   = new THREE.Quaternion();
    const _oaEye        = new THREE.Vector3();
    const _oaTmp        = new THREE.Vector3();
    const CAM_WINDOW_DIST = 0.20;   // スマホ: 画面が視線 20cm 前にあると仮定
    const _oaFlipQ = new THREE.Quaternion(0, 1, 0, 0); // Y 軸 180° (Observer の avatar 反転用)
    let _oaLastState = null;

    function applyOffAxisProjection(cam, eye, displayCenter, displayQuat, w, h, near, far) {
      _ax.set(1, 0, 0).applyQuaternion(displayQuat); // right
      _ay.set(0, 1, 0).applyQuaternion(displayQuat); // up
      _az.set(0, 0, 1).applyQuaternion(displayQuat); // normal (viewer side)
      const hw = w * 0.5, hh = h * 0.5;
      _va.copy(displayCenter).addScaledVector(_ax, -hw).addScaledVector(_ay, -hh).sub(eye);
      _vb.copy(displayCenter).addScaledVector(_ax, +hw).addScaledVector(_ay, -hh).sub(eye);
      _vc.copy(displayCenter).addScaledVector(_ax, -hw).addScaledVector(_ay, +hh).sub(eye);
      let d = -_va.dot(_az);
      // eye が画面裏側なら Y 軸 180° 回転で自動補正
      if (d <= 0.001) {
        _az.negate(); _ax.negate();
        _va.copy(displayCenter).addScaledVector(_ax, -hw).addScaledVector(_ay, -hh).sub(eye);
        _vb.copy(displayCenter).addScaledVector(_ax, +hw).addScaledVector(_ay, -hh).sub(eye);
        _vc.copy(displayCenter).addScaledVector(_ax, -hw).addScaledVector(_ay, +hh).sub(eye);
        d = -_va.dot(_az);
        if (d <= 0.001) return false;
      }
      const k = near / d;
      const l = _va.dot(_ax) * k;
      const r = _vb.dot(_ax) * k;
      const b = _va.dot(_ay) * k;
      const t = _vc.dot(_ay) * k;
      cam.projectionMatrix.makePerspective(l, r, t, b, near, far);
      if (cam.projectionMatrixInverse) {
        cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
      }
      // カメラ位置 = eye、向き = 画面法線と正対
      cam.position.copy(eye);
      _camLookMat.lookAt(eye, _va.copy(eye).sub(_az), _ay);
      cam.quaternion.setFromRotationMatrix(_camLookMat);
      cam.matrixWorldNeedsUpdate = true;
      return true;
    }

    // ========== メインループ ==========
    const clock = new THREE.Clock();
    function tick() {
      requestAnimationFrame(tick);
      const dt = Math.min(clock.getDelta(), 0.1);
      // camera role: DeviceOrientation で毎フレーム camera.quaternion 更新
      if (_cameraTickFn) _cameraTickFn();
      for (const fn of updaters) fn(dt);
      sendPoseThrottled();
      // ★ 自 avatar プレビューを camera pose に追従 (option A テスト)
      if (myId) {
        const selfAv = avatars.get(myId);
        if (selfAv) {
          selfAv.grp.position.copy(camera.position);
          selfAv.grp.quaternion.copy(camera.quaternion);
        }
      }
      // ステータス表示
      const cnt = document.getElementById('count');
      const mp = document.getElementById('my-pos');
      if (cnt) cnt.textContent = String(avatars.size + (state.entered ? 1 : 0));
      if (mp) mp.textContent =
        camera.position.x.toFixed(1) + ',' +
        camera.position.y.toFixed(1) + ',' +
        camera.position.z.toFixed(1);

      // ========== render: myDisplay.offaxis で分岐 ==========
      if (myDisplay.offaxis) {
        // ユーザー由来の姿勢を退避
        _oaSavePos.copy(camera.position);
        _oaSaveQuat.copy(camera.quaternion);
        if (ROLE === 'camera') {
          // スマホ: eye = 自分の位置、画面 = 視線 20cm 前方、画面姿勢 = camera 姿勢
          _oaEye.copy(_oaSavePos);
          _oaTmp.set(0, 0, -1).applyQuaternion(_oaSaveQuat);
          _oaDispCenter.copy(_oaSavePos).addScaledVector(_oaTmp, CAM_WINDOW_DIST);
          _oaDispQuat.copy(_oaSaveQuat);
        } else {
          // observer / master: eye = viewerEye (共通固定点)、画面 = アバター位置
          //   display 姿勢 = camera 姿勢 × 180°Y flip
          //   → 観測者が YPR を動かすと自動で display 姿勢も追従する
          _oaDispCenter.copy(_oaSavePos);
          _oaEye.set(viewerEye.x, viewerEye.y, viewerEye.z);
          _oaDispQuat.copy(_oaSaveQuat).multiply(_oaFlipQ);
        }
        const ok = applyOffAxisProjection(
          camera, _oaEye, _oaDispCenter, _oaDispQuat,
          myDisplay.width, myDisplay.height,
          0.05, 500
        );
        // 状態遷移時のみ 1 回ログ (毎フレーム log を吐くのを回避)
        //   有効 FOV も明示: FOV_h = 2 × atan(halfW / d)
        //   canvas の実際の pixel サイズも表示 (frustum aspect と一致すべき)
        const st = ok ? 'ok' : 'fail';
        if (_oaLastState !== st) {
          _oaLastState = st;
          try {
            const dE = _oaEye.distanceTo(_oaDispCenter);
            const hFov = 2 * Math.atan(myDisplay.width * 0.5 / dE);
            const vFov = 2 * Math.atan(myDisplay.height * 0.5 / dE);
            const cvRect = renderer.domElement.getBoundingClientRect();
            const dispAspect = myDisplay.width / myDisplay.height;
            const cvAspect   = cvRect.width / cvRect.height;
            log('off-axis ' + (ok ? 'OK' : 'FAIL') +
                ' role=' + ROLE +
                ' eye=(' + _oaEye.x.toFixed(2) + ',' + _oaEye.y.toFixed(2) + ',' + _oaEye.z.toFixed(2) + ')' +
                ' disp=(' + _oaDispCenter.x.toFixed(2) + ',' + _oaDispCenter.y.toFixed(2) + ',' + _oaDispCenter.z.toFixed(2) + ')' +
                ' dist=' + dE.toFixed(3) + 'm' +
                ' W×H=' + myDisplay.width.toFixed(3) + '×' + myDisplay.height.toFixed(3) + 'm' +
                ' → h/vFOV=' + THREE.MathUtils.radToDeg(hFov).toFixed(1) + '°/' + THREE.MathUtils.radToDeg(vFov).toFixed(1) + '°' +
                ' canvas=' + Math.round(cvRect.width) + '×' + Math.round(cvRect.height) + 'px' +
                ' aspect(disp/canvas)=' + dispAspect.toFixed(3) + '/' + cvAspect.toFixed(3),
              ok ? 'ok' : 'err');
          } catch (_) {}
        }
        if (!ok) camera.updateProjectionMatrix();
        renderer.render(scene, camera);
        // 復元: ユーザー由来の姿勢を戻す (次フレームの操作が正しく効く)
        camera.position.copy(_oaSavePos);
        camera.quaternion.copy(_oaSaveQuat);
      } else {
        // 通常の対称 perspective に復帰
        if (_oaLastState !== null) {
          _oaLastState = null;
          camera.aspect = window.innerWidth / window.innerHeight;
          camera.updateProjectionMatrix();
          log('off-axis OFF (通常 perspective 復帰)', 'ok');
        }
        renderer.render(scene, camera);
      }
    }
    tick();

    // space3: 自動 refresh は入室時 (socket 'init' 内で 1 回) のみ。
    //   以降は observer panel の「対角インチ + 解像度」入力 → Enter で正確値を明示指定する運用。
    //   window の load/pageshow/orientationchange/resize リスナは撤去。

    log('space2 ready (role=' + ROLE + ')', 'ok');
  }
})();
