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

    // canvasBox 前面 (Base と接する +Z 面) 用の共有テクスチャ。
    //   ・画像を全 canvasBox で使い回す (ロードは 1 回だけ)
    //   ・残り 5 面 (背面 + 側面 4) はグレー基調
    const _canvasBoxTex = new THREE.TextureLoader().load('/assets/canvas-front.png');
    if ('colorSpace' in _canvasBoxTex) _canvasBoxTex.colorSpace = THREE.SRGBColorSpace;
    else _canvasBoxTex.encoding = THREE.sRGBEncoding;
    _canvasBoxTex.anisotropy = 4;
    // 背景 = 白。距離フェード先の色と一致させると「遠方が空気に溶ける」ように見える
    scene.background = new THREE.Color(0xffffff);
    // 指数フォグ (視点から距離 d のフラグメントの色は color との mix になる):
    //   factor = exp(-(density * d)²), density=0.12 なら 10m で 24%→白 76%、15m でほぼ完全に白
    //   Fog (linear) より遠近の変化が自然。GridHelper (LineBasicMaterial) も対応する。
    //   ★ 床面自体は純白 (0xffffff) なので視覚的変化なし (白+白=白)。
    //      グリッド/境界線 (濃グレー) と他クライアントのアバターだけがフェードして見える。
    //   density は master 制御パネルから変更可能 (fogConfig で全クライアントに配信)
    scene.fog = new THREE.FogExp2(0xffffff, 0.0);   // 初期値 0 (フォグ無効スタート)

    // 効果3 (Fog 原点固定) は廃止。__patchSceneFog は呼び出し互換のため no-op として残置。
    window.__patchSceneFog = function () {};
    window.__applyFogOriginMode = function () {};

    const camera = new THREE.PerspectiveCamera(
      72,
      window.innerWidth / window.innerHeight,
      0.005, 500   // near 5mm: canvasBox (奥行 2cm、base から 2cm 前方) を近接表示可能に
    );
    // 全ロール共通: 入室座標 (0, 1, 0)、初期回転 Yaw=-90°, Pitch=0, Roll=0
    //   Euler(pitch=0, yaw=-π/2, roll=0, 'YXZ') → +X 方向を見る
    const SPAWN_POS = { x: 0, y: 1.5, z: 0 };
    const INIT_YAW = -Math.PI / 2;   // -90°
    const INIT_PITCH = 0;
    const INIT_ROLL = 0;
    camera.position.set(SPAWN_POS.x, SPAWN_POS.y, SPAWN_POS.z);
    camera.quaternion.setFromEuler(new THREE.Euler(INIT_PITCH, INIT_YAW, INIT_ROLL, 'YXZ'));

    // alpha:true にすると scene.background=null 時に canvas が透過し、下敷きの
    //   #bg-video (getUserMedia の背面カメラ映像) が透けて見える (camera role の AR モード)。
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    // モバイル GPU は DPR=3 (iPhone) だと 9x のピクセル処理となりフレームレートが
    // 著しく落ちる。camera (スマホ) ロールでは DPR を 2 に制限して描画コストを抑える。
    const _rawDPR = window.devicePixelRatio || 1;
    const _dprCap = (ROLE === 'camera') ? Math.min(_rawDPR, 2) : _rawDPR;
    renderer.setPixelRatio(_dprCap);
    renderer.setSize(window.innerWidth, window.innerHeight);
    // Tone mapping は無効化 (ACES では背景色/フォグ色が灰色寄りに圧縮され、
    //   オブジェクトは白みがかる視覚不一致が出るため)。
    //   トレードオフ: ambient=1 では影がほぼ見えなくなる → shadow を見たい時は ambient < 0.7 を推奨
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1.0;
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
    // シャドウカメラ設定 (castShadow は effect4 トグル時に ON にする)
    //   FIELD_HALF (= 30) をリテラルで記述 (この行は FIELD_HALF 宣言より前にある)
    dirLight.shadow.mapSize.set(2048, 2048);
    dirLight.shadow.camera.left   = -30;
    dirLight.shadow.camera.right  =  30;
    dirLight.shadow.camera.top    =  30;
    dirLight.shadow.camera.bottom = -30;
    dirLight.shadow.camera.near   = 0.5;
    dirLight.shadow.camera.far    = 120;
    dirLight.shadow.bias = -0.0005;
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
    floor.receiveShadow = true;   // effect4 shadow 対応
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
      c.castShadow = false;
      c.receiveShadow = false;
      // 一時的に全移動オブジェクトを非表示化 (ユーザー指示) — scene.add は行わない
      c.visible = false;
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
    // materialBox (X=3, Z=0) と干渉しないよう cube1..4 の基準位置を -X 方向へシフト
    const cube1 = makeMovableCube('cube1', -1.5, 0.5, -0.5, 0x6b7280); // 灰
    const cube2 = makeMovableCube('cube2', -4.5, 0.5, -0.5, 0xef4444); // 赤
    const cube3 = makeMovableCube('cube3', -1.5, 0.5,  1.5, 0x22c55e); // 緑
    const cube4 = makeMovableCube('cube4', -4.5, 0.5,  1.5, 0x3b82f6); // 青
    // 追加 7 個 (原点中心 20m × 20m エリア内に散開配置、Y=0.5 = 床置き)
    const cube5  = makeMovableCube('cube5',   6.5, 0.5, -6.5, 0xf59e0b); // 橙
    const cube6  = makeMovableCube('cube6',  -6.5, 0.5, -6.5, 0xa855f7); // 紫
    const cube7  = makeMovableCube('cube7',   6.5, 0.5,  6.5, 0x14b8a6); // 青緑
    const cube8  = makeMovableCube('cube8',  -6.5, 0.5,  6.5, 0xec4899); // ピンク
    const cube9  = makeMovableCube('cube9',   0.5, 0.5, -9.5, 0xeab308); // 黄
    const cube10 = makeMovableCube('cube10', -9.5, 0.5,  0.5, 0x06b6d4); // シアン
    const cube11 = makeMovableCube('cube11',  9.5, 0.5,  0.5, 0x84cc16); // ライム
    // 追加 3 個 (ダークグレー #535353 + 各面にアセット画像をマッピング)
    //   ・makeMovableCube で基本 cube を作成し、全 6 面を map 付き MeshStandardMaterial 配列で差し替え
    //   ・テクスチャは BoxGeometry の UV に合わせてストレッチ表示 (1m 立方体なので画像が各面を埋める)
    const cube12 = makeMovableCube('cube12',  4.5, 0.5, -2.5, 0x535353);
    const cube13 = makeMovableCube('cube13', -4.5, 0.5, -4.5, 0x535353);
    const cube14 = makeMovableCube('cube14',  3.5, 0.5,  4.5, 0x535353);
    function _applyCubeTexture(cube, url) {
      const texLoader = new THREE.TextureLoader();
      const tex = texLoader.load(url);
      if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
      else tex.encoding = THREE.sRGBEncoding;
      tex.anisotropy = 4;
      // 既存の 1 material を 6 面全部 same-texture の配列に差し替え
      const mat = new THREE.MeshStandardMaterial({
        map: tex,
        color: 0xffffff,     // 画像色をそのまま出すため白
        roughness: 0.8,
        metalness: 0.0,
      });
      // 旧 material を dispose してメモリリーク防止
      if (cube.material && cube.material.dispose) cube.material.dispose();
      cube.material = [mat, mat, mat, mat, mat, mat];
    }
    _applyCubeTexture(cube12, '/assets/cube-face-1.png');
    _applyCubeTexture(cube13, '/assets/cube-face-2.png');
    _applyCubeTexture(cube14, '/assets/cube-face-3.png');
    // cube13 (Asset 2) = opacity タグ付与トリガー
    // cube12 (Asset 1) = opacity タグ解除トリガー
    //   タグはクライアント保持 (window.__opacityTagged)。タグ中は全 cube の grab 操作が
    //   位置移動の代わりに上下スワイプで透過度調整になる。
    cube13.userData.__opacityTagTrigger = 'on';   // grab で tag を立てる
    cube12.userData.__opacityTagTrigger = 'off';  // grab で tag を解除
    // 全 movable cube にて transparent 対応 (タグ中にどの cube を選んでも opacity 変化可能)
    //   既存 cube の material を transparent-capable に (opacity=1 のまま視覚的影響なし)
    function _makeMaterialTransparent(mat) {
      if (!mat) return;
      mat.transparent = true;
      if (typeof mat.opacity !== 'number') mat.opacity = 1.0;
      mat.needsUpdate = true;
    }
    // 全 movableCubes に適用 (このブロックの時点では配列未宣言のため、宣言後に走らせる)
    //   → 直後の movableCubes = [...] の後で実行する
    window.__opacityTagged = false;
    window.__initCubeTransparent = function (cubes) {
      cubes.forEach((c) => {
        if (!c.userData) c.userData = {};
        if (typeof c.userData.opacity !== 'number') c.userData.opacity = 1.0;
        if (Array.isArray(c.material)) c.material.forEach(_makeMaterialTransparent);
        else _makeMaterialTransparent(c.material);
      });
    };

    // ===== 移動 Sphere オブジェクト (1m 直径、cube と同じ物理挙動) =====
    //   ・SphereGeometry(0.5) で半径 0.5m
    //   ・halfExt は bounding box (0.5,0.5,0.5) として扱い既存の床/壁物理に乗せる
    //   ・選択ハイライトは Wireframe 球 (黄)
    function makeMovableSphere(name, x, y, z, colorHex) {
      const s = new THREE.Mesh(
        new THREE.SphereGeometry(0.5, 32, 24),
        new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.75, metalness: 0.0 })
      );
      s.position.set(x, y, z);
      s.name = name;
      s.castShadow = false;
      s.receiveShadow = false;
      // 一時的に全移動オブジェクトを非表示化 — scene.add は行わない
      s.visible = false;
      const edges = new THREE.LineSegments(
        new THREE.WireframeGeometry(new THREE.SphereGeometry(0.52, 16, 12)),
        new THREE.LineBasicMaterial({
          color: 0xfbbf24, transparent: true, opacity: 1.0,
          depthTest: false, fog: false,
        })
      );
      edges.renderOrder = 999;
      edges.visible = false;
      s.add(edges);
      s.userData.__movable = true;
      s.userData.vel      = new THREE.Vector3();
      s.userData.angVel   = new THREE.Vector3();
      s.userData.held     = false;
      s.userData.mass     = 10.0;
      s.userData.sleeping   = false;
      s.userData.restFrames = 0;
      s.userData.targetPos  = null;
      s.userData.ownerId    = null;
      s.userData.halfExt    = new THREE.Vector3(0.5, 0.5, 0.5);
      s.userData.inertiaFactor = (2/5);   // 球の慣性: (2/5)·m·r² — scalar factor
      s.userData.initialPos = new THREE.Vector3(x, y, z);
      return s;
    }
    const sphere1 = makeMovableSphere('sphere1',  0, 0.5, -4, 0xf87171); // サンゴ
    const sphere2 = makeMovableSphere('sphere2', -7, 0.5,  2, 0x60a5fa); // 水色
    const sphere3 = makeMovableSphere('sphere3',  6, 0.5,  3, 0x34d399); // ミント
    const sphere4 = makeMovableSphere('sphere4',  2, 0.5, -5, 0xfbbf24); // 山吹
    const sphere5 = makeMovableSphere('sphere5', -3, 0.5, -5, 0xc084fc); // 藤

    // ===== materialBox (液体マテリアル、X=3, Z=0) =====
    //   案 B: ノイズテクスチャ 2 枚を異なる速度でスクロールして screen-space UV を distort、
    //   背景 RenderTarget をオフセットサンプリングして "後ろが揺らぐ" 流体表現
    //   ・物理挙動は他 movable cube と同じ (grab/release/床反発/壁反発)
    //   ・6 面すべて同じ ShaderMaterial
    //   ・レンダリングは tick 内で 2 パス: 1) materialBox 非表示で bgRT に render → 2) materialBox 表示で本番 render
    const _matBgRT = new THREE.WebGLRenderTarget(
      Math.max(256, Math.floor(window.innerWidth * 0.5)),
      Math.max(256, Math.floor(window.innerHeight * 0.5)),
      { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat }
    );
    // ノイズテクスチャ: 低解像度 (32×32) で生成し Linear filter で upscale → 大きな滑らかなブロブ
    //   高解像度の pure random だと見た目が高周波で "鏡の歪み" に見えるため、低周波化で液体感を出す
    const _noiseSize = 32;
    const _noiseCanvas = document.createElement('canvas');
    _noiseCanvas.width = _noiseSize; _noiseCanvas.height = _noiseSize;
    const _nctx = _noiseCanvas.getContext('2d');
    const _imgData = _nctx.createImageData(_noiseSize, _noiseSize);
    for (let i = 0; i < _imgData.data.length; i += 4) {
      _imgData.data[i    ] = (Math.random() * 255) | 0;
      _imgData.data[i + 1] = (Math.random() * 255) | 0;
      _imgData.data[i + 2] = (Math.random() * 255) | 0;
      _imgData.data[i + 3] = 255;
    }
    _nctx.putImageData(_imgData, 0, 0);
    const _noiseTex = new THREE.CanvasTexture(_noiseCanvas);
    _noiseTex.wrapS = THREE.RepeatWrapping;
    _noiseTex.wrapT = THREE.RepeatWrapping;
    _noiseTex.magFilter = THREE.LinearFilter;
    _noiseTex.minFilter = THREE.LinearFilter;   // mipmap 無し、大きな blob のまま使う
    const _matShader = new THREE.ShaderMaterial({
      uniforms: {
        uBackground: { value: _matBgRT.texture },
        uNoise:      { value: _noiseTex },
        uTime:       { value: 0 },
        uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
        uFreq:       { value: 0.25 },  // 周波数倍率 (master slider で動的制御、既定 0.25)
        uAmp:        { value: 0.03 },  // 歪み振幅 (UV オフセット、既定 ±3%)
        uDispAmp:    { value: 0.03 },  // 頂点変位振幅 (m)、uFreq に連動 → 外周シルエット揺らぎ
        // 波紋 (ripple): 最大 3 個同時、ローカル (box local) 座標中心を保持
        //   JS 側で 2 秒おきに新規波紋を発生、半径は elapsed * 0.04 m
        //   寿命: 半径がボックス対角 (~1.73m) を超えたら無効化
        uRippleCenter: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
        uRippleStart:  { value: [-999.0, -999.0, -999.0] },
      },
      vertexShader: `
        uniform float uTime;
        uniform float uFreq;
        uniform float uDispAmp;
        uniform vec3  uRippleCenter[3];
        uniform float uRippleStart[3];
        varying vec3 vNormalView;
        varying vec3 vViewDir;
        varying vec3 vLocalPos;
        void main() {
          vec3 pos = position;
          float wv = (
            sin(pos.x * 8.0 * uFreq + uTime * 1.5) +
            sin(pos.y * 7.0 * uFreq + uTime * 1.2) +
            sin(pos.z * 9.0 * uFreq + uTime * 1.8)
          ) / 3.0;
          pos += normal * wv * uDispAmp * uFreq;
          vLocalPos = pos;
          vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
          vNormalView = normalize(normalMatrix * normal);
          vViewDir = normalize(-mvPos.xyz);
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: `
        uniform sampler2D uBackground;
        uniform sampler2D uNoise;
        uniform float uTime;
        uniform float uFreq;
        uniform float uAmp;
        uniform vec2  uResolution;
        uniform vec3  uRippleCenter[3];
        uniform float uRippleStart[3];
        varying vec3 vNormalView;
        varying vec3 vViewDir;
        varying vec3 vLocalPos;
        void main() {
          vec2 screenUv = gl_FragCoord.xy / uResolution;
          vec2 n1 = texture2D(uNoise, screenUv * (1.2 * uFreq) + vec2(uTime * 0.07,  uTime * 0.04)).rg;
          vec2 n2 = texture2D(uNoise, screenUv * (0.8 * uFreq) - vec2(uTime * 0.05, -uTime * 0.06)).rg;
          vec2 wave = (n1 + n2 - 1.0) * uAmp * uFreq;
          vec4 bg = texture2D(uBackground, clamp(screenUv + wave, 0.0, 1.0));
          vec3 N = normalize(vNormalView + vec3(wave.x, wave.y, 0.0) * 12.0);
          vec3 V = normalize(vViewDir);
          vec3 L = normalize(vec3(0.3, 0.8, 0.5));
          vec3 R = reflect(-L, N);
          float spec = pow(max(dot(R, V), 0.0), 24.0);
          vec3 base = bg.rgb;
          gl_FragColor = vec4(base + vec3(spec) * 0.35, 1.0);
        }
      `,
      side: THREE.DoubleSide,
    });
    // BoxGeometry を 16 分割 → 各面 17×17 頂点 = 計 ~1700 頂点 (vertex displacement 用)
    const materialBox = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1, 16, 16, 16), _matShader);
    materialBox.position.set(3, 0.5, 0);
    materialBox.name = 'materialBox';
    materialBox.castShadow = false;
    materialBox.visible = false;   // 一時的に全移動オブジェクトを非表示化
    // scene.add は行わない (ユーザー指示: 移動オブジェクト一旦全削除)

    // ===== 内部オブジェクト: 一回り小さい黒立方体 (面毎に 3×3 白線格子) =====
    //   ・materialBox と同じ位置 (兄弟配置) に 0.8m の BoxGeometry を置き、tick で transform を追従
    //   ・pre-pass (bgRT) 時に materialBox だけを一時非表示 → innerCube は RT に残る
    //     → materialBox shader が bgRT を distortion サンプリングして "液体越しに内部が揺れる" 絵を得る
    //   ・テクスチャは canvas 256×256 に black fill + 2 本×2 本の白線 + border を描いて 3×3 格子に
    const _gridC = document.createElement('canvas');
    _gridC.width = 256; _gridC.height = 256;
    const _gctx = _gridC.getContext('2d');
    _gctx.fillStyle = '#9ca3af'; _gctx.fillRect(0, 0, 256, 256);   // ベース = グレー
    _gctx.strokeStyle = '#ffffff'; _gctx.lineWidth = 4; _gctx.lineCap = 'square';
    for (let _i = 1; _i < 3; _i++) {
      const _p = (_i / 3) * 256;
      _gctx.beginPath(); _gctx.moveTo(_p, 0); _gctx.lineTo(_p, 256); _gctx.stroke();
      _gctx.beginPath(); _gctx.moveTo(0, _p); _gctx.lineTo(256, _p); _gctx.stroke();
    }
    _gctx.lineWidth = 6;
    _gctx.strokeRect(3, 3, 250, 250);   // 外枠 (稜線を強調)
    const _innerTex = new THREE.CanvasTexture(_gridC);
    _innerTex.magFilter = THREE.LinearFilter;
    _innerTex.minFilter = THREE.LinearMipmapLinearFilter;
    // Lambert マテリアル: ambient + directional light に反応して面ごとに陰影が出る
    const _innerMat = new THREE.MeshLambertMaterial({ map: _innerTex, fog: true });
    // 0.95m 立方体: 外側 1m の中心に配置 (各面 2.5cm マージン)
    const _innerCube = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.95, 0.95), _innerMat);
    _innerCube.name = 'materialBox-inner';
    _innerCube.renderOrder = 1;
    _innerCube.castShadow = false;
    _innerCube.receiveShadow = false;
    _innerCube.visible = false;
    // scene.add は行わない (ユーザー指示: 移動オブジェクト削除)
    // materialBox の transform 追従は tick 内の materialBox pre-pass 直前で実施 (window.__innerCubeFollow)
    window.__innerCube = _innerCube;
    // 選択ハイライト (他 cube と同じ黄 edges)
    const _matEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(materialBox.geometry),
      new THREE.LineBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 1.0, depthTest: false, fog: false })
    );
    _matEdges.renderOrder = 999;
    _matEdges.visible = false;
    materialBox.add(_matEdges);
    // 物理 userData (他 cube と同じ構造)
    materialBox.userData.__movable = true;
    materialBox.userData.vel     = new THREE.Vector3();
    materialBox.userData.angVel  = new THREE.Vector3();
    materialBox.userData.held    = false;
    materialBox.userData.mass    = 10.0;
    materialBox.userData.sleeping   = false;
    materialBox.userData.restFrames = 0;
    materialBox.userData.targetPos  = null;
    materialBox.userData.ownerId    = null;
    materialBox.userData.initialPos = new THREE.Vector3(3, 0.5, 0);
    // uResolution と bgRT サイズを drawing buffer (renderer.getDrawingBufferSize) に合わせる
    //   ・gl_FragCoord は drawing buffer ピクセル (DPR 倍された値)
    //   ・以前の window.innerWidth/Height ベースだと DPR=2 で UV が 0〜2 に膨らみ、
    //     materialBox の片側しか正しく bgRT をサンプリングできなかった
    const _matDbSize = new THREE.Vector2();
    function _syncMatBoxResolution() {
      renderer.getDrawingBufferSize(_matDbSize);
      _matShader.uniforms.uResolution.value.set(_matDbSize.x, _matDbSize.y);
      // bgRT は half-res (負荷軽減) だが aspect は drawing buffer と一致
      const w = Math.max(256, Math.floor(_matDbSize.x * 0.5));
      const h = Math.max(256, Math.floor(_matDbSize.y * 0.5));
      _matBgRT.setSize(w, h);
    }
    _syncMatBoxResolution();   // 初回同期
    window.addEventListener('resize', _syncMatBoxResolution);
    // 公開 (tick から参照する)
    window.__materialBox   = materialBox;
    window.__matShader     = _matShader;
    window.__matBgRT       = _matBgRT;

    // 波紋スポーナー: 2 秒おきにランダムな面上の点に新規波紋を発生
    //   ・box は 1m 立方 → ランダム点は 6 面のうち 1 面を選び、その面上 UV (±0.5) に配置
    //   ・ripple slot 3 個を round-robin で上書き
    let _rippleSpawnTimer = 0;
    let _rippleSlot = 0;
    function _spawnRipple(nowSec) {
      // 6 面のうち 1 つを選ぶ (face: 0..5)
      const face = Math.floor(Math.random() * 6);
      const u = (Math.random() - 0.5);   // -0.5..+0.5
      const vv = (Math.random() - 0.5);
      let p;
      switch (face) {
        case 0: p = new THREE.Vector3( 0.5,  vv,   u ); break; // +X
        case 1: p = new THREE.Vector3(-0.5,  vv,   u ); break; // -X
        case 2: p = new THREE.Vector3(   u, 0.5,  vv ); break; // +Y
        case 3: p = new THREE.Vector3(   u,-0.5,  vv ); break; // -Y
        case 4: p = new THREE.Vector3(   u,  vv, 0.5 ); break; // +Z
        default:p = new THREE.Vector3(   u,  vv,-0.5 ); break; // -Z
      }
      _matShader.uniforms.uRippleCenter.value[_rippleSlot].copy(p);
      _matShader.uniforms.uRippleStart.value[_rippleSlot] = nowSec;
      _rippleSlot = (_rippleSlot + 1) % 3;
    }
    function _tickMatBoxRipples(dt) {
      const nowSec = _matShader.uniforms.uTime.value;
      _rippleSpawnTimer += dt;
      if (_rippleSpawnTimer >= 2.0) {
        _rippleSpawnTimer -= 2.0;
        _spawnRipple(nowSec);
      }
    }
    window.__tickMatBoxRipples = _tickMatBoxRipples;

    // 一時的に全移動オブジェクトを無効化 (ユーザー指示) — 空配列にすることで
    // 下流の物理 tick / spray 対象登録 / selectables 登録を全スキップ
    const movableCubes = [];
    // 全 movable を transparent-capable に (opacity タグ中に任意の cube を opacity 制御するため)
    if (typeof window.__initCubeTransparent === 'function') window.__initCubeTransparent(movableCubes);

    // ===== Rope ビジュアライザー: 削除 (フレームレート向上のため) =====
    //   旧仕様: grab 中の cube とグラバーを TubeGeometry で接続 (毎フレーム再生成)
    //   → ユーザー指示により削除。_updateRopes は空の no-op を公開。
    window.__updateRopes = function () {};
    const _ropes = new Map();   // 互換性のため残置 (常に空)

    // ===== スプレー基礎パラメータ =====
    const SPRAY_HOLD_MS = 4000;   // 長押し発射までの猶予 (ms)
    const SPRAY_EMIT_HZ = 40;     // 送信頻度 (space1 と同じ 40Hz)
    // raycast 対象リスト (_makePaintable 経由で壁/床/天井が push される)
    const _sprayables = [];

    // ===== ペイントモード派生オブジェクト発生 (wood/river/sky 統合アーキテクチャ) =====
    //   方式: 案5 (チャンク + カメラカリング) ベース + モード汎用化
    //   ・8cm ボクセル (Union-Find) で連結成分管理、ボクセル数が 491 (直径2m円相当)
    //     を超えたクラスタのみ「開放」
    //   ・開放後は 2m×2m×2m チャンク単位の InstancedMesh へボクセル毎に 1 回発火
    //   ・カメラから CULL_DIST 以上のチャンクは visible=false (描画コスト定数化)
    //   ・各モードはジオメトリ・密度・サーフェス制約が別 (MODE_RULES テーブルで差替え)
    //   ・現状スプレー発火は wood のみ有効。river/sky はテーブルを追加するだけで有効化可能。
    //   ・送信元 (sprayer 自身) が検出 → 'modeSpawn' を emit → 全クライアントで描画。
    const MODE_VOXEL = 0.08;                     // 連結距離 = ボクセル辺
    const MODE_VOXEL_MIN_POINTS = 1;             // ボクセル占有の最小スプレー点数
    const MODE_OPEN_VOXELS = 491;                // クラスタ開放閾値 (直径2m円)
    const MODE_HIT_FILL_MAX_R = 0.5;             // 1 ヒットで占有化する tangent disk 最大半径 (m)
    const MODE_OPEN_BURST_PER_TICK = 60;         // 開放瞬間のフレーム分割スパイク回避
    const MODE_CHUNK_SIZE = 2.0;                 // チャンク辺 (m)
    const MODE_CULL_DIST = 25.0;                 // カメラからこの距離を超えたチャンクは非表示 (m)
    const MODE_FAR_LOD_START = 10.0;             // この距離を超えたチャンクは LOD で密度減少 (m)
    const MODE_FAR_LOD_RATIO = 0.5;              // 遠距離時の描画本数倍率 (count を間引き)
    const MODE_CULL_INTERVAL_MS = 200;           // カリング判定の間隔 (全チャンクを毎フレーム走査しない)
    // モード別ルール (ジオメトリ/密度/描画制約)。make() は呼ばれた時に lazy 生成。
    const MODE_RULES = {
      wood: {
        color: '1b5e20',
        perVoxel: 4,                             // 1 ボクセルあたりの本数
        maxPerChunk: 3000,                       // 1 チャンク InstancedMesh の上限 (2m×2m 面 625 vox × 4 本 = 2500 + 余裕)
        makeGeometry: () => _makeGrassGeometry(),
        makeMaterial: () => new THREE.MeshBasicMaterial({
          color: 0x2d8f3a, side: THREE.DoubleSide, transparent: true, opacity: 0.95,
        }),
        scaleJitter: [0.7, 1.3],
        orientUpWithNormal: true,
      },
      // 将来有効化する例 (まだスプレー発火には紐付けていない)
      river: {
        color: '008cdd',
        perVoxel: 1,
        maxPerChunk: 3000,
        makeGeometry: () => _makeFlatTileGeometry(MODE_VOXEL * 1.1),
        makeMaterial: () => _makeRiverShaderMaterial(),   // 案C: 水平タイル専用の軽量 shader
        scaleJitter: [0.9, 1.2],
        orientUpWithNormal: true,                // 水面は面に沿わせる
      },
      sky: {
        color: '002044',
        perVoxel: 2,
        maxPerChunk: 3000,
        makeGeometry: () => _makeBillboardStarGeometry(0.025),
        makeMaterial: () => new THREE.MeshBasicMaterial({
          color: 0xaacfff, transparent: true, opacity: 0.9, depthWrite: false,
        }),
        scaleJitter: [0.5, 1.5],
        orientUpWithNormal: false,               // 星は常にカメラ正対 (手動 billboard)
      },
    };
    // チャンク cap 到達時の再試行上限 (保険)
    const MODE_FIRE_RETRY_LIMIT = 3;
    // 発生アニメーション: スプレーから遅延してフェードイン (塗り始めから順に現れる)
    const MODE_SPAWN_DELAY_MS = 2000;            // スプレー発火から出現開始までの遅延
    const MODE_SPAWN_FADE_MS  = 1000;            // 出現開始から full scale までのフェード時間
    // アニメーション中のエントリ: { blades, appearAt, fadeEnd, done }
    //   blades: 配列 [{ chunk, idx, pos:Vector3, quat:Quaternion, scaleTarget:number }]
    const _modeAnimEntries = [];
    // スプレー発火を有効化するモード集合
    const MODE_SPRAY_ACTIVE = new Set(['wood', 'river']);
    // 色 hex → mode 名の逆引き
    const _modeByColor = new Map();
    for (const [m, r] of Object.entries(MODE_RULES)) _modeByColor.set(r.color.toLowerCase(), m);

    // 検出状態 (sprayer 自身のローカル集計、モード別 Union-Find)
    //   key = 'mode|ix,iy,iz' → { mode, ix, iy, iz, pts, parent, rank, size,
    //                             gateOpen, spawned, nSumX,Y,Z, nCount, lastT }
    const _modeVoxels = new Map();
    // 開放時の遅延発火キュー (sprayer のみ使用)
    const _modePendingLocal = [];
    // チャンク (全クライアント共通)
    //   key = 'mode|cx,cy,cz' → { mode, cx, cy, cz, mesh, count, group }
    const _modeChunks = new Map();
    const _modeChunkDummy = (window.THREE ? new THREE.Object3D() : null);
    // チャンク全体を束ねる group (scene に 1 つだけ add)
    let _modeChunkGroup = null;
    // カメラカリングの throttle
    let _modeLastCullT = 0;

    // ===== 統合アトラス方式ペイント基盤 (space1 同等コスト、1 枚テクスチャ共有) =====
    //   床・4 壁・各 Cube は 1 枚の CanvasTexture (アトラス) を共有し、各メッシュの UV
    //   属性を自領域に remap することで独立に塗り分けられる。1 ドットの GPU 再アップロードは
    //   常にアトラス 1 回のみ (space1 と同じコスト構造)。raycaster の hits[0].uv は remap 後なので
    //   そのままアトラス UV として draw に使える。送受信は { u, v, c } 形式 (アトラス UV)。
    //   【B 案: space1 方式の shader paint + WebGLRenderTarget に置換】
    //   旧: CanvasTexture (Canvas 2D API で描画→毎回 GPU 再アップロード)
    //   新: WebGLRenderTarget に ShaderMaterial で直接 GPU 描画
    //       → ドットごとの CPU→GPU 転送が消滅、フレームレート劣化が構造的に発生しない
    // ペイント shader: 粒状感 + 標準 (非 premultiplied) alpha で RT に層状蓄積
    //   non-premultiplied にすることで overlay 側は三者標準の NormalBlending のまま
    //   読み出せる (alpha の二重乗算が起きない)。
    const _paintShaderMat = new THREE.ShaderMaterial({
      uniforms: {
        u_uvCenter: { value: new THREE.Vector2(0.5, 0.5) },
        u_radius:   { value: 0.02 },
        u_color:    { value: new THREE.Color(1, 1, 1) },
        u_seed:     { value: 0 },
        u_density:  { value: 0.95 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform vec2  u_uvCenter;
        uniform float u_radius;
        uniform vec3  u_color;
        uniform float u_seed;
        uniform float u_density;
        float hash(vec2 p) {
          p = mod(p, vec2(997.0));
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }
        void main() {
          vec2 d = vUv - u_uvCenter;
          float r = length(d);
          if (r > u_radius) discard;
          float falloff = 1.0 - smoothstep(0.0, u_radius, r);
          falloff = pow(falloff, 0.85);
          float n = hash(vUv * 600.0 + vec2(u_seed, u_seed * 1.37));
          float threshold = 1.0 - falloff * u_density;
          if (n < threshold) discard;
          float alpha = clamp(falloff * 0.6 + 0.25, 0.0, 1.0);
          // 非 premultiplied alpha で出力 (overlay 側は NormalBlending)
          gl_FragColor = vec4(u_color, alpha);
        }
      `,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    const _paintScene = new THREE.Scene();
    const _paintCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const _paintQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), _paintShaderMat);
    _paintScene.add(_paintQuad);

    // space1 準拠のブラシ寸法パラメータ
    const SPRAY_HALF_ANGLE  = Math.PI / 9;    // 20° (円錐半角)
    const SPRAY_MAX_WORLD_R = 1.0;            // 最大世界半径 1.0m (= 直径 2m)
    const SPRAY_MIN_UV_R    = 0.003;          // 下限 UV radius (space1 と同じ SPRAY_MIN_UVR)

    // ===== メッシュごとに独立したペイント RT を割り当てる (space1 と同じ分離アプローチ) =====
    //   旧: 1 枚のアトラスを複数メッシュで領域分割していたが、ブラシ半径が領域境界を跨ぐと
    //       隣接する別メッシュ領域に塗料が漏れ、他のメッシュで誤った位置に paint が描かれる
    //       原因になっていた (= 「別の地点にペイントされる」症状)。
    //   新: 各メッシュが自分だけの WebGLRenderTarget を持ち、他メッシュと一切共有しない。
    //       UV 変換も不要 (PlaneGeometry 標準の [0,1] × [0,1] をそのまま使う)。
    //       raycast の hit.uv はそのまま paint shader の u_uvCenter に渡せる。
    //       送受信は { tgt: mesh.name, u, v, c, r (uvR), s (seed) }。
    const _paintables = new Map();   // mesh.name → mesh (sprayable 対象の lookup)
    function _makePaintableRT(res) {
      res = res || 512;
      const rt = new THREE.WebGLRenderTarget(res, res, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        generateMipmaps: false,
        depthBuffer: false,
        stencilBuffer: false,
      });
      rt.texture.wrapS = THREE.ClampToEdgeWrapping;
      rt.texture.wrapT = THREE.ClampToEdgeWrapping;
      // 透明初期化
      const prev = renderer.getRenderTarget();
      const oc = new THREE.Color(); renderer.getClearColor(oc);
      const oa = renderer.getClearAlpha();
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(rt);
      renderer.clear();
      renderer.setRenderTarget(prev);
      renderer.setClearColor(oc, oa);
      return rt;
    }
    // ペイント書き込み (任意の RT に shader pass)
    function _applyPaintTo(rt, uvX, uvY, uvR, colorStr, seed) {
      if (!rt) return;
      _paintShaderMat.uniforms.u_uvCenter.value.set(uvX, uvY);
      _paintShaderMat.uniforms.u_radius.value = (typeof uvR === 'number' && uvR > 0) ? uvR : 0.01;
      _paintShaderMat.uniforms.u_color.value.set(colorStr);
      const seedN = (typeof seed === 'number') ? seed : Date.now();
      _paintShaderMat.uniforms.u_seed.value = ((seedN >>> 0) % 100000) * 0.01;
      const prevTarget = renderer.getRenderTarget();
      const oldAutoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.setRenderTarget(rt);
      renderer.render(_paintScene, _paintCamera);
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = oldAutoClear;
    }
    function _clearAllPaintables() {
      _paintables.forEach((m) => {
        const rt = m.userData && m.userData.paintRT;
        if (!rt) return;
        const prev = renderer.getRenderTarget();
        const oc = new THREE.Color(); renderer.getClearColor(oc);
        const oa = renderer.getClearAlpha();
        renderer.setClearColor(0x000000, 0);
        renderer.setRenderTarget(rt);
        renderer.clear();
        renderer.setRenderTarget(prev);
        renderer.setClearColor(oc, oa);
      });
    }
    // ===== space1 方式: onBeforeCompile で標準マテリアルにペイント合成コードを注入 =====
    //   既存マテリアル (MeshStandardMaterial 等) をそのまま使い、fragment の最終出力直後に
    //   paint RT を OVER 合成する 2 行を挿入する。カスタム ShaderMaterial を一切使わないので
    //   ・three.js の fog / shadow / 照明処理と自然に協調
    //   ・uniform 名の衝突や shadow pass 失敗が起きない
    //   ・per-material customProgramCacheKey で program 共有事故を回避
    function _makePaintable(mesh, worldSpanM, res) {
      if (!mesh || !mesh.material) return mesh;
      if (mesh.userData.paintRT) return mesh;   // 二重注入防止

      const rt = _makePaintableRT(res || 512);
      mesh.userData.paintRT    = rt;
      mesh.userData.worldSpanM = (typeof worldSpanM === 'number' && worldSpanM > 0) ? worldSpanM : 1.0;

      const matsArr = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of matsArr) {
        if (!mat) continue;
        if (!mat.userData) mat.userData = {};
        if (mat.userData.paintInjected) { mat.userData.paintRT = rt; continue; }
        mat.userData.paintRT = rt;

        const userUniform = { value: rt.texture };
        mat.userData.paintUniform = userUniform;
        const origOBC = mat.onBeforeCompile;
        mat.onBeforeCompile = (shader, renderer2) => {
          if (typeof origOBC === 'function') origOBC(shader, renderer2);
          shader.uniforms.u_paint = userUniform;
          // vertex: vPaintUv に uv を転送
          if (shader.vertexShader.indexOf('#include <common>') !== -1) {
            shader.vertexShader = shader.vertexShader.replace(
              '#include <common>',
              '#include <common>\nvarying vec2 vPaintUv;'
            );
          } else {
            shader.vertexShader = 'varying vec2 vPaintUv;\n' + shader.vertexShader;
          }
          shader.vertexShader = shader.vertexShader.replace(
            'void main() {',
            'void main() {\n  vPaintUv = uv;'
          );
          // fragment: 最終合成 (output_fragment / opaque_fragment の直後に OVER 合成)
          if (shader.fragmentShader.indexOf('#include <common>') !== -1) {
            shader.fragmentShader = shader.fragmentShader.replace(
              '#include <common>',
              '#include <common>\nvarying vec2 vPaintUv;\nuniform sampler2D u_paint;'
            );
          } else {
            shader.fragmentShader = 'varying vec2 vPaintUv;\nuniform sampler2D u_paint;\n' + shader.fragmentShader;
          }
          const paintCompose = `
          vec4 _paint = texture2D(u_paint, vPaintUv);
          gl_FragColor.rgb = gl_FragColor.rgb * (1.0 - _paint.a) + _paint.rgb;`;
          let fs = shader.fragmentShader;
          const markers = ['#include <output_fragment>', '#include <opaque_fragment>'];
          let injected = false;
          for (const m of markers) {
            if (fs.indexOf(m) !== -1) {
              fs = fs.replace(m, m + '\n' + paintCompose);
              injected = true;
              break;
            }
          }
          if (!injected) fs = fs.replace(/\}\s*$/, paintCompose + '\n}');
          shader.fragmentShader = fs;
        };
        const _key = 'paintable_' + mat.uuid;
        mat.customProgramCacheKey = function () { return _key; };
        if (!mat.defines) mat.defines = {};
        const _uidHex = mat.uuid.replace(/-/g, '').toUpperCase().substring(0, 16);
        mat.defines['PAINTABLE_MAT_' + _uidHex] = 1;
        mat.userData.paintInjected = true;
        mat.needsUpdate = true;
      }

      if (mesh.name) _paintables.set(mesh.name, mesh);
      _sprayables.push(mesh);
      return mesh;
    }

    // ===== 外壁: 40m × 40m エリアを囲む高さ 20m の 4 面 =====
    const WALL_HALF = 20;
    const WALL_H_M  = 20;
    const WALL_SIDE = 40;
    function _makeWall(id, position, rotYDeg) {
      // 壁 = 標準の MeshStandardMaterial (白、照明/フォグ反応) + onBeforeCompile で paint 合成
      const wall = new THREE.Mesh(
        new THREE.PlaneGeometry(WALL_SIDE, WALL_H_M),
        new THREE.MeshStandardMaterial({
          color: 0xffffff, roughness: 1.0, metalness: 0.0, side: THREE.DoubleSide,
        })
      );
      wall.position.copy(position);
      wall.rotation.y = rotYDeg * Math.PI / 180;
      wall.name = id;
      wall.receiveShadow = true;
      scene.add(wall);
      // worldSpanM: 幅 40m を基準 (brush uvR = worldR/40)
      _makePaintable(wall, WALL_SIDE, 512);

      // 1m グリッド (内側に薄グレー)
      //   PlaneGeometry は中心が原点なので local y 範囲 = -WALL_H_M/2 .. +WALL_H_M/2
      //   (world では wall.position.y=WALL_H_M/2 を足して y=0..WALL_H_M)
      const lines = [];
      const _hy = WALL_H_M / 2;
      for (let i = 0; i <= WALL_SIDE; i++) {
        const x = -WALL_SIDE / 2 + i;
        lines.push(x, -_hy, 0.011,  x, _hy, 0.011);
      }
      for (let j = 0; j <= WALL_H_M; j++) {
        const y = -_hy + j;
        lines.push(-WALL_SIDE / 2, y, 0.011,  WALL_SIDE / 2, y, 0.011);
      }
      const gridGeom = new THREE.BufferGeometry();
      gridGeom.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
      const gridLines = new THREE.LineSegments(gridGeom, new THREE.LineBasicMaterial({ color: 0x9ca3af }));
      gridLines.position.copy(position);
      gridLines.rotation.copy(wall.rotation);
      scene.add(gridLines);

      return wall;
    }
    _makeWall('wall-N', new THREE.Vector3(0, WALL_H_M / 2, -WALL_HALF),   0);
    _makeWall('wall-S', new THREE.Vector3(0, WALL_H_M / 2,  WALL_HALF), 180);
    _makeWall('wall-E', new THREE.Vector3( WALL_HALF, WALL_H_M / 2, 0), -90);
    _makeWall('wall-W', new THREE.Vector3(-WALL_HALF, WALL_H_M / 2, 0),  90);

    // ===== 床をペイント可能化 (既存 floor メッシュに onBeforeCompile で合成を注入) =====
    //   オーバーレイ平面は作らず、床本体に直接塗料を乗せる。
    //   grid / majorGrid / boundary は床の上 (y=0.015〜0.025) にあるので塗料の上に線が見える。
    floor.name = 'floor-paint';
    _makePaintable(floor, FIELD_SIZE, 512);   // 床は 60m x 60m

    // ===== 天面 (天井) 40m × 40m, 高さ WALL_H_M =====
    //   ・床と同じ形状を天高に配置し、内側 (下向き) 向きにする
    //   ・スプレー可能 (ceiling-paint アトラス領域使用)、下面に 1m グリッド
    {
      const ceiling = new THREE.Mesh(
        new THREE.PlaneGeometry(2 * WALL_HALF, 2 * WALL_HALF),
        new THREE.MeshStandardMaterial({
          color: 0xffffff, roughness: 1.0, metalness: 0.0, side: THREE.DoubleSide,
        })
      );
      ceiling.rotation.x = Math.PI / 2;   // 床と逆の向き (法線 -Y = 下向きに内側)
      ceiling.position.set(0, WALL_H_M, 0);
      ceiling.name = 'ceiling';
      ceiling.receiveShadow = true;
      scene.add(ceiling);
      _makePaintable(ceiling, 2 * WALL_HALF, 512);

      // 1m グリッド (ceiling の下面に薄グレー) — 床と同じ密度 (41 + 41 本)
      const _cLines = [];
      for (let i = 0; i <= 2 * WALL_HALF; i++) {
        const x = -WALL_HALF + i;
        _cLines.push(x, -WALL_HALF, 0.011,  x, +WALL_HALF, 0.011);
      }
      for (let j = 0; j <= 2 * WALL_HALF; j++) {
        const z = -WALL_HALF + j;
        _cLines.push(-WALL_HALF, z, 0.011,  +WALL_HALF, z, 0.011);
      }
      const _cGeom = new THREE.BufferGeometry();
      _cGeom.setAttribute('position', new THREE.Float32BufferAttribute(_cLines, 3));
      const _cGrid = new THREE.LineSegments(_cGeom, new THREE.LineBasicMaterial({ color: 0x9ca3af }));
      _cGrid.rotation.x = Math.PI / 2;
      _cGrid.position.set(0, WALL_H_M - 0.02, 0);   // 天面の少し下 (内側)
      scene.add(_cGrid);
    }

    // 可動 Cube/Box: 現状 movableCubes は空のため何もしない (将来再有効化する場合は
    //   _makePaintable(cube, baseColor, worldSpanM=1, 128) で各 cube に独立 paint RT を割り当て)
    void movableCubes;

    // ===== Ancient Tree (FBX) =====
    //   高さ 15m、位置 (10, -1, -10)、モノクロマテリアル、スプレー可能
    //   base (bbox min Y) を Y=-1 に沈める
    (function _loadAncientTree() {
      if (typeof THREE.FBXLoader !== 'function') {
        log('FBXLoader not loaded, ancientTree skipped', 'warn');
        return;
      }
      const loader = new THREE.FBXLoader();
      loader.load('/assets/ancientTREE.fbx', (fbx) => {
        try {
          // 1. 現在の高さ測定 → 15m にスケール
          const bbox0 = new THREE.Box3().setFromObject(fbx);
          const size0 = new THREE.Vector3(); bbox0.getSize(size0);
          const curH = size0.y || 1;
          const scale = 15 / curH;
          fbx.scale.setScalar(scale);
          // 2. 再測定 → XZ 中心を原点に、Y min を 0 に
          const bbox1 = new THREE.Box3().setFromObject(fbx);
          const c1 = new THREE.Vector3(); bbox1.getCenter(c1);
          fbx.position.sub(new THREE.Vector3(c1.x, bbox1.min.y, c1.z));
          // 3. 目標位置へ (Y=-1 で base を 1m 沈める)
          fbx.position.add(new THREE.Vector3(10, -1, -10));
          fbx.name = 'ancientTree';
          scene.add(fbx);
          // 4. 全 sub-mesh をモノクロマテリアルに差し替え + paintable 化
          let paintableN = 0;
          let subIdx = 0;
          fbx.traverse((child) => {
            if (!child || !child.isMesh) return;
            // モノクロ (ambient 0.85 + dir 0.35 の既存ライティングで灰色に光る)
            const monoMat = new THREE.MeshStandardMaterial({
              color: 0x9a9a9a, roughness: 0.9, metalness: 0.05, side: THREE.DoubleSide,
            });
            child.material = monoMat;
            child.castShadow = true;
            child.receiveShadow = true;
            // 一意名を付けて paintable 登録
            const nm = 'tree-mesh-' + subIdx; subIdx++;
            child.name = nm;
            // UV が無い mesh は paintable 不可
            if (!child.geometry || !child.geometry.attributes || !child.geometry.attributes.uv) {
              return;
            }
            // sub-mesh の bounding box 最大辺を worldSpanM に (スケール済み座標で測定)
            const sub = new THREE.Box3().setFromObject(child);
            const subSize = new THREE.Vector3(); sub.getSize(subSize);
            const worldSpan = Math.max(subSize.x, subSize.y, subSize.z) || 1.0;
            _makePaintable(child, worldSpan, 256);
            paintableN++;
          });
          log('ancientTree loaded (' + subIdx + ' meshes, ' + paintableN + ' paintable)', 'ok');
        } catch (e) {
          log('ancientTree setup error: ' + (e && e.message ? e.message : e), 'err');
        }
      }, undefined, (err) => {
        log('ancientTree load failed: ' + (err && err.message ? err.message : err), 'err');
      });
    })();

    // ===== パネル (plate1 / plate2): L 字配置のワイヤーフレーム + ペイント対応キャンバス =====
    //   位置 (0.5, 1, 0) を L の内角 (= 共有縦辺) として、plate1 が +X 方向、plate2 が +Z 方向に伸びる
    //   それぞれ縦長 (W=0.179 × H=0.286)、長辺 (0.286m) は Y 軸に沿った共有縦線で接する
    //   各 plate は独立 paintRT を持ち、タグ付きオブザーバーが居る間だけキャンバス面を可視化
    //   外側は L 字の凹角反対側 (plate1 の outer=-Z、plate2 の outer=-X)
    const PLATE_W = 0.179;
    const PLATE_H = 0.286;
    const PLATE_ORIGIN = new THREE.Vector3(0.9, 1, 0);
    const PLATE_APEX_OFFSET = 0.15;    // L 外側 15cm に apex を独自に持つ
    // L 全体の yaw: 旧 (0 → 共有縦辺中心で plate1 が +X / plate2 が +Z) から +45° 回転
    //   = ユーザー指定の "Yaw -90 → -45" に相当
    const PLATE_WRAPPER_YAW = Math.PI / 4;
    const _plateEdgeMat = new THREE.LineBasicMaterial({ color: 0xeaeded });
    const _platesWrapper = new THREE.Group();
    _platesWrapper.position.copy(PLATE_ORIGIN);
    _platesWrapper.rotation.y = PLATE_WRAPPER_YAW;
    scene.add(_platesWrapper);

    function _makePlate(tagId, offset, rotationY) {
      // offset: 共有縦辺 (wrapper 原点) からの相対オフセット
      // rotationY: plane のローカル Y 軸回転 (wrapper の yaw を上乗せ)
      const grp = new THREE.Group();
      grp.position.copy(offset);
      _platesWrapper.add(grp);
      // キャンバス面 (paint RT 対応、タグ付き時のみ可視化)
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(PLATE_W, PLATE_H),
        new THREE.MeshStandardMaterial({
          color: 0xffffff, side: THREE.DoubleSide, roughness: 1.0, metalness: 0.0,
        })
      );
      mesh.rotation.y = rotationY;
      mesh.name = tagId;
      mesh.visible = false;   // 初期非表示 (タグ付きオブザーバー出現で可視化)
      grp.add(mesh);
      _makePaintable(mesh, PLATE_W, 256);
      // 枠線 (常時可視)
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(mesh.geometry),
        _plateEdgeMat
      );
      edges.rotation.y = rotationY;
      grp.add(edges);
      // 外向き法線 (L 外側方向) = plane normal を反転した向き
      //   PlaneGeometry 標準法線は +Z。rotationY 適用後に world の outer 方向を記録
      const outerLocal = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(0, rotationY, 0));
      grp.userData.plateTag = tagId;
      grp.userData.plateMesh = mesh;
      grp.userData.plateCenter = mesh.position.clone().applyEuler(new THREE.Euler(0, 0, 0)).add(grp.position);
      grp.userData.plateOuter = outerLocal.clone();   // world 方向ベクトル (単位ベクトル)
      return grp;
    }
    // plate1: +X 側に PLATE_W/2 ずらし、normal = +Z (plane のまま)、outer = -Z
    const _plate1Grp = _makePlate('plate1', new THREE.Vector3(PLATE_W / 2, 0, 0), 0);
    // plate2: +Z 側に PLATE_W/2 ずらし、rotation.y=+π/2 で normal を L 字凹角側 (= +X 方向) に向ける
    //   旧 -π/2 だと normal が凸角側に向き、apex が内側にスナップされていた問題を修正
    const _plate2Grp = _makePlate('plate2', new THREE.Vector3(0, 0, PLATE_W / 2), Math.PI / 2);
    const _plates = { plate1: _plate1Grp, plate2: _plate2Grp };
    window.__plates = _plates;
    // プレートは専用レイヤー (= 2) に移動。master / camera のカメラだけこのレイヤーを enable し、
    //   observer のカメラは標準レイヤー 0 のみ → observer 視点では自他問わず全プレートが非表示に。
    const PLATE_LAYER = 2;
    (function _setPlateLayerRec(obj) {
      obj.layers.set(PLATE_LAYER);
      obj.children.forEach(_setPlateLayerRec);
    })(_plate1Grp);
    (function _setPlateLayerRec(obj) {
      obj.layers.set(PLATE_LAYER);
      obj.children.forEach(_setPlateLayerRec);
    })(_plate2Grp);
    if (ROLE === 'master' || ROLE === 'camera') {
      camera.layers.enable(PLATE_LAYER);
    }

    // タグ付きオブザーバーの存在チェック → plateMesh.visible を更新
    function _syncPlateVisibility() {
      for (const tag of ['plate1', 'plate2']) {
        const grp = _plates[tag]; if (!grp) continue;
        let hasOwner = false;
        avatars.forEach((a) => {
          if (a && a.customTags && a.customTags.indexOf(tag) >= 0) hasOwner = true;
        });
        grp.userData.plateMesh.visible = hasOwner;
      }
    }
    window.__syncPlateVisibility = _syncPlateVisibility;
    // 自分の plate タグ (観察者がオフアクシス ON 時の表示先に使う) を取得
    function _getMyPlateGrp() {
      if (ROLE !== 'observer') return null;
      const self = (myId != null) ? avatars.get(myId) : null;
      if (!self || !self.customTags) return null;
      for (const tag of ['plate1', 'plate2']) {
        if (self.customTags.indexOf(tag) >= 0) return _plates[tag];
      }
      return null;
    }
    window.__getMyPlateGrp = _getMyPlateGrp;

    // ===== ミニチュア塗り Box (20cm): 空間の塗り状況をライブ反映 =====
    //   位置 (1, 1, 0) 固定、各面に対応する壁/床/天井の paintRT.texture を map。
    //   塗っていない所 (alpha=0) は alphaTest で透過。
    //   回転は "最新入室 camera" の avatar.grp.quaternion を毎フレーム コピー
    //   (phone の前方傾きがそのまま cube の前方傾きになる direct mirror)。
    //   #eaeded の 2px 境界ラインを EdgesGeometry で付与。
    const MINI_SIZE = 0.08;   // 8cm × 8cm × 8cm
    let _miniCube = null;
    function _getPaintTex(name) {
      const m = _paintables.get(name);
      return (m && m.userData && m.userData.paintRT) ? m.userData.paintRT.texture : null;
    }
    function _miniFaceMat(name) {
      return new THREE.MeshBasicMaterial({
        map: _getPaintTex(name),
        transparent: true,
        alphaTest: 0.01,
        side: THREE.DoubleSide,
      });
    }
    {
      const geom = new THREE.BoxGeometry(MINI_SIZE, MINI_SIZE, MINI_SIZE);
      // BoxGeometry のマテリアル配列順: [+X, -X, +Y, -Y, +Z, -Z]
      //   内側 "mirror": observer が cube の +X 側から覗き込むと、空間を +X 方向 (= 壁 wall-E) 側へ
      //   実際に歩いて見るのと同じ内容が見える、という思想
      const mats = [
        _miniFaceMat('wall-E'),       // +X
        _miniFaceMat('wall-W'),       // -X
        _miniFaceMat('ceiling'),      // +Y
        _miniFaceMat('floor-paint'),  // -Y
        _miniFaceMat('wall-S'),       // +Z
        _miniFaceMat('wall-N'),       // -Z
      ];
      _miniCube = new THREE.Mesh(geom, mats);
      _miniCube.position.set(1, 1, 0);
      _miniCube.name = 'mini-paint-cube';
      scene.add(_miniCube);
      // #eaeded, 2px の境界
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geom),
        new THREE.LineBasicMaterial({ color: 0xeaeded, linewidth: 2 })
      );
      edges.name = 'mini-paint-cube-edges';
      _miniCube.add(edges);
    }
    // 最新入室 camera avatar の quaternion を毎フレーム cube に反映
    function _findLatestCameraAvatar() {
      let latest = null;
      // avatars は Map。挿入順で最後の camera-role を取る
      avatars.forEach((av) => { if (av && av.role === 'camera') latest = av; });
      return latest;
    }
    function _updateMiniCube() {
      if (!_miniCube) return;
      const av = _findLatestCameraAvatar();
      if (!av || !av.grp) return;
      _miniCube.quaternion.copy(av.grp.quaternion);
    }
    // updaters は後方で宣言されるため、ここでは window に保留。後で push される。
    window.__miniCubeUpdater = _updateMiniCube;

    // スプレー状態 (self): press-and-hold で発射開始、release で停止
    const _spraySelf = {
      pressStartT: 0,          // press 開始時刻 (ms)、0 = press 中でない
      armed: false,            // 4 秒経過して発射中か
      lastEmitT: 0,            // 直近送信時刻
    };
    const _sprayRay = new THREE.Raycaster();
    const _sprayOrigin = new THREE.Vector3();
    const _sprayDir    = new THREE.Vector3();

    // ===== Spray 同期最適化 (A: 送信側バッチ, C: volatile emit) =====
    //   40Hz × カメラ数 の個別 emit を 50ms 窓でまとめる。
    //   volatile で送るので受信側が slow な場合は drop → キュー詰まり防止。
    const SPRAY_BATCH_INTERVAL_MS = 50;
    const _sprayOutBuf = [];
    let _sprayOutLastFlushT = 0;
    function _sprayFlushTick() {
      if (_sprayOutBuf.length === 0) return;
      const now = performance.now();
      if (now - _sprayOutLastFlushT < SPRAY_BATCH_INTERVAL_MS) return;
      _sprayOutLastFlushT = now;
      if (socket && socket.connected) {
        // consistency 優先: reliable 配信 (volatile 廃止)
        const packet = _sprayOutBuf.splice(0);
        socket.emit('spray2Batch', packet);
      } else {
        // 未接続中は buffer を破棄 (再接続後も古い打点は不要)
        _sprayOutBuf.length = 0;
      }
    }

    // ===== Spray 受信側合流 (G: rAF 内 1 回に合流) =====
    //   個別 _applyRemoteSpray を複数回/フレーム呼ばれても GPU 書込みは
    //   requestAnimationFrame 内の 1 ループに集約し、パイプラインの詰まりを解消。
    const _applyRemoteBuf = [];
    let _applyRemoteScheduled = false;
    // 実関数本体は socket.on('connect') ブロック内で定義 (後方で代入)
    let _applyRemoteSprayImmediate = null;
    function _scheduleApplyRemote(data) {
      if (typeof _applyRemoteSprayImmediate !== 'function') return;
      _applyRemoteBuf.push(data);
      if (_applyRemoteScheduled) return;
      _applyRemoteScheduled = true;
      requestAnimationFrame(() => {
        _applyRemoteScheduled = false;
        const batch = _applyRemoteBuf.splice(0);
        for (const d of batch) _applyRemoteSprayImmediate(d);
      });
    }

    // ============ モード別ジオメトリ ============
    function _makeGrassGeometry() {
      const g = new THREE.BufferGeometry();
      const H = 0.06, W = 0.012;
      const positions = new Float32Array([
        -W / 2, 0, 0,   W / 2, 0, 0,   W / 2, H, 0,  -W / 2, H, 0,
         0, 0, -W / 2,  0, 0, W / 2,   0, H, W / 2,   0, H, -W / 2,
      ]);
      const indices = [0,1,2, 0,2,3, 4,5,6, 4,6,7];
      g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      g.setIndex(indices);
      g.computeVertexNormals();
      return g;
    }
    function _makeFlatTileGeometry(size) {
      const g = new THREE.PlaneGeometry(size, size);
      g.rotateX(-Math.PI / 2);  // 水平、normal は +Y
      return g;
    }

    // 川モード用: space3 の materialBox から低解像度ノイズ生成を流用 (bgRT & 頂点変位は廃止)
    //   32×32 の低周波ノイズを Linear filter で upscale → 大きな滑らかな blob 感を得る
    let _sharedRiverNoiseTex = null;
    function _ensureSharedRiverNoise() {
      if (_sharedRiverNoiseTex) return _sharedRiverNoiseTex;
      const SIZE = 32;
      const cv = document.createElement('canvas');
      cv.width = SIZE; cv.height = SIZE;
      const ctx = cv.getContext('2d');
      const img = ctx.createImageData(SIZE, SIZE);
      for (let i = 0; i < img.data.length; i += 4) {
        img.data[i    ] = (Math.random() * 255) | 0;
        img.data[i + 1] = (Math.random() * 255) | 0;
        img.data[i + 2] = (Math.random() * 255) | 0;
        img.data[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      const tex = new THREE.CanvasTexture(cv);
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearFilter;
      _sharedRiverNoiseTex = tex;
      return tex;
    }
    // 全 river チャンクで uTime を共有するための共通 uniforms (ShaderMaterial.uniforms を同一参照化)
    const _sharedRiverUniforms = {
      uNoise:     { value: null },
      uTime:      { value: 0 },
      uBaseColor: { value: null },
      uOpacity:   { value: 0.75 },
    };
    function _makeRiverShaderMaterial() {
      if (!_sharedRiverUniforms.uNoise.value) _sharedRiverUniforms.uNoise.value = _ensureSharedRiverNoise();
      if (!_sharedRiverUniforms.uBaseColor.value) _sharedRiverUniforms.uBaseColor.value = new THREE.Color(0x1aa0e8);
      // World-space UV サンプリング: 隣接タイル同士で位相連続 (格子感を消す)
      // 頂点変位・bgRT 廃止、fragment だけでさざ波 (ノイズ2枚スクロール + Fresnel 風ハイライト)
      return new THREE.ShaderMaterial({
        uniforms: _sharedRiverUniforms,
        vertexShader: `
          varying vec2 vWxz;
          varying vec3 vViewDir;
          varying vec3 vNormal;
          void main() {
            // InstancedMesh: instanceMatrix を適用
            vec4 wPos = modelMatrix * instanceMatrix * vec4(position, 1.0);
            vWxz = wPos.xz;
            vec4 mvPos = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
            vViewDir = normalize(-mvPos.xyz);
            vNormal  = normalize(normalMatrix * normal);
            gl_Position = projectionMatrix * mvPos;
          }
        `,
        fragmentShader: `
          uniform sampler2D uNoise;
          uniform float uTime;
          uniform vec3  uBaseColor;
          uniform float uOpacity;
          varying vec2 vWxz;
          varying vec3 vViewDir;
          varying vec3 vNormal;
          void main() {
            // World-space ノイズサンプリング (タイル境界で phase 連続)
            vec2 n1 = texture2D(uNoise, vWxz * 1.2 + vec2(uTime * 0.07,  uTime * 0.04)).rg;
            vec2 n2 = texture2D(uNoise, vWxz * 0.8 - vec2(uTime * 0.05, -uTime * 0.06)).rg;
            float wave = (n1.r + n2.r - 1.0);
            // Fresnel 風エッジ: 視線と法線の角度で縁を強調
            float fres = pow(1.0 - max(dot(vNormal, vViewDir), 0.0), 2.5);
            // ハイライト: ノイズピークを閾値越えで光らせる
            float sparkle = pow(max(0.0, wave + 0.3), 4.0) * 0.6;
            vec3 col = uBaseColor + wave * 0.12 + vec3(sparkle);
            col = mix(col, vec3(1.0), fres * 0.25);
            gl_FragColor = vec4(col, uOpacity);
          }
        `,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
    }
    function _makeBillboardStarGeometry(size) {
      const g = new THREE.PlaneGeometry(size, size);
      return g;
    }

    // ============ Union-Find ============
    function _modeFind(b) {
      while (b.parent !== b) { b.parent = b.parent.parent; b = b.parent; }
      return b;
    }
    function _modeUnion(a, b) {
      const ra = _modeFind(a), rb = _modeFind(b);
      if (ra === rb) return ra;
      if (ra.rank < rb.rank) {
        ra.parent = rb; rb.size += ra.size; rb.gateOpen = rb.gateOpen || ra.gateOpen; return rb;
      } else if (ra.rank > rb.rank) {
        rb.parent = ra; ra.size += rb.size; ra.gateOpen = ra.gateOpen || rb.gateOpen; return ra;
      } else {
        rb.parent = ra; ra.rank++; ra.size += rb.size; ra.gateOpen = ra.gateOpen || rb.gateOpen; return ra;
      }
    }

    // ============ チャンク管理 ============
    function _ensureChunkGroup() {
      if (_modeChunkGroup) return _modeChunkGroup;
      _modeChunkGroup = new THREE.Group();
      _modeChunkGroup.name = 'mode-spawn-root';
      scene.add(_modeChunkGroup);
      return _modeChunkGroup;
    }
    function _chunkKey(mode, cx, cy, cz) { return mode + '|' + cx + ',' + cy + ',' + cz; }
    function _ensureChunk(mode, cx, cy, cz) {
      const key = _chunkKey(mode, cx, cy, cz);
      let ch = _modeChunks.get(key);
      if (ch) return ch;
      const rule = MODE_RULES[mode]; if (!rule) return null;
      const group = _ensureChunkGroup();
      const geom = rule.makeGeometry();
      const mat  = rule.makeMaterial();
      const mesh = new THREE.InstancedMesh(geom, mat, rule.maxPerChunk);
      mesh.count = 0;
      mesh.name = 'chunk-' + key;
      mesh.frustumCulled = false;  // カリングは手動 (距離ベース)
      // チャンク中心にメッシュを置くわけではない: 各 instance は world 座標で配置する
      // 位置リセットは group の 0,0,0 のまま。(mesh.position = 0,0,0)
      group.add(mesh);
      ch = { mode, cx, cy, cz, mesh, count: 0, lodActive: false,
             cxWorld: (cx + 0.5) * MODE_CHUNK_SIZE,
             cyWorld: (cy + 0.5) * MODE_CHUNK_SIZE, czWorld: (cz + 0.5) * MODE_CHUNK_SIZE,
             instanceMeta: [] };  // index 対応: 各 instance の { ix, iy, iz, pos, quat, scaleTarget, fadingOut }
      _modeChunks.set(key, ch);
      return ch;
    }
    function _chunkOfWorld(mode, wx, wy, wz) {
      const cx = Math.floor(wx / MODE_CHUNK_SIZE);
      const cy = Math.floor(wy / MODE_CHUNK_SIZE);
      const cz = Math.floor(wz / MODE_CHUNK_SIZE);
      return _ensureChunk(mode, cx, cy, cz);
    }

    // カメラカリング + 距離 LOD:
    //   d <= FAR_LOD_START              → 可視, full count
    //   FAR_LOD_START < d <= CULL_DIST  → 可視, count = full × FAR_LOD_RATIO (間引き)
    //   d > CULL_DIST                   → 不可視
    // 発火順はランダム散布なので、末尾を間引く形でも空間的に均等に残る。
    const _modeCullCamPos = (window.THREE ? new THREE.Vector3() : null);
    function _modeCullTick() {
      const nowT = performance.now();
      if (nowT - _modeLastCullT < MODE_CULL_INTERVAL_MS) return;
      _modeLastCullT = nowT;
      if (!camera || !_modeChunkGroup) return;
      camera.getWorldPosition(_modeCullCamPos);
      const cullD2 = MODE_CULL_DIST * MODE_CULL_DIST;
      const lodD2  = MODE_FAR_LOD_START * MODE_FAR_LOD_START;
      for (const ch of _modeChunks.values()) {
        const dx = ch.cxWorld - _modeCullCamPos.x;
        const dy = ch.cyWorld - _modeCullCamPos.y;
        const dz = ch.czWorld - _modeCullCamPos.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > cullD2) {
          if (ch.mesh.visible) ch.mesh.visible = false;
          ch.lodActive = false;
          continue;
        }
        if (!ch.mesh.visible) ch.mesh.visible = true;
        if (d2 > lodD2) {
          // 遠距離 LOD: count を間引く
          const lodCount = Math.floor(ch.count * MODE_FAR_LOD_RATIO);
          if (ch.mesh.count !== lodCount) ch.mesh.count = lodCount;
          ch.lodActive = true;
        } else {
          // 近距離: full
          if (ch.mesh.count !== ch.count) ch.mesh.count = ch.count;
          ch.lodActive = false;
        }
      }
    }

    // ============ ジオメトリ補助 (法線→quaternion) ============
    const _modeAxisY = new THREE.Vector3(0, 1, 0);
    const _modeTmpV1 = new THREE.Vector3();
    const _modeTmpV2 = new THREE.Vector3();
    const _modeTmpQ  = new THREE.Quaternion();
    function _modeOrientQuat(nx, ny, nz, outQ) {
      _modeTmpV1.set(nx, ny, nz);
      if (_modeTmpV1.lengthSq() < 1e-6) { outQ.identity(); return; }
      _modeTmpV1.normalize();
      outQ.setFromUnitVectors(_modeAxisY, _modeTmpV1);
    }

    // ============ 発火 (ボクセル → チャンクの InstancedMesh へ) ============
    //   data: { mode, x, y, z, nx, ny, nz, r }
    //   戻り値: true=少なくとも1本描画成功 / false=チャンク cap で失敗 (呼び出し側で再試行可)
    //   history batch (初期ロード) 専用: フェードなしで即座にフル描画
    function _renderModeSpawnImmediate(data) {
      return _renderModeSpawnCore(data, 1.0, null);
    }
    // アニメーション用: 初期スケール 0 でスロット確保しつつ per-blade メタを返す
    //   collected: push 先の配列。各 blade は { chunk, idx, pos, quat, scaleTarget }
    function _allocateAnimatedBlades(data, collected) {
      return _renderModeSpawnCore(data, 0.0, collected);
    }
    // 内部実装: initialScaleFactor で描画スケールを制御、collected 非null時は per-blade メタ収集
    function _renderModeSpawnCore(data, initialScaleFactor, collected) {
      if (!data || !data.mode) return false;
      const rule = MODE_RULES[data.mode]; if (!rule) return false;
      const ch = _chunkOfWorld(data.mode, data.x, data.y, data.z);
      if (!ch) return false;
      if (ch.count >= rule.maxPerChunk) return false;
      const startCount = ch.count;
      // ペイロードは voxel 中心座標 (surface offset は render 側で後付け)。
      // _modeFireVoxel で `cx = (b.ix + 0.5) * VOXEL` と書いているので、逆算は
      //   ix = round(data.x / VOXEL - 0.5)
      // これで overwrite fade-out が instanceMeta.ix と確実に一致する。
      const vIx = Math.round(data.x / MODE_VOXEL - 0.5);
      const vIy = Math.round(data.y / MODE_VOXEL - 0.5);
      const vIz = Math.round(data.z / MODE_VOXEL - 0.5);
      const r = Math.max(0.01, Math.min(0.5, data.r || MODE_VOXEL * 0.5));
      const n = rule.perVoxel;
      _modeOrientQuat(data.nx || 0, data.ny || 1, data.nz || 0, _modeTmpQ);
      const nrm = _modeTmpV1.set(data.nx || 0, data.ny || 1, data.nz || 0);
      if (nrm.lengthSq() < 1e-6) nrm.set(0, 1, 0);
      nrm.normalize();
      const t1 = _modeTmpV2.set(1, 0, 0);
      if (Math.abs(nrm.dot(t1)) > 0.9) t1.set(0, 0, 1);
      t1.sub(nrm.clone().multiplyScalar(nrm.dot(t1))).normalize();
      const t2 = new THREE.Vector3().crossVectors(nrm, t1).normalize();
      const [sMin, sMax] = rule.scaleJitter;
      for (let i = 0; i < n; i++) {
        if (ch.count >= rule.maxPerChunk) break;
        const rr = Math.sqrt(Math.random()) * r;
        const th = Math.random() * Math.PI * 2;
        const dx = Math.cos(th) * rr, dy = Math.sin(th) * rr;
        // 配置オフセット: 法線方向に (半ボクセル + 1mm) ずらすことで、ボクセル中心が
        // 面の反対側に落ちた時でも必ずサーフェスの表側 (+normal 側) に配置される。
        // (例: 床 Y=0 でヒット Y が ±1e-9 の精度誤差により voxel iy が 0 / -1 に揺れても
        //  面の上に水面タイルを置ける)
        const surfOff = rule.orientUpWithNormal ? (MODE_VOXEL * 0.5 + 0.001) : 0;
        const px = data.x + t1.x * dx + t2.x * dy + nrm.x * surfOff;
        const py = data.y + t1.y * dx + t2.y * dy + nrm.y * surfOff;
        const pz = data.z + t1.z * dx + t2.z * dy + nrm.z * surfOff;
        _modeChunkDummy.position.set(px, py, pz);
        if (rule.orientUpWithNormal) {
          _modeChunkDummy.quaternion.copy(_modeTmpQ);
          _modeChunkDummy.rotateY(Math.random() * Math.PI);
        } else {
          _modeChunkDummy.quaternion.identity();
        }
        const sTarget = sMin + Math.random() * (sMax - sMin);
        _modeChunkDummy.scale.setScalar(sTarget * initialScaleFactor);
        _modeChunkDummy.updateMatrix();
        ch.mesh.setMatrixAt(ch.count, _modeChunkDummy.matrix);
        const posClone  = _modeChunkDummy.position.clone();
        const quatClone = _modeChunkDummy.quaternion.clone();
        // 全 instance にメタ記録 (overwrite fade-out で検索に使う)
        ch.instanceMeta[ch.count] = {
          ix: vIx, iy: vIy, iz: vIz,
          pos: posClone, quat: quatClone, scaleTarget: sTarget,
          fadingOut: false,
        };
        if (collected) {
          collected.push({
            chunk: ch,
            idx: ch.count,
            pos: posClone,
            quat: quatClone,
            scaleTarget: sTarget,
          });
        }
        ch.count++;
      }
      // LOD 中のチャンクに追加された場合は間引き count を保つ (次 cull tick で正確化)
      ch.mesh.count = ch.lodActive
        ? Math.floor(ch.count * MODE_FAR_LOD_RATIO)
        : ch.count;
      ch.mesh.instanceMatrix.needsUpdate = true;
      return ch.count > startCount;
    }

    function _clearAllModeSpawn() {
      for (const ch of _modeChunks.values()) {
        ch.count = 0;
        ch.mesh.count = 0;
        ch.instanceMeta.length = 0;
        ch.mesh.instanceMatrix.needsUpdate = true;
      }
      _modeVoxels.clear();
      _modePendingLocal.length = 0;
      _modeAnimEntries.length = 0;
    }

    // ============ 発生アニメーション ============
    //   遅延 MODE_SPAWN_DELAY_MS 後に allocate、以降 MODE_SPAWN_FADE_MS でスケール 0→1 補間
    //   戻り値: スケジュール成功 (true) / 不正データ (false)
    function _renderModeSpawnAt(data) {
      if (!data || !data.mode) return false;
      if (!MODE_RULES[data.mode]) return false;
      const now = performance.now();
      _modeAnimEntries.push({
        data,
        appearAt: now + MODE_SPAWN_DELAY_MS,
        fadeEnd:  now + MODE_SPAWN_DELAY_MS + MODE_SPAWN_FADE_MS,
        blades: null,
        done: false,
        retryCount: 0,
      });
      return true;
    }

    // ============ Overwrite fade-out ============
    //   指定モードの (ix,iy,iz) ボクセルに属する instance 群を 1 秒で scale→0 させる
    //   他モードが同じ voxel に塗装された時に呼ばれる (塗り替え表現)
    function _tryFadeOutModeAt(mode, ix, iy, iz) {
      if (!MODE_RULES[mode]) return;
      // 対象 chunk 計算
      const wx = (ix + 0.5) * MODE_VOXEL;
      const wy = (iy + 0.5) * MODE_VOXEL;
      const wz = (iz + 0.5) * MODE_VOXEL;
      const cx = Math.floor(wx / MODE_CHUNK_SIZE);
      const cy = Math.floor(wy / MODE_CHUNK_SIZE);
      const cz = Math.floor(wz / MODE_CHUNK_SIZE);
      const ch = _modeChunks.get(_chunkKey(mode, cx, cy, cz));
      if (!ch) return;
      // instanceMeta から該当 voxel の instance を抽出
      const blades = [];
      for (let i = 0; i < ch.instanceMeta.length; i++) {
        const m = ch.instanceMeta[i];
        if (!m) continue;
        if (m.fadingOut) continue;
        if (m.ix === ix && m.iy === iy && m.iz === iz) {
          m.fadingOut = true;
          blades.push({ chunk: ch, idx: i, pos: m.pos, quat: m.quat, scaleTarget: m.scaleTarget });
        }
      }
      if (blades.length === 0) return;
      const now = performance.now();
      _modeAnimEntries.push({
        data: null, blades,
        appearAt: now,
        fadeEnd: now + MODE_SPAWN_FADE_MS,
        done: false, retryCount: 0,
        isFadeOut: true,
      });
    }

    function _modeAnimTick() {
      if (_modeAnimEntries.length === 0) return;
      const now = performance.now();
      const dirtyMeshes = new Set();
      let hasDone = false;
      for (let i = 0; i < _modeAnimEntries.length; i++) {
        const e = _modeAnimEntries[i];
        if (e.done) { hasDone = true; continue; }
        if (now < e.appearAt) continue;
        // 初回: allocate (chunk cap 失敗時は retry) ─ fade-out は allocate 不要
        if (!e.blades && !e.isFadeOut) {
          const list = [];
          const ok = _allocateAnimatedBlades(e.data, list);
          if (!ok || list.length === 0) {
            e.retryCount++;
            if (e.retryCount > MODE_FIRE_RETRY_LIMIT) {
              _modeDbgDropped++;
              e.done = true;
              hasDone = true;
            }
            continue;
          }
          e.blades = list;
          for (const bl of e.blades) dirtyMeshes.add(bl.chunk.mesh);
          continue;  // 同フレームでフェード進行までは待つ
        }
        if (!e.blades) continue;
        // フェード進行 (fade-in: 0→1 / fade-out: 1→0)
        const t = Math.min(1, (now - e.appearAt) / MODE_SPAWN_FADE_MS);
        const sFactor = e.isFadeOut ? (1 - t) : t;
        for (const bl of e.blades) {
          _modeChunkDummy.position.copy(bl.pos);
          _modeChunkDummy.quaternion.copy(bl.quat);
          _modeChunkDummy.scale.setScalar(bl.scaleTarget * sFactor);
          _modeChunkDummy.updateMatrix();
          bl.chunk.mesh.setMatrixAt(bl.idx, _modeChunkDummy.matrix);
          dirtyMeshes.add(bl.chunk.mesh);
        }
        if (t >= 1) { e.done = true; hasDone = true; }
      }
      for (const m of dirtyMeshes) m.instanceMatrix.needsUpdate = true;
      // Cleanup: 済みエントリを削除 (低頻度)
      if (hasDone) {
        let w = 0;
        for (let i = 0; i < _modeAnimEntries.length; i++) {
          if (!_modeAnimEntries[i].done) _modeAnimEntries[w++] = _modeAnimEntries[i];
        }
        _modeAnimEntries.length = w;
      }
    }

    // sprayer 自身用: 1 ボクセル発火 (スケジュールのみ、実描画は anim tick 側で 2s 後に allocate)
    function _modeFireVoxel(b) {
      if (b.spawned) return;
      const cx = (b.ix + 0.5) * MODE_VOXEL;
      const cy = (b.iy + 0.5) * MODE_VOXEL;
      const cz = (b.iz + 0.5) * MODE_VOXEL;
      const nlen = Math.hypot(b.nSumX, b.nSumY, b.nSumZ) || 1;
      const nx = b.nSumX / nlen, ny = b.nSumY / nlen, nz = b.nSumZ / nlen;
      const payload = {
        mode: b.mode,
        x: +cx.toFixed(4), y: +cy.toFixed(4), z: +cz.toFixed(4),
        nx: +nx.toFixed(4), ny: +ny.toFixed(4), nz: +nz.toFixed(4),
        r: +(MODE_VOXEL * 0.5).toFixed(4),
      };
      // スケジュールしてフェード付き描画 (chunk cap リトライは anim tick 側で処理)
      _renderModeSpawnAt(payload);
      b.spawned = true;
      // sprayer のみ emit (remote は受信して独自に anim スケジュール)
      if (socket && socket.connected) socket.emit('modeSpawn', payload);
    }
    function _modeEnqueueBurst(root) {
      let n = 0;
      for (const b of _modeVoxels.values()) {
        if (b.mode !== root.mode) continue;
        if (_modeFind(b) !== root) continue;
        if (b.spawned) continue;
        _modePendingLocal.push(b);
        n++;
      }
      log('[mode] gate open: ' + root.mode + ' (voxels=' + root.size + ', burst=' + n + ')', 'ok');
    }
    function _modeBurstTick() {
      if (_modePendingLocal.length === 0) return;
      const take = Math.min(MODE_OPEN_BURST_PER_TICK, _modePendingLocal.length);
      for (let i = 0; i < take; i++) {
        const b = _modePendingLocal.shift();
        if (!b || b.spawned) continue;
        _modeFireVoxel(b);
      }
    }
    function _modeOccupyVoxel(mode, ix, iy, iz, nx, ny, nz) {
      const key = mode + '|' + ix + ',' + iy + ',' + iz;
      let bucket = _modeVoxels.get(key);
      if (!bucket) {
        bucket = {
          mode, ix, iy, iz,
          pts: 0,
          parent: null, rank: 0, size: 1,
          gateOpen: false, spawned: false,
          nSumX: 0, nSumY: 0, nSumZ: 0, nCount: 0,
        };
        bucket.parent = bucket;
        _modeVoxels.set(key, bucket);
      }
      bucket.pts++;
      bucket.nSumX += nx; bucket.nSumY += ny; bucket.nSumZ += nz;
      bucket.nCount++;
      if (bucket.pts < MODE_VOXEL_MIN_POINTS) return null;
      // 26 近傍マージ (同一モードのみ)
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        if (!dx && !dy && !dz) continue;
        const nk = mode + '|' + (ix + dx) + ',' + (iy + dy) + ',' + (iz + dz);
        const nb = _modeVoxels.get(nk);
        if (!nb) continue;
        if (nb.pts < MODE_VOXEL_MIN_POINTS) continue;
        _modeUnion(bucket, nb);
      }
      return bucket;
    }

    // sprayer のヒット → 色から mode 解決 → tangent disk で各ボクセルを占有化
    const _tmpT1 = new THREE.Vector3();
    const _tmpT2 = new THREE.Vector3();
    const _tmpNrm = new THREE.Vector3();
    function _pushPaintHit(worldPt, normal, worldR, colorHex) {
      if (!worldPt || !normal || !colorHex) return;
      const mode = _modeByColor.get(colorHex.toLowerCase());
      if (!mode || !MODE_SPRAY_ACTIVE.has(mode)) return;
      const r = Math.min(MODE_HIT_FILL_MAX_R, Math.max(MODE_VOXEL, worldR || MODE_VOXEL));
      _tmpNrm.set(normal.x, normal.y, normal.z);
      if (_tmpNrm.lengthSq() < 1e-6) _tmpNrm.set(0, 1, 0);
      _tmpNrm.normalize();
      _tmpT1.set(1, 0, 0);
      if (Math.abs(_tmpNrm.dot(_tmpT1)) > 0.9) _tmpT1.set(0, 0, 1);
      _tmpT1.sub(_tmpNrm.clone().multiplyScalar(_tmpNrm.dot(_tmpT1))).normalize();
      _tmpT2.copy(_tmpNrm).cross(_tmpT1).normalize();
      const openRoots = new Set();
      const touchedBuckets = [];
      const step = MODE_VOXEL;
      const rr = r * r;
      for (let a = -r; a <= r + 1e-6; a += step) {
        for (let b = -r; b <= r + 1e-6; b += step) {
          if (a * a + b * b > rr) continue;
          const px = worldPt.x + _tmpT1.x * a + _tmpT2.x * b;
          const py = worldPt.y + _tmpT1.y * a + _tmpT2.y * b;
          const pz = worldPt.z + _tmpT1.z * a + _tmpT2.z * b;
          const ix = Math.floor(px / MODE_VOXEL);
          const iy = Math.floor(py / MODE_VOXEL);
          const iz = Math.floor(pz / MODE_VOXEL);
          const bucket = _modeOccupyVoxel(mode, ix, iy, iz, _tmpNrm.x, _tmpNrm.y, _tmpNrm.z);
          if (bucket) {
            touchedBuckets.push(bucket);
            // 塗り替え: 同じ voxel に属する他モードの instance をフェードアウト
            for (const otherMode of Object.keys(MODE_RULES)) {
              if (otherMode === mode) continue;
              _tryFadeOutModeAt(otherMode, ix, iy, iz);
              if (socket && socket.connected) {
                socket.emit('modeOverwrite', { mode: otherMode, ix, iy, iz });
              }
            }
          }
        }
      }
      for (const bucket of touchedBuckets) {
        const root = _modeFind(bucket);
        if (!root.gateOpen) {
          if (root.size >= MODE_OPEN_VOXELS && !openRoots.has(root)) {
            root.gateOpen = true;
            openRoots.add(root);
            _modeEnqueueBurst(root);
          }
          continue;
        }
        _modeFireVoxel(bucket);
      }
    }
    // mode spawn の chunk cap 到達で諦めた本数カウンタ (ログ廃止後も内部計測だけ保持)
    let _modeDbgDropped = 0;
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
      // カメラ前方レイで paintable 対象にヒット → UV 取得 → 塗る + emit
      camera.getWorldPosition(_sprayOrigin);
      camera.getWorldDirection(_sprayDir);
      _sprayRay.set(_sprayOrigin, _sprayDir);
      const hits = _sprayRay.intersectObjects(_sprayables, false);
      // paintRT を持つ最初のヒットを採用 (非 paintable は skip)
      let hit = null;
      for (const h of hits) {
        if (h && h.uv && h.object && h.object.userData && h.object.userData.paintRT) {
          hit = h;
          break;
        }
      }
      if (!hit) return;
      const uv = hit.uv;
      const target = hit.object;
      const tgtName = (target && target.name) || '';
      const rt = target.userData.paintRT;
      const colorHex = (state.myColor || '#ffffff').replace('#', '');
      // 世界半径 → この面の worldSpan で UV 半径に変換
      const worldR = Math.min(hit.distance * Math.tan(SPRAY_HALF_ANGLE), SPRAY_MAX_WORLD_R);
      const worldSpan = (target.userData.worldSpanM) || 1.0;
      const uvR = Math.max(SPRAY_MIN_UV_R, worldR / worldSpan);
      const seed = (Date.now() & 0xFFFFF);
      _applyPaintTo(rt, uv.x, uv.y, uvR, '#' + colorHex, seed);
      // 送信: 単発 emit ではなく _sprayOutBuf に push、50ms 毎に 'spray2Batch' として
      // volatile emit (遅延時は socket.io が drop → キュー詰まり防止)。
      if (socket && socket.connected) {
        _sprayOutBuf.push({
          tgt: tgtName,
          u: +uv.x.toFixed(4),
          v: +uv.y.toFixed(4),
          c: colorHex,
          r: +uvR.toFixed(4),
          s: seed,
        });
      }
      // モード派生オブジェクト発生ロジック: color から mode 解決して _pushPaintHit
      if (hit.point) {
        let wnx = 0, wny = 1, wnz = 0;
        if (hit.face && hit.face.normal && target) {
          const nLocal = hit.face.normal.clone();
          nLocal.transformDirection(target.matrixWorld);
          wnx = nLocal.x; wny = nLocal.y; wnz = nLocal.z;
        }
        _pushPaintHit(hit.point, { x: wnx, y: wny, z: wnz }, worldR, colorHex);
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
    let moveSensitivity = 10;
    // ===== Master 専用: TransformControls (移動ギズモ + 回転リング) =====
    //   選択オブジェクトに translate + rotate の 2 ギズモを装着する。
    //   drag 終了時に対応する socket イベント (controlPose / sceneObjectPose) で全クライアント反映。
    let _tcTranslate = null;
    let _tcRotate    = null;
    window.__tcDragging = false;
    function _getTransformTarget(obj) {
      if (!obj) return null;
      const u = obj.userData || {};
      if ((u.selectType === 'apex' || u.selectType === 'base') && u.avatarId) {
        const av = avatars.get(u.avatarId);
        return av && av.grp;
      }
      if (u.sceneObjectId) {
        const rec = sceneLightObjects.get(u.sceneObjectId);
        return rec && rec.grp;
      }
      return obj;
    }
    function _emitSelectedPose() {
      if (!selectedObject) return;
      const target = _getTransformTarget(selectedObject);
      if (!target) return;
      const u = selectedObject.userData || {};
      if ((u.selectType === 'apex' || u.selectType === 'base') && u.avatarId) {
        if (socket && socket.connected) {
          const p = target.position; const q = target.quaternion;
          socket.emit('controlPose', {
            targetId: u.avatarId,
            x: p.x, y: p.y, z: p.z,
            qx: q.x, qy: q.y, qz: q.z, qw: q.w,
          });
        }
      } else if (u.sceneObjectId) {
        if (socket && socket.connected) {
          const p = target.position;
          socket.emit('sceneObjectPose', { id: u.sceneObjectId, x: p.x, y: p.y, z: p.z });
        }
      }
    }
    function _initMasterGizmos() {
      if (ROLE !== 'master') return;
      if (_tcTranslate) return;
      if (typeof THREE.TransformControls !== 'function') {
        log('TransformControls 未ロード — ギズモ無効', 'err');
        return;
      }
      _tcTranslate = new THREE.TransformControls(camera, renderer.domElement);
      _tcTranslate.setMode('translate');
      _tcTranslate.setSize(0.8);
      _tcTranslate.setSpace('world');
      scene.add(_tcTranslate);
      _tcRotate = new THREE.TransformControls(camera, renderer.domElement);
      _tcRotate.setMode('rotate');
      _tcRotate.setSize(1.1);
      _tcRotate.setSpace('local');
      scene.add(_tcRotate);
      // 感度を 1/3 に抑制: ドラッグ開始時の pos/quat を保存し、
      //   objectChange で TC が設定した "期待値" から 1/3 の変化だけ採用
      const GIZMO_GAIN = 1 / 3;
      let _tDragStart = null;   // translate 開始時の position
      let _rDragStart = null;   // rotate 開始時の quaternion
      _tcTranslate.addEventListener('dragging-changed', (e) => {
        window.__tcDragging = !!e.value;
        _tDragStart = (e.value && _tcTranslate.object) ? _tcTranslate.object.position.clone() : null;
      });
      _tcRotate.addEventListener('dragging-changed', (e) => {
        window.__tcDragging = !!e.value;
        _rDragStart = (e.value && _tcRotate.object) ? _tcRotate.object.quaternion.clone() : null;
      });
      _tcTranslate.addEventListener('objectChange', () => {
        if (_tDragStart && _tcTranslate.object) {
          // 現在 TC が設定した位置 → start + full_offset
          //   scaled = start + full_offset * GAIN
          const obj = _tcTranslate.object;
          const _delta = obj.position.clone().sub(_tDragStart);
          obj.position.copy(_tDragStart).addScaledVector(_delta, GIZMO_GAIN);
        }
        _emitSelectedPose();
      });
      _tcRotate.addEventListener('objectChange', () => {
        if (_rDragStart && _tcRotate.object) {
          // 現在 quat (= start * full rotation) に向かって start から GAIN だけ slerp
          const obj = _tcRotate.object;
          const _qFull = obj.quaternion.clone();
          obj.quaternion.copy(_rDragStart).slerp(_qFull, GIZMO_GAIN);
        }
        _emitSelectedPose();
      });
    }
    function _attachGizmosTo(obj) {
      if (!_tcTranslate) return;
      const target = _getTransformTarget(obj);
      if (target) { _tcTranslate.attach(target); _tcRotate.attach(target); }
      else        { _tcTranslate.detach();      _tcRotate.detach(); }
    }
    window.__initMasterGizmos = _initMasterGizmos;

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
      // master: TransformControls (移動ギズモ + 回転リング) 装着/取り外し
      if (ROLE === 'master') _attachGizmosTo(obj);
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
    const FRICTION_COEFF = 0.25;   // 球体や cube が自然に転がる/滑るよう弱めに (旧 0.6)
    const ANGULAR_DAMP = 0.995;
    // 掴み中 (held) の Spring-Damper 係数 (質量比例)
    //   ・k_eff = SPRING_K_PER_KG × mass, d_eff = SPRING_DAMPING_PER_KG × mass
    //   ・加速度 a = (k·(target-pos) - d·v) / m = SPRING_K_PER_KG·x - SPRING_DAMPING_PER_KG·v
    //     → 質量が変わっても追従感・振り感は一定 (ω = sqrt(k/m) = sqrt(SPRING_K_PER_KG) ≈ 5.5 rad/s、周期 ~1.1s)
    //   ・ζ = SPRING_DAMPING_PER_KG / (2·sqrt(SPRING_K_PER_KG)) ≈ 0.55 (弱振動 = ほどよい振り返し)
    const SPRING_K_PER_KG = 120;  // 強化: 選択オブジェクトを手前へ素早く引き寄せられるよう K を増大
    const SPRING_DAMPING_PER_KG = 10;  // ダンピングも増やして振動を抑制 (ζ = 10/(2√120) ≈ 0.46)
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
    // 任意寸法 (halfExt) に対応した 8 隅配列を再利用用に書き出す。
    //   cube の userData.halfExt (Vector3) があればその値、無ければ (0.5,0.5,0.5)。
    const _cornerScratch = [];
    for (let i = 0; i < 8; i++) _cornerScratch.push(new THREE.Vector3());
    function _getCornersFor(cube) {
      const he = cube.userData && cube.userData.halfExt;
      const hx = he ? he.x : 0.5;
      const hy = he ? he.y : 0.5;
      const hz = he ? he.z : 0.5;
      _cornerScratch[0].set(-hx,-hy,-hz); _cornerScratch[1].set(+hx,-hy,-hz);
      _cornerScratch[2].set(-hx,+hy,-hz); _cornerScratch[3].set(+hx,+hy,-hz);
      _cornerScratch[4].set(-hx,-hy,+hz); _cornerScratch[5].set(+hx,-hy,+hz);
      _cornerScratch[6].set(-hx,+hy,+hz); _cornerScratch[7].set(+hx,+hy,+hz);
      return _cornerScratch;
    }
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
    // 停止閾値を厳しめに (閾値以上の緩やかな減速中に突然 sleep して "ピッタリ停止" するのを防ぐ)
    const SLEEP_LIN2 = 0.003;     // |v|² < 0.003 → |v| < 0.055 m/s
    const SLEEP_ANG2 = 0.003;     // |ω|² < 0.003 → |ω| < 0.055 rad/s
    const SLEEP_HOLD_FRAMES = 45; // 連続安定フレーム数 (~0.75 秒 @60fps)
    function _wakeCube(c) {
      if (c && c.userData) {
        c.userData.sleeping = false;
        c.userData.restFrames = 0;
      }
    }
    function _physicsTick(dt) {
      // 早期 return: 全 cube が sleep かつ held/pinned でもない時は for ループ全スキップ
      let _anyAwake = false;
      for (const c of movableCubes) {
        const o = c.userData;
        if (o.held || (o.__isCanvasBox && !o.pinned) || !o.sleeping || (o.ownerId === myId && !o.sleeping)) {
          _anyAwake = true;
          break;
        }
        if (!o.sleeping) { _anyAwake = true; break; }
      }
      if (!_anyAwake) return;
      for (const c of movableCubes) {
        // Ownership チェック: 他クライアントが所有している cube の物理はスキップ
        //   (受信した位置を描画するだけ、ローカルシミュレーションしない → 競合消失)
        const owner = c.userData.ownerId;
        if (owner && owner !== myId) continue;
        // canvasBox が Base にピン留めされている間は物理をスキップ
        //   (位置は _canvasBoxFollowTick 側で avatar の base world transform に追従)
        if (c.userData.__isCanvasBox && c.userData.pinned) continue;
        const v  = c.userData.vel;
        const av = c.userData.angVel;
        const mass = c.userData.mass || 1.0;
        const _he = c.userData.halfExt;
        const _hx = _he ? _he.x : CUBE_HALF_Y;
        const _hz = _he ? _he.z : CUBE_HALF_Y;
        // held: Spring-Damper で targetPos へ引っ張る (アームの先端 → バネ紐 → 物体)
        //   ・v += ((k·x - d·v) / m) · dt、ただし k/m と d/m は定数化
        //   ・gravity は加え続ける (紐で吊るされてわずかに垂れる)
        //   ・float しないよう速度上限クランプ
        //   ・床衝突は held でも実行 (下にぶつかればゴリゴリこする)
        if (c.userData.held) {
          const t = c.userData.targetPos;
          if (t) {
            // 直結 Spring-Damper (K=45): targetPos へ加速度 (k·x - d·v) / m
            _phTmpV1.copy(t).sub(c.position).multiplyScalar(SPRING_K_PER_KG);  // k/m · x
            _phTmpV2.copy(v).multiplyScalar(-SPRING_DAMPING_PER_KG);           // -d/m · v
            _phTmpV1.add(_phTmpV2);                                            // 加速度 (m/s²)
            v.addScaledVector(_phTmpV1, dt);
          }
          v.y -= GRAVITY * dt;
          // 発散防止: 速度上限
          if (v.length() > SPRING_VEL_CAP) v.setLength(SPRING_VEL_CAP);
          c.position.addScaledVector(v, dt);
          _resolveFloorContactRigid(c, dt);
          // 壁反発 (halfExt 対応)
          if (c.position.x >  FIELD_HALF - _hx) { c.position.x =  FIELD_HALF - _hx; v.x = -v.x * 0.5; }
          if (c.position.x < -FIELD_HALF + _hx) { c.position.x = -FIELD_HALF + _hx; v.x = -v.x * 0.5; }
          if (c.position.z >  FIELD_HALF - _hz) { c.position.z =  FIELD_HALF - _hz; v.z = -v.z * 0.5; }
          if (c.position.z < -FIELD_HALF + _hz) { c.position.z = -FIELD_HALF + _hz; v.z = -v.z * 0.5; }
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
        // 場所範囲: FIELD_HALF 壁で反発 (halfExt 対応、center ベース簡易)
        if (c.position.x >  FIELD_HALF - _hx) { c.position.x =  FIELD_HALF - _hx; v.x = -v.x * 0.5; }
        if (c.position.x < -FIELD_HALF + _hx) { c.position.x = -FIELD_HALF + _hx; v.x = -v.x * 0.5; }
        if (c.position.z >  FIELD_HALF - _hz) { c.position.z =  FIELD_HALF - _hz; v.z = -v.z * 0.5; }
        if (c.position.z < -FIELD_HALF + _hz) { c.position.z = -FIELD_HALF + _hz; v.z = -v.z * 0.5; }
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
      const iFactor = (typeof cube.userData.inertiaFactor === 'number')
        ? cube.userData.inertiaFactor : CUBE_INERTIA_FACTOR;
      const I = mass * iFactor;
      const v  = cube.userData.vel;
      const av = cube.userData.angVel;
      const CONTACT_TOL = 0.01;
      // 8 頂点を world 回転適用、キャッシュに保存。最下点 minY を記録。
      //   halfExt (userData) があれば任意サイズ、無ければ 1m 立方体 (default)
      const CORNERS = _getCornersFor(cube);
      let minY = Infinity;
      for (let k = 0; k < 8; k++) {
        _rotatedCorners[k].copy(CORNERS[k]).applyQuaternion(cube.quaternion);
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
        // held 中は水平減衰しない (Spring-Damper が target へ引き寄せる動きを殺さない)
        if (!cube.userData.held) v.multiplyScalar(0.80);
        // 重力 couple トルク Δω = (r × F_up) / I · dt
        _phTmpV2.set(0, mass * GRAVITY, 0);
        _phTmpV4.copy(r).cross(_phTmpV2);
        av.addScaledVector(_phTmpV4, dt / I);   // ← dt 掛け忘れを修正 (以前 60× overdrive)
        if (!cube.userData.held) av.multiplyScalar(0.90);
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
      //   選択/把持中 (held=true) の cube は摩擦ゼロ: Spring-Damper の目標位置へ滑らかに追従できる
      _phTmpV2.copy(_phNormal).multiplyScalar(vn);
      _phTmpV3.sub(_phTmpV2);                     // v_tangential
      const vtLen = _phTmpV3.length();
      if (vtLen > 0.001 && !cube.userData.held) {
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
          // canvasBox は非立方寸法 (W×H×0.02) のため AABB=1 を仮定した本判定から除外
          //   他の cube とは "すり抜ける" 挙動になるが、床接地と壁反発は _physicsTick で処理される
          if (a.userData.__isCanvasBox || b.userData.__isCanvasBox) continue;
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
      // canvasBox が pinned (avatar grp の子) 状態なら detach → world transform を保持したまま scene 直下へ
      //   以後は普通の物理オブジェクトとして振る舞う
      if (cube.userData.__isCanvasBox && cube.userData.pinned) {
        const wp = new THREE.Vector3();
        const wq = new THREE.Quaternion();
        const ws = new THREE.Vector3();
        cube.getWorldPosition(wp);
        cube.getWorldQuaternion(wq);
        cube.getWorldScale(ws);
        if (cube.parent) cube.parent.remove(cube);
        cube.position.copy(wp);
        cube.quaternion.copy(wq);
        cube.scale.copy(ws);
        scene.add(cube);
        cube.userData.pinned = false;
        log('canvasBox detach: ' + cube.name, 'ok');
      }
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
      // rope 可視化用に "actively held by me" を全視点同期
      cube.userData.heldBy = myId;
      if (socket && socket.connected) {
        socket.emit('cubeHold', { name: cube.name, heldBy: myId });
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
      // rope の全視点同期: release を broadcast → 全員の heldBy をクリア → rope 消去
      cube.userData.heldBy = null;
      if (socket && socket.connected) {
        socket.emit('cubeHold', { name: cube.name, heldBy: null });
      }
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
      // 効果2 が smartphone pointer に再割当されたため、frustum レイアウトは常に default モード (Canvas-plane)
      const modeA = false;
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
    function makeObserverFrustumMeshes(color, W, H, id, depthOverride, hasHole, omitBox, targetRole) {
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

      // Canvas Box (observer 専用、物理オブジェクト):
      //   ・寸法: base W×H × 0.02m (奥行き 2cm)
      //   ・Base 平面を "前面" とし -Z (= forward) 方向へ 2cm 延長 (格子つき avatarBox と同じ配置)
      //   ・初期は pinned=true: avatar grp の子として追従 (base と同じ姿勢)
      //   ・選択/grab されると pinned=false になり、grp から scene へ付け替え → 重力+物理+衝突
      //   ・物理用 userData: __movable, __isCanvasBox, halfExt, inertiaFactor, 初期位置
      //   ・base の "ローカル" 位置に対して配置 (grp の子として追加される前提)
      let canvasBox = null;
      // 効果1 は廃止したため canvasBox 生成は無効化 (plate1/plate2 タグに移行)
      if (false && !omitBox && targetRole === 'observer') {
        // 6 面マテリアル配列: BoxGeometry のインデックスは
        //   0=+X 右, 1=-X 左, 2=+Y 上, 3=-Y 下, 4=+Z (Base と接する前面), 5=-Z (奥面)
        //   effect2 OFF ではカメラが +Z 面と同じ平面にあり +Z 面は edge-on で見えないため、
        //   奥面 (-Z, idx 5) にも同じテクスチャを貼る。カメラは奥面を内側から見ることで画像が full-screen で見える。
        //   残り 4 側面 (0..3) はグレー基調 (アバター本体色の面)。
        const _grayHex = 0x9ca3af;
        const matGray  = new THREE.MeshBasicMaterial({ color: _grayHex, side: THREE.DoubleSide, fog: true });
        const matImage = new THREE.MeshBasicMaterial({ map: _canvasBoxTex, color: 0xffffff, side: THREE.DoubleSide, fog: true });
        canvasBox = new THREE.Mesh(
          new THREE.BoxGeometry(L.baseW, L.baseH, 0.02),
          [matGray, matGray, matGray, matGray, matImage, matImage]
        );
        canvasBox.position.set(0, 0, L.baseZ - 0.01);
        canvasBox.name = 'canvas-box_' + id;
        canvasBox.renderOrder = 10;
        // 物理 userData — pinned 中は _physicsTick がスキップ、grab 時に pinned=false になり物理再開
        const hx = L.baseW * 0.5;
        const hy = L.baseH * 0.5;
        const hz = 0.01;
        canvasBox.userData.__movable = true;
        canvasBox.userData.__isCanvasBox = true;
        canvasBox.userData.pinned = true;
        canvasBox.userData.pinnedAvatarId = id;
        canvasBox.userData.halfExt = new THREE.Vector3(hx, hy, hz);
        canvasBox.userData.inertiaFactor = (hx*hx + hy*hy + hz*hz) * (2/9);
        canvasBox.userData.vel = new THREE.Vector3();
        canvasBox.userData.angVel = new THREE.Vector3();
        canvasBox.userData.held = false;
        canvasBox.userData.sleeping = false;
        canvasBox.userData.restFrames = 0;
        canvasBox.userData.mass = 5.0;
        canvasBox.userData.targetPos = null;
        canvasBox.userData.ownerId = null;
      }
      return { frustumLines, apexHit, apexEdges, baseHit, baseEdges, box, canvasBox };
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
        const parts = makeObserverFrustumMeshes(av.color, dW, dH, id, null, false, omitBox, role);
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
        // canvasBox (observer 専用、2cm 厚 白板 + 物理) を grp に追加
        //   pinned 中は grp の子として base に追従。grab 時に detach して scene 直下に移動 (物理モード)。
        if (parts.canvasBox) {
          av.canvasBox = parts.canvasBox;
          grp.add(parts.canvasBox);
          selectables.push(parts.canvasBox);
          movableCubes.push(parts.canvasBox);
          parts.canvasBox.userData.initialPos = parts.canvasBox.position.clone();
          parts.canvasBox.userData.initialQuat = parts.canvasBox.quaternion.clone();
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
        // master = 直径 10cm (radius 0.05)、camera = 直径 30cm (radius 0.15)
        const _sphRadius = (role === 'master') ? 0.05 : 0.15;
        av.mesh = new THREE.Mesh(
          new THREE.SphereGeometry(_sphRadius, 24, 16),
          new THREE.MeshStandardMaterial({ color: color || '#ffffff', roughness: 0.6 })
        );
        grp.add(av.mesh);
      }
      // ---- スマホ (camera role): 画面上部から伸びるポインター線は廃止 ----
      //   旧仕様では avatar 原点から +Y 方向へ 5m のラインを描画していたが、
      //   ユーザー指示により削除。avatar は視錐台のみで表現する。
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
      // canvasBox (observer 専用、2cm 厚 板 + 物理) — rebuild 時に破棄せず維持する
      //   ・既に grab/detach されている可能性があるので再生成すると状態 (位置・速度) が消える
      //   ・displayConfig の off-axis 一括切替で rebuildAvatarFrustum が走っても canvasBox は影響させない
      //   ・最終的な avatar leave 時のみ別経路で破棄する想定
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
      const parts = makeObserverFrustumMeshes(a.color, dW, dH, id, depthOverride, hasHole, omitBox, a.role);
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
      // canvasBox: 既存 (a.canvasBox) があればそれを維持し、新規生成分は破棄する。
      //   displayConfig (off-axis 切替) などで rebuild された時に canvasBox の状態 (位置・物理) をリセットしない。
      //   既存 canvasBox が pinned 中なら、新しい base 位置に追従して local Z を更新する。
      if (parts.canvasBox) {
        if (a.canvasBox) {
          // 新規分は破棄
          if (parts.canvasBox.geometry) parts.canvasBox.geometry.dispose();
          if (parts.canvasBox.material) {
            if (Array.isArray(parts.canvasBox.material)) parts.canvasBox.material.forEach((mm) => mm.dispose());
            else parts.canvasBox.material.dispose();
          }
          parts.canvasBox = null;
          // 既存 pinned なら base の新位置に追従
          if (a.canvasBox.userData.pinned && a.canvasBox.parent === a.grp) {
            const _L = _computeFrustumLayout(dW, dH, depthOverride);
            a.canvasBox.position.z = _L.baseZ - 0.01;
          }
        } else {
          // 初回: 普通に追加
          a.canvasBox = parts.canvasBox;
          a.grp.add(parts.canvasBox);
          selectables.push(parts.canvasBox);
          movableCubes.push(parts.canvasBox);
          parts.canvasBox.userData.initialPos = parts.canvasBox.position.clone();
          parts.canvasBox.userData.initialQuat = parts.canvasBox.quaternion.clone();
        }
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
    let viewerEye = { x: 0, y: 1.3, z: 0 };
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
        // space2: スプレー色は入室時に 3 色からランダムに上書き (サーバー配色を無視)
        //   #029ecc (青) / #ffce18 (黄) / #df2c1e (赤) のいずれか
        const _space2Palette = ['#029ecc', '#ffce18', '#df2c1e'];
        state.myColor = _space2Palette[Math.floor(Math.random() * _space2Palette.length)];
        log('spray color (random): ' + state.myColor, 'ok');
        // 既存ユーザー
        for (const id in data.users) {
          const u = data.users[id];
          const a = ensureAvatar(id, u.color, u.role, u.display);
          a.grp.position.set(u.x, u.y, u.z);
          a.grp.quaternion.set(u.qx, u.qy, u.qz, u.qw);
          if (u.entryTag)   a.entryTag   = u.entryTag;
          if (u.customTags) a.customTags = u.customTags.slice();
        }
        // 自分自身のプレビュー avatar: 生成はするが非表示 (他コードの avatars.get(myId) 参照を維持しつつ描画コストを除く)
        //   ・space1 同様、自身は描画しない方針に変更
        //   ・tick 内の自アバター追従処理も削除済み
        ensureAvatar(myId, state.myColor, ROLE, effectiveDisplaySize);
        {
          const _selfAv = avatars.get(myId);
          if (_selfAv && _selfAv.grp) _selfAv.grp.visible = false;
        }
        log('self preview avatar: ' + myId.substring(0,6) + ' (非表示、frustum rebuild 用に生成のみ)', 'ok');

        rebuildClientSelect();
        if (typeof _syncMyEntryTagUI === 'function') _syncMyEntryTagUI();
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
        if (u.id === myId && typeof _syncMyEntryTagUI === 'function') _syncMyEntryTagUI();
        log('join: ' + (u.entryTag ? u.entryTag + ' ' : '') + u.id.substring(0, 6) +
            (u.display ? ' display=' + u.display.width.toFixed(3) + '×' + u.display.height.toFixed(3) + 'm' : ''),
            'ok');
      });

      socket.on('pose', (u) => {
        const a = avatars.get(u.id);
        if (!a) return;
        // master が WASD で動かしている最中は、対象 observer の自前 pose で上書きしない
        //   (= master 画面で avatar がカクつく原因だった)
        if (ROLE === 'master' && window.__masterOwnedAvatarId === u.id) {
          if (u.role) a.role = u.role;
          return;
        }
        a.grp.position.set(u.x, u.y, u.z);
        a.grp.quaternion.set(u.qx, u.qy, u.qz, u.qw);
        if (u.role) a.role = u.role;
        // observer に遷移した瞬間 server が entryTag を配信するので反映
        if (u.entryTag && a.entryTag !== u.entryTag) {
          a.entryTag = u.entryTag;
          rebuildClientSelect();
          log('entry tag: ' + a.entryTag + ' ← ' + u.id.substring(0,6), 'ok');
          if (u.id === myId) _syncMyEntryTagUI();
        }
      });
      // 自身の entryTag を #status の #my-entry-tag span に反映
      function _syncMyEntryTagUI() {
        const el = document.getElementById('my-entry-tag');
        if (!el) return;
        const a = (myId && avatars.get(myId)) || null;
        el.textContent = (a && a.entryTag) ? a.entryTag : '';
      }
      window.__syncMyEntryTagUI = _syncMyEntryTagUI;
      // ===== ペイントモード (master → camera 一括色変更) =====
      //   null | 'wood' | 'river' | 'sky' の 4 状態。camera ロールのクライアントは state.myColor を上書き
      const PAINT_MODE_COLORS = {
        wood:  '#1b5e20',   // 深緑
        river: '#008cdd',
        sky:   '#002044',
      };
      window.__currentPaintMode = null;
      socket.on('paintMode', (data) => {
        const mode = (data && data.mode) || null;
        window.__currentPaintMode = mode;
        if (ROLE === 'camera') {
          if (mode && PAINT_MODE_COLORS[mode]) {
            state.myColor = PAINT_MODE_COLORS[mode];
            log('paint mode → ' + mode + ' (color=' + state.myColor + ')', 'ok');
          } else {
            // 上書き解除 → ランダム色にリセット
            const _pal = ['#029ecc', '#ffce18', '#df2c1e'];
            state.myColor = _pal[Math.floor(Math.random() * _pal.length)];
            log('paint mode cleared → random color=' + state.myColor, 'ok');
          }
        }
        if (ROLE === 'master' && typeof window.__syncMasterPaintButtons === 'function') {
          window.__syncMasterPaintButtons();
        }
      });
      // サーバーから自分の entryTag を受信した時に反映 (本人には broadcast('join') が届かないため)
      socket.on('selfEntryTag', (data) => {
        if (!data || !data.entryTag || !myId) return;
        const a = avatars.get(myId);
        if (a) {
          a.entryTag = data.entryTag;
          _syncMyEntryTagUI();
          if (typeof rebuildClientSelect === 'function') rebuildClientSelect();
          log('self entry tag → ' + data.entryTag, 'ok');
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
        // plate1/plate2 タグ変更 → plate 可視化を更新
        if (data.tag === 'plate1' || data.tag === 'plate2') {
          if (typeof window.__syncPlateVisibility === 'function') window.__syncPlateVisibility();
          // 自分自身のオブザーバーパネル UI (タグボタン) を更新
          if (data.id === myId && typeof window.__syncObsPlateButtons === 'function') {
            window.__syncObsPlateButtons();
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
        // ambient の実効値を 0.75 で capping: linear tone mapping 下で ambient=1 だと
        //   lit area (ambient+dirLight=1.35) も shadow area (ambient=1.0) も 1.0 に clamp され
        //   影が完全に消える。0.75 で止めることで常に dirLight 分の輝度差を確保 → 影が残る。
        //   背景/フォグ色はスライダー値 v をそのまま使うので「背景も最大白」の挙動は維持。
        if (sceneAmbient) sceneAmbient.intensity = Math.min(0.75, v);
        if (scene.background && scene.background.isColor) scene.background.setRGB(v, v, v);
        if (scene.fog && scene.fog.color) scene.fog.color.setRGB(v, v, v);
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

      // 掴み状態の全視点同期 (rope 可視化用) — ownership とは独立
      //   data = { name, heldBy } : heldBy は socket id (null で release)
      socket.on('cubeHold', (data) => {
        if (!data || typeof data.name !== 'string') return;
        const c = movableCubes.find((m) => m.name === data.name);
        if (!c) return;
        c.userData.heldBy = (typeof data.heldBy === 'string') ? data.heldBy : null;
      });

      // Opacity 同期: data = { name, opacity (0-1) }
      socket.on('cubeOpacity', (data) => {
        if (!data || typeof data.name !== 'string' || typeof data.opacity !== 'number') return;
        const c = movableCubes.find((m) => m.name === data.name);
        if (!c) return;
        const o = Math.max(0, Math.min(1, data.opacity));
        c.userData.opacity = o;
        if (Array.isArray(c.material)) c.material.forEach((m) => { m.opacity = o; });
        else if (c.material) c.material.opacity = o;
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

      // space2 専用スプレー受信: space3 の 'spray' / 'sprayBatch' は購読せず相互影響を遮断
      // 外側スコープで宣言された _applyRemoteSprayImmediate (let) にここで実体を代入
      _applyRemoteSprayImmediate = function (data) {
        if (!data || typeof data.u !== 'number' || typeof data.v !== 'number') return;
        if (!data.tgt) return;
        const mesh = _paintables.get(data.tgt);
        if (!mesh) return;
        const rt = mesh.userData.paintRT; if (!rt) return;
        const color = (typeof data.c === 'string') ? ('#' + data.c) : '#ffffff';
        const uvR = (typeof data.r === 'number') ? data.r : 0.01;
        _applyPaintTo(rt, data.u, data.v, uvR, color, data.s);
      };
      // 単発 spray2 (後方互換) → 合流キュー
      socket.on('spray2', _scheduleApplyRemote);
      // 新規: バッチ (A: 送信側 50ms 窓で集約されたもの)
      socket.on('spray2Batch', (list) => {
        if (!Array.isArray(list)) return;
        for (const d of list) _scheduleApplyRemote(d);
      });
      // 履歴 (初回接続時の既存塗り再現)
      socket.on('sprayBatch2', (list) => {
        if (!Array.isArray(list)) return;
        for (const d of list) _scheduleApplyRemote(d);
      });
      // space2 専用アトラスリセット
      socket.on('resetAtlas2', () => {
        _clearAllPaintables();
        _clearAllModeSpawn();
        log('atlas cleared (space2)', 'ok');
      });

      // ペイントモード派生オブジェクト発生 (wood/river/sky) ─ サーバーから配信
      // ライブイベントはフェード付き (local と同じ 2s 遅延 + 1s フェード)
      socket.on('modeSpawn', (data) => { _renderModeSpawnAt(data); });
      // 履歴 (初期ロード) はフェードなしで即描画
      socket.on('modeHistoryBatch', (list) => {
        if (!Array.isArray(list)) return;
        for (const d of list) _renderModeSpawnImmediate(d);
      });
      socket.on('resetModeSpawn', () => { _clearAllModeSpawn(); log('[mode] cleared', 'ok'); });
      // 塗り替え (他モードの voxel 位置を 1 秒でフェードアウト)
      socket.on('modeOverwrite', (data) => {
        if (!data || typeof data.mode !== 'string') return;
        if (typeof data.ix !== 'number' || typeof data.iy !== 'number' || typeof data.iz !== 'number') return;
        _tryFadeOutModeAt(data.mode, data.ix, data.iy, data.iz);
      });
      // 塗り替え履歴 (新規接続時にサーバーから受信、既存の fade-out 状態を再現)
      //   modeHistoryBatch で全スポーンを生成した後に順次フェード処理を実行する
      socket.on('modeOverwriteHistoryBatch', (list) => {
        if (!Array.isArray(list)) return;
        for (const d of list) {
          if (!d || typeof d.mode !== 'string') continue;
          _tryFadeOutModeAt(d.mode, d.ix, d.iy, d.iz);
        }
      });
      // 旧 'resetSpace' (space3 由来) は購読しない — space3 のリセットが space2 に波及しないようにするため。
      // space2 独自のアトラスリセットは 'resetAtlas2' ハンドラ側で実施。

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
        // 効果1: 廃止 (旧 canvasBox 生成ゲート)
        // 効果2: 未割当 (旧 phone pointer 機能は廃止)
        // 効果3: 廃止 (旧 Fog 原点固定)
        // 効果4: シャドウ ON/OFF — renderer.shadowMap + dirLight.castShadow + 全マテリアル再コンパイル
        if (n === 4) {
          renderer.shadowMap.enabled = on;
          renderer.shadowMap.type = THREE.PCFSoftShadowMap;
          dirLight.castShadow = on;
          // shadow の有効化/無効化はシェーダー path を変えるので全マテリアルを再コンパイル
          scene.traverse((obj) => {
            if (!obj.material) return;
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            mats.forEach((m) => { if (m) m.needsUpdate = true; });
          });
          log('shadow ' + (on ? 'ON' : 'OFF') + ' (effect4)', 'ok');
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
    updaters.push(_sprayFlushTick);
    updaters.push(_modeBurstTick);
    updaters.push(_modeAnimTick);
    updaters.push(_modeCullTick);
    // 川 shader の uTime を全チャンク材料で共有 (uniforms 同一参照、1行で全反映)
    updaters.push(() => { _sharedRiverUniforms.uTime.value = performance.now() * 0.001; });
    // ミニキューブ更新 tick (前方で保留した関数を push)
    if (typeof window.__miniCubeUpdater === 'function') updaters.push(window.__miniCubeUpdater);

    // ========== 効果2: スマホ リモコン型ポインター + スプレーボタン ==========
    //   ・effect2 ON + ROLE=camera の時のみ有効化
    //   ・pointer line: camera.position から forward 10m のレーザー (赤)
    //   ・毎フレーム raycast → movable Box ヒット中なら pointer を黄にハイライト
    //   ・phone-spray-btn:
    //     - press 開始時に raycast → ヒットあり: 500ms 経過で選択+grab
    //     - ヒット無し: スプレー発射 (space1 と同様の 4 秒 hold → 10Hz emit)
    //     - release: grab 中なら release、spray 中なら停止
    // ===== スマホ用スプレーボタン (space1 スタイル) =====
    //   effect2 のポインター機能は廃止。
    //   フルスクリーン (body.ui-hidden) + ROLE=camera の時に画面上部に大きな丸ボタンを表示、
    //   押しっぱなしで spray を即時発射 (10Hz 送信)。
    function _bindPhoneSprayBtn() {
      const btn = document.getElementById('phone-spray-btn');
      if (!btn) { setTimeout(_bindPhoneSprayBtn, 300); return; }
      const _btnDown = (e) => {
        e.preventDefault(); e.stopPropagation();
        btn.classList.add('pressing');
        _spraySelf.pressStartT = performance.now() - SPRAY_HOLD_MS;  // 4秒待機を無視して即時 armed
        _spraySelf.armed = true;
        _spraySelf.lastEmitT = 0;
        try { btn.setPointerCapture && e.pointerId != null && btn.setPointerCapture(e.pointerId); } catch (_) {}
      };
      const _btnUp = (e) => {
        e.preventDefault(); e.stopPropagation();
        btn.classList.remove('pressing');
        _spraySelf.pressStartT = 0;
        _spraySelf.armed = false;
      };
      if (window.PointerEvent) {
        btn.addEventListener('pointerdown',   _btnDown, { passive: false });
        btn.addEventListener('pointerup',     _btnUp,   { passive: false });
        btn.addEventListener('pointercancel', _btnUp,   { passive: false });
        btn.addEventListener('pointerleave',  _btnUp,   { passive: false });
      } else {
        btn.addEventListener('touchstart', _btnDown, { passive: false });
        btn.addEventListener('touchend',   _btnUp,   { passive: false });
        btn.addEventListener('touchcancel',_btnUp,   { passive: false });
        btn.addEventListener('mousedown',  _btnDown);
        btn.addEventListener('mouseup',    _btnUp);
      }
      // ROLE=camera であれば常に body.phone-pointer-on を立てる (CSS で ui-hidden と組み合わせて表示)
      if (ROLE === 'camera') document.body.classList.add('phone-pointer-on');
    }
    _bindPhoneSprayBtn();

    // 旧ポインター関連の window 関数 (effect2 で参照されていた) は no-op に
    window.__applyPhonePointerMode = function () {};
    const _POINTER_RADIUS_UNUSED = 0.0075; void _POINTER_RADIUS_UNUSED;

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
        // 空間表示モード: VR 空間を恒常化 (AR passthrough は廃止、効果1 の制御対象外)
        //   効果1 は observer 入室時の canvasBox 生成ゲートに再割当済み (camera には影響しない)
        log('入室時モード: VR 空間 (恒常)', 'ok');
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
      const CAM_SPAWN = { x: 0, y: 1.3, z: 0 };
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
        // TransformControls のギズモドラッグ中は本体の click を無視
        if (window.__tcDragging) return;
        _pressAt = { x, y };
        _tapMoved = false;
        _dragState = null;
        window.__cubeDragActive = false;
        const hit = _raycastAt(x, y);
        // オブジェクト外のクリック: 選択中なら解除 (self-move モードに戻る)
        if (!hit) {
          if (selectedObject) {
            selectObject(null);
            return;
          }
          // 無選択状態での空クリックはスプレー長押しの開始候補
          _spraySelf.pressStartT = performance.now();
          _spraySelf.armed = false;
          _spraySelf.lastEmitT = 0;
          return;
        }
        const obj = hit.object;

        // 移動 Box (cube1..4) — 全ロール共通仕様:
        //   press で grab → drag でレイ先端 (grabDist) に向けて Spring-Damper で追従 → release で物理再開
        //   camera (スマホ) もこの仕様に統一 (旧: スワイプ奥行き調整 + 投擲 は廃止)
        if (obj.userData && obj.userData.__movable) {
          selectObject(obj);
          // Opacity タグの ON/OFF 切替: Asset2 で ON、Asset1 で OFF
          if (obj.userData.__opacityTagTrigger === 'on') {
            window.__opacityTagged = true;
            log('opacity tag → ON (' + obj.name + ' 選択)', 'ok');
          } else if (obj.userData.__opacityTagTrigger === 'off') {
            window.__opacityTagged = false;
            log('opacity tag → OFF (' + obj.name + ' 選択)', 'ok');
          }
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
            // opacity 制御モード用: grab 開始時点の opacity をスワイプの基準値として保持
            startOpacity: (obj.userData && typeof obj.userData.opacity === 'number') ? obj.userData.opacity : 1,
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
          const tgt = _dragState.targetObj;
          // opacity 制御モード: 位置更新を無効化し、上下スワイプ Δy で透過度を 0〜1 にスライド
          //   アバターに opacity タグが付いている状態 (= Asset2 を選択 → Asset1 で解除まで持続)
          //   タグ中はどの cube を grab しても opacity モード
          //   上スワイプ (Δy<0) → opacity↑、下スワイプ (Δy>0) → opacity↓
          if (tgt && window.__opacityTagged) {
            const dy = y - _dragState.startY;
            const PX_PER_FULL = 400;   // 400px 動かすと 0→1 or 1→0
            const base = (typeof _dragState.startOpacity === 'number') ? _dragState.startOpacity : 1;
            const newOp = Math.max(0, Math.min(1, base - dy / PX_PER_FULL));
            tgt.userData.opacity = newOp;
            if (Array.isArray(tgt.material)) tgt.material.forEach((m) => { m.opacity = newOp; });
            else if (tgt.material) tgt.material.opacity = newOp;
            // 50ms スロットルで同期
            const nowMs = performance.now();
            if (!_dragState._lastOpT || nowMs - _dragState._lastOpT > 50) {
              _dragState._lastOpT = nowMs;
              if (socket && socket.connected) {
                socket.emit('cubeOpacity', { name: tgt.name, opacity: newOp });
              }
            }
            _dragState.moved = true;
            return;
          }
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
        //   ・ドラッグ方向を上下左右反転 (左ドラッグ → 面が右向き、上ドラッグ → 面が下向き)
        //   ・5° 単位にスナップ (クリックストップ感)
        if (_dragState.type !== 'base') return;
        const degPerPx = 15 / Math.max(5, moveSensitivity);
        const SNAP_DEG = 5;
        _tmpEuler.setFromQuaternion(_dragState.startQuat, 'YXZ');
        const startPitchDeg = THREE.MathUtils.radToDeg(_tmpEuler.x);
        const startYawDeg   = THREE.MathUtils.radToDeg(_tmpEuler.y);
        // 反転: +dx (右へ) → -yaw、+dy (下へ) → -pitch を廃止し、符号を逆向きに
        const dYawDeg   =  dx * degPerPx;
        const dPitchDeg =  dy * degPerPx;
        // 5° スナップ (開始角度 + ドラッグ量 の合計を 5° 単位に丸め)
        const PL_DEG = 90 - 1.5;
        const snappedPitchDeg = Math.max(-PL_DEG, Math.min(PL_DEG,
          Math.round((startPitchDeg + dPitchDeg) / SNAP_DEG) * SNAP_DEG));
        const snappedYawDeg   = Math.round((startYawDeg + dYawDeg) / SNAP_DEG) * SNAP_DEG;
        const newPitch = THREE.MathUtils.degToRad(snappedPitchDeg);
        const newYaw   = THREE.MathUtils.degToRad(snappedYawDeg);
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
      // 観測者 avatar の WASD 移動は "終了時のみ同期" にするため、保留状態を保持
      let _wasdAvatarPending = null;   // { avatarId, grp } | null
      function _flushAvatarPending() {
        if (!_wasdAvatarPending) return;
        const p = _wasdAvatarPending;
        if (socket && socket.connected && p.grp) {
          const q = p.grp.quaternion;
          socket.emit('controlPose', {
            targetId: p.avatarId,
            x: p.grp.position.x, y: p.grp.position.y, z: p.grp.position.z,
            qx: q.x, qy: q.y, qz: q.z, qw: q.w,
          });
        }
        _wasdAvatarPending = null;
        window.__masterOwnedAvatarId = null;   // 制御終了 → observer の pose を再度受け入れる
      }
      window.addEventListener('keyup', (e) => {
        keys.delete(e.code);
        // WASDQE いずれかの keyup → すべて離されたら avatar の最終位置を送信
        if (['KeyW','KeyA','KeyS','KeyD','KeyQ','KeyE'].indexOf(e.code) >= 0) {
          const anyDown = ['KeyW','KeyA','KeyS','KeyD','KeyQ','KeyE'].some((k) => keys.has(k));
          if (!anyDown) _flushAvatarPending();
        }
      });
      // 選択解除/フォーカスロスでも flush
      window.addEventListener('blur', _flushAvatarPending);

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
        // Master + 任意のオブジェクト選択中 → オブジェクトを移動 (カメラは動かさない)
        //   対象: scene light / observer avatar (apex/base) / その他 selectable
        //   選択外クリックで selectObject(null) されたらこの分岐は走らず camera 移動に戻る
        if (ROLE === 'master' && selectedObject) {
          const target = _getTransformTarget(selectedObject);
          const u = selectedObject.userData || {};
          if (target && (moveTmp.x || moveTmp.y || moveTmp.z)) {
            target.position.add(moveTmp);
            const HL2 = FIELD_HALF * 2;
            target.position.x = Math.max(-HL2, Math.min(HL2, target.position.x));
            target.position.z = Math.max(-HL2, Math.min(HL2, target.position.z));
            target.position.y = Math.max(0.05, Math.min(50, target.position.y));
            // observer avatar は "終了時のみ送信" (= WASD 全キー離した時に _flushAvatarPending で emit)
            if ((u.selectType === 'apex' || u.selectType === 'base') && u.avatarId) {
              _wasdAvatarPending = { avatarId: u.avatarId, grp: target };
              // 対象 observer の自前 pose を一時的に無視 (master 側カクつき防止)
              window.__masterOwnedAvatarId = u.avatarId;
            } else if (u.sceneObjectId) {
              const now = performance.now();
              if (now - _sceneObjSentAt > 40) {
                _sceneObjSentAt = now;
                if (socket && socket.connected) {
                  window.__selfMovingObjId = u.sceneObjectId;
                  clearTimeout(window.__selfMovingObjTimer);
                  window.__selfMovingObjTimer = setTimeout(() => { window.__selfMovingObjId = null; }, 200);
                  socket.emit('sceneObjectPose', {
                    id: u.sceneObjectId,
                    x: target.position.x, y: target.position.y, z: target.position.z,
                  });
                }
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

      // ========== plate1 / plate2 セルフタグ付与ボタン (観測者用) ==========
      //   クリックで自分自身に対して avatarTag(plate1 or plate2) を toggle emit
      //   サーバー側は role!=master の自己 plate タグに限り受理するよう緩和済み
      function _syncObsPlateButtons() {
        const self = (myId != null) ? avatars.get(myId) : null;
        const tags = (self && self.customTags) ? self.customTags : [];
        ['plate1', 'plate2'].forEach((tag) => {
          const btn = _by('obs-' + tag + '-toggle');
          if (!btn) return;
          const on = tags.indexOf(tag) >= 0;
          btn.style.background = on ? '#06b6d4' : '#475569';
          btn.style.color      = on ? '#083344' : 'white';
        });
      }
      window.__syncObsPlateButtons = _syncObsPlateButtons;
      ['plate1', 'plate2'].forEach((tag) => {
        _bind('obs-' + tag + '-toggle', 'click', () => {
          if (!myId || !socket || !socket.connected) return;
          const self = avatars.get(myId);
          const tags = (self && self.customTags) ? self.customTags : [];
          const nextOn = !(tags.indexOf(tag) >= 0);
          socket.emit('avatarTag', { targetId: myId, tag: tag, on: nextOn });
          log('self ' + tag + ' → ' + (nextOn ? 'ON' : 'OFF'), 'ok');
        });
      });
      _syncObsPlateButtons();

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
      // TransformControls ギズモの遅延初期化 (TransformControls スクリプトロード後)
      _initMasterGizmos();
      // ペイントモード toggle (木 / 川 / 空) — exclusive
      const _paintBtns = Array.from(document.querySelectorAll('.m-paint-toggle'));
      function _syncMasterPaintButtons() {
        const cur = window.__currentPaintMode || null;
        _paintBtns.forEach((btn) => {
          const on = (btn.dataset.mode === cur);
          btn.style.background = on ? '#22c55e' : '#475569';
          btn.style.color      = on ? '#052e16' : 'white';
        });
      }
      window.__syncMasterPaintButtons = _syncMasterPaintButtons;
      _paintBtns.forEach((btn) => {
        btn.addEventListener('click', () => {
          if (!socket || !socket.connected) return;
          const m = btn.dataset.mode;
          const next = (window.__currentPaintMode === m) ? null : m;
          socket.emit('paintMode', { mode: next });
        });
      });
      _syncMasterPaintButtons();
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

      // 全オブザーバーに一括適用 (master / camera role は対象外)
      //   ・ローカル状態 _allObsOffaxisOn を保持してトグル
      //   ・現入室中の observer に即座に displayConfig を emit (即時適用)
      //   ・後から入室する observer への自動適用はしない (必要ならもう一度押す)
      let _allObsOffaxisOn = false;
      function _syncAllObsOffaxisBtn() {
        const b = _by('m-offaxis-all-toggle');
        if (!b) return;
        b.textContent = '全 observer: ' + (_allObsOffaxisOn ? 'ON' : 'OFF');
        b.style.background = _allObsOffaxisOn ? '#06b6d4' : '#475569';
        b.style.color      = _allObsOffaxisOn ? '#083344' : 'white';
      }
      _syncAllObsOffaxisBtn();
      _bind('m-offaxis-all-toggle', 'click', () => {
        _allObsOffaxisOn = !_allObsOffaxisOn;
        _syncAllObsOffaxisBtn();
        if (!socket || !socket.connected) return;
        let cnt = 0;
        avatars.forEach((a, aid) => {
          if (!a || a.role !== 'observer') return;   // master / camera は除外
          socket.emit('displayConfig', { targetId: aid, offaxis: _allObsOffaxisOn });
          cnt++;
        });
        log('master offaxis ALL observers (' + cnt + ') → ' + (_allObsOffaxisOn ? 'ON' : 'OFF'), 'ok');
      });

      // viewerEye
      function applyViewerEye() {
        const x = parseFloat((_by('ve-x') || {}).value) || 0;
        const y = parseFloat((_by('ve-y') || {}).value) || 1.3;
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
        if (!rec || !rec.config || typeof rec.config.intensity !== 'number') {
          _lightRow.style.display = 'none';
          return;
        }
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
          //   movableCubes が空 (移動オブジェクト削除中) の場合は '--' 表示にして toFixed を回避
          if (movableCubes.length === 0) {
            _cubeMass.value = '';
            if (_cubeMassCur) _cubeMassCur.textContent = '--';
            return;
          }
          const masses = movableCubes.map((m) => (m.userData && typeof m.userData.mass === 'number') ? m.userData.mass : NaN);
          const same = masses.every((v) => v === masses[0]);
          _cubeMass.value = (same && isFinite(masses[0])) ? String(masses[0]) : '';
          if (_cubeMassCur) _cubeMassCur.textContent = (same && isFinite(masses[0])) ? masses[0].toFixed(2) : '混在';
          return;
        }
        const c = movableCubes.find((m) => m.name === name);
        if (!c || !c.userData || typeof c.userData.mass !== 'number') {
          _cubeMass.value = '';
          if (_cubeMassCur) _cubeMassCur.textContent = '--';
          return;
        }
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
          socket.emit('resetAtlas2');   // space3 と履歴を分離するため space2 専用イベント名
          log('resetSpace emit', 'ok');
        }
      });

      // ==================================================
      // materialBox 液体パラメータ (ローカル表示のみ、サーバー同期なし)
      // ==================================================
      const _matFreqInput = _by('m-matbox-freq');
      const _matFreqVal   = _by('m-matbox-freq-val');
      function _applyMatFreq() {
        if (!_matFreqInput) return;
        const v = parseFloat(_matFreqInput.value);
        if (!isFinite(v)) return;
        if (window.__matShader && window.__matShader.uniforms && window.__matShader.uniforms.uFreq) {
          window.__matShader.uniforms.uFreq.value = v;
        }
        if (_matFreqVal) _matFreqVal.textContent = v.toFixed(2);
      }
      if (_matFreqInput) {
        _matFreqInput.addEventListener('input', _applyMatFreq);
        _applyMatFreq();
      }

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
      // 自 avatar は非表示にしたため、毎フレーム追従処理は削除
      // ステータス表示 (10Hz に間引き — 毎フレーム DOM write は style recalc を誘発)
      if (window.__statusLastT == null) window.__statusLastT = 0;
      const _nowStatus = performance.now();
      if (_nowStatus - window.__statusLastT >= 100) {
        window.__statusLastT = _nowStatus;
        const cnt = document.getElementById('count');
        const mp = document.getElementById('my-pos');
        if (cnt) cnt.textContent = String(avatars.size + (state.entered ? 1 : 0));
        if (mp) mp.textContent =
          camera.position.x.toFixed(1) + ',' +
          camera.position.y.toFixed(1) + ',' +
          camera.position.z.toFixed(1);
      }

      // rope 更新は削除 (window.__updateRopes は no-op)


      // ========== materialBox pre-pass: 条件付き実行 (フレームレート向上) ==========
      //   旧: 毎フレーム scene をフル描画 (RT 向け) → 1 フレーム 2 回描画で高負荷
      //   新: (a) materialBox.visible が false → skip
      //       (b) materialBox が camera から 15m 以上離れている → skip
      //       (c) それ以外も 20Hz に間引き (clock から _mbLastT 比較)
      if (window.__materialBox && window.__matBgRT && window.__matShader) {
        const _mb = window.__materialBox;
        const _ic = window.__innerCube;
        if (_ic) {
          _ic.position.copy(_mb.position);
          _ic.quaternion.copy(_mb.quaternion);
        }
        const _mbVis = _mb.visible !== false;
        const _mbDist = _mb.position.distanceTo(camera.position);
        const _nowMs  = performance.now();
        if (window.__mbLastT == null) window.__mbLastT = 0;
        const _mbDue = (_nowMs - window.__mbLastT) >= (1000 / 20);   // 20Hz 上限
        if (_mbVis && _mbDist < 15 && _mbDue) {
          window.__mbLastT = _nowMs;
          const _mbWasVisible = _mb.visible;
          _mb.visible = false;
          renderer.setRenderTarget(window.__matBgRT);
          renderer.clear();
          renderer.render(scene, camera);
          renderer.setRenderTarget(null);
          _mb.visible = _mbWasVisible;
          window.__matShader.uniforms.uTime.value = clock.getElapsedTime();
        }
      }

      // ========== render: myDisplay.offaxis で分岐 ==========
      // プレートタグ付きオブザーバー: off-axis トグルに関わらず plate を display として恒常採用
      //   (space3 の Canvas 同期と同等思想: タグが設定された瞬間に plate が自身の "表示 canvas" に昇格)
      let _plateGrpForDisplay = null;
      if (ROLE === 'observer' && typeof window.__getMyPlateGrp === 'function') {
        _plateGrpForDisplay = window.__getMyPlateGrp();
      }
      const _useOffAxis = (_plateGrpForDisplay != null) || myDisplay.offaxis;
      if (_useOffAxis) {
        // ユーザー由来の姿勢を退避
        _oaSavePos.copy(camera.position);
        _oaSaveQuat.copy(camera.quaternion);
        let _usedPlate = false;
        let _plateW = myDisplay.width, _plateH = myDisplay.height;
        if (_plateGrpForDisplay && _plateGrpForDisplay.userData && _plateGrpForDisplay.userData.plateMesh) {
          // plate の world transform
          const pMesh = _plateGrpForDisplay.userData.plateMesh;
          pMesh.updateMatrixWorld(true);
          const pCenter = new THREE.Vector3().setFromMatrixPosition(pMesh.matrixWorld);
          const pQuat   = new THREE.Quaternion().setFromRotationMatrix(pMesh.matrixWorld);
          // outer 方向 = plate の local -Z を world へ (= L 字凸角方向)
          const outer = new THREE.Vector3(0, 0, -1).applyQuaternion(pQuat).normalize();
          _oaDispCenter.copy(pCenter);
          _oaDispQuat.copy(pQuat);   // applyOffAxisProjection 側で eye 裏面時に自動反転されるのでそのまま
          _oaEye.copy(pCenter).addScaledVector(outer, PLATE_APEX_OFFSET);
          _plateW = PLATE_W;
          _plateH = PLATE_H;
          // 観測者の "物理的" 位置も apex に瞬間移動: pose 送信で他クライアントが avatar を plate 位置に描画できるようにする
          camera.position.copy(_oaEye);
          camera.lookAt(pCenter);   // 画面法線と正対
          _oaSavePos.copy(camera.position);
          _oaSaveQuat.copy(camera.quaternion);
          _usedPlate = true;
        }
        if (!_usedPlate) {
          if (ROLE === 'camera') {
            // スマホ: eye = 自分の位置、画面 = 視線 20cm 前方、画面姿勢 = camera 姿勢
            _oaEye.copy(_oaSavePos);
            _oaTmp.set(0, 0, -1).applyQuaternion(_oaSaveQuat);
            _oaDispCenter.copy(_oaSavePos).addScaledVector(_oaTmp, CAM_WINDOW_DIST);
            _oaDispQuat.copy(_oaSaveQuat);
          } else {
            // observer / master: eye = viewerEye (共通固定点)、画面 = アバター位置
            _oaDispCenter.copy(_oaSavePos);
            _oaEye.set(viewerEye.x, viewerEye.y, viewerEye.z);
            _oaDispQuat.copy(_oaSaveQuat).multiply(_oaFlipQ);
          }
        }
        const ok = applyOffAxisProjection(
          camera, _oaEye, _oaDispCenter, _oaDispQuat,
          _plateW, _plateH,
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
        // observer のカメラは PLATE_LAYER を enable していないため、プレート群は自動的に
        //   自身視点のレンダーから除外される。追加の mesh.visible 操作は不要。
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
