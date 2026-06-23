// test/space.js
// バニラ Three.js 実装
//
// 役割:
//   camera  (スマホ): 一人称、DeviceOrientationEvent + 画面回転からquaternion構築
//                     near=0.005m なので自分の15cm球は視界に映らない (FrontSideのため内側は描画されない)
//   observer (PC)   : 三人称、自前OrbitControls + WASD移動
//
// 共通空間: 20m × 20m × 高さ自由 (中心原点)
//   座標範囲: X/Z は -10〜+10 (20m)、Y は 0〜+ (床から上)
//   マーカー: 1m の机上 (VR 上では (0, 1, 0) と扱う)
//   スポーン体積: 4m × 1m × 4m (中心 0,1.5,0 → 机周辺 + 目線高さ)
//   床: 中心 0,0,0 の20m四方
//   ワイヤフレーム: 20m境界(緑) + 4x1x4スポーンBox(黄)
//   グリッド: 1m間隔

(function main() {
  const log = (msg, cls) => window.uiLog && window.uiLog(msg, cls);

  // ============================================================
  // THREEが読まれるまで待機
  // ============================================================
  function waitForThree(cb, n = 100) {
    if (typeof THREE !== 'undefined') return cb();
    if (n <= 0) { log('THREEロードタイムアウト', 'err'); return; }
    setTimeout(() => waitForThree(cb, n - 1), 50);
  }
  waitForThree(start);

  function start() {
    log('THREE r' + THREE.REVISION + ' loaded', 'ok');

    // ====== ロール判定 ======
    // 優先順:
    //   1) URL ハッシュ #master  (デプロイなしで即試せる)
    //   2) URL クエリ ?role=master / observer / camera
    //   3) URL パス末尾 /master  (Firebase rewrite が必要)
    //   4) UA で camera/observer デフォルト
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

    {
      const badge = document.getElementById('role-badge');
      badge.textContent = ROLE.toUpperCase();
      badge.className = ROLE;
    }

    // ============================================================
    // タブ切り替え
    //   - 'vr':     既存の Three.js シーン
    //   - 'camera': A-Frame + AR.js (遅延ロード、初回タブ表示時にロード)
    //   Socket.IO 接続は全タブで維持。VRタブ以外では pose 送信を停止。
    // ============================================================
    const tabState = {
      active: 'vr',
      cameraInitialized: false,
    };

    function switchTab(name) {
      if (tabState.active === name) return;
      tabState.active = name;
      document.querySelectorAll('#tabbar button').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.tab === name);
      });
      document.querySelectorAll('.tab-content').forEach((el) => {
        el.classList.toggle('active', el.id === 'tab-' + name);
      });
      // マーカーステータスはカメラタブのみ
      const ms = document.getElementById('marker-status');
      if (ms) ms.style.display = (name === 'camera') ? 'block' : 'none';

      if (name === 'camera' && !tabState.cameraInitialized) {
        tabState.cameraInitialized = true;
        initCameraTab();
      }
      log('tab → ' + name);
    }

    document.querySelectorAll('#tabbar button').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    function loadScript(src) {
      return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.async = false;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('script load failed: ' + src));
        document.head.appendChild(s);
      });
    }

    // カメラタブ内の AR.js 状態 (タブ切替で破棄しない)
    const arState = {
      ready: false,
      video: null,
      arContext: null,
      markerRoot: null,
      markerVisible: false,
      frameCount: 0,
    };

    async function initCameraTab() {
      const container = document.getElementById('tab-camera');
      container.innerHTML = '';

      // 早期診断: すぐに setInterval を登録して setInterval 自体が動くか確認
      let earlyDiag = 0;
      const earlyDiagId = setInterval(() => {
        earlyDiag++;
        log('early diag #' + earlyDiag);
      }, 2000);

      try {
        // ====== ar.js ロード ======
        if (typeof window.ARjs === 'undefined') {
          log('loading ar.js...');
          await loadScript('/vendor/ar.js');
          log('ar.js loaded', 'ok');
        }
        const ARjs = window.ARjs;
        if (!ARjs || !ARjs.Context || !ARjs.Anchor) {
          const keys = ARjs ? Object.keys(ARjs).join(', ') : '(none)';
          throw new Error('ARjs API not found. keys=' + keys);
        }

        // ====== getUserMedia で video を直接取得 (動作確認済み) ======
        const video = document.createElement('video');
        video.setAttribute('autoplay', '');
        video.setAttribute('muted', '');
        video.setAttribute('playsinline', '');
        video.muted = true;
        video.playsInline = true;
        video.style.position = 'absolute';
        video.style.top = '0';
        video.style.left = '0';
        video.style.width = '100%';
        video.style.height = '100%';
        video.style.objectFit = 'cover';
        video.style.zIndex = '1';
        container.appendChild(video);

        log('requesting camera...');
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        video.srcObject = stream;
        await video.play().catch(() => {});
        // videoWidth が確定するまで loadedmetadata を待つ
        if (!video.videoWidth) {
          await new Promise((res) => {
            const onMeta = () => { video.removeEventListener('loadedmetadata', onMeta); res(); };
            video.addEventListener('loadedmetadata', onMeta);
            setTimeout(res, 3000);
          });
        }
        log('video ready ' + video.videoWidth + 'x' + video.videoHeight, 'ok');
        arState.video = video;

        // ====== AR用 Three.js シーン (VR とは別) ======
        const arScene = new THREE.Scene();
        const arCamera = new THREE.Camera();
        arScene.add(arCamera);
        arScene.add(new THREE.AmbientLight(0xffffff, 0.9));

        const arRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        arRenderer.setClearColor(0x000000, 0);
        arRenderer.setPixelRatio(window.devicePixelRatio || 1);
        arRenderer.setSize(window.innerWidth, window.innerHeight - 44);
        const arCanvas = arRenderer.domElement;
        arCanvas.style.position = 'absolute';
        arCanvas.style.top = '0';
        arCanvas.style.left = '0';
        arCanvas.style.width = '100%';
        arCanvas.style.height = '100%';
        arCanvas.style.zIndex = '2';
        arCanvas.style.pointerEvents = 'none';
        container.appendChild(arCanvas);

        // ====== AR.js Context (検出だけ AR.js に任せる) ======
        const arContext = new ARjs.Context({
          cameraParametersUrl: '/data/camera_para.dat',
          detectionMode: 'mono',
          maxDetectionRate: 30,
          canvasWidth: video.videoWidth,
          canvasHeight: video.videoHeight,
        });
        await new Promise((resolve) => {
          arContext.init(() => {
            arCamera.projectionMatrix.copy(arContext.getProjectionMatrix());
            log('AR context ready (ctrl=' +
                (arContext.arController ? 'OK' : 'NULL') + ')',
                arContext.arController ? 'ok' : 'err');
            // showObject が truthy だと per-frame の visible リセットが効かなくなる
            if (arContext.arController) {
              arContext.arController.showObject = false;
            }
            resolve();
          });
        });
        arState.arContext = arContext;

        // ====== ファイル取得確認 ======
        fetch('/data/patt.hiro').then((r) =>
          log('patt.hiro: HTTP ' + r.status, r.ok ? 'ok' : 'err')
        ).catch((e) => log('patt.hiro fetch err: ' + e.message, 'err'));
        fetch('/data/camera_para.dat').then((r) =>
          log('camera_para.dat: HTTP ' + r.status, r.ok ? 'ok' : 'err')
        ).catch((e) => log('camera_para fetch err: ' + e.message, 'err'));

        // ====== Marker (Hiro パターン) - 低レベル直結 ======
        // ARjs.Anchor の visible 状態が信頼できないので arController を直接使う
        const markerRoot = new THREE.Group();
        markerRoot.matrixAutoUpdate = false;
        markerRoot.visible = false; // 明示的に false 開始
        arScene.add(markerRoot);
        arState.markerRoot = markerRoot;

        // 視覚インジケータ (50cm キューブ + 軸)
        const cube = new THREE.Mesh(
          new THREE.BoxGeometry(0.5, 0.5, 0.5),
          new THREE.MeshNormalMaterial({ transparent: true, opacity: 0.7 })
        );
        cube.position.y = 0.25;
        markerRoot.add(cube);
        markerRoot.add(new THREE.AxesHelper(0.5));

        // Hiro パターンを arController に直接ロード (Promise を返す API)
        log('loading Hiro pattern...');
        let markerId;
        try {
          markerId = await arContext.arController.loadMarker('/data/patt.hiro');
          log('Hiro pattern loaded, id=' + markerId, 'ok');
        } catch (e) {
          log('loadMarker failed: ' + (e && e.message ? e.message : e), 'err');
          throw e;
        }
        // 追跡対象として登録 (これが無いと getMarker イベントが発火しない)
        // 注意: このバンドルでは markerWidth に小さい値 (例 0.15) を渡すと
        //       内部の getTransMatSquare が数値的に発散し、巨大な値が返る。
        //       markerWidth = 1 (= 1 marker width 単位) で受けて、消費側で
        //       実マーカーサイズ MARKER_SIZE_M を掛けて m 変換する。
        const MARKER_SIZE_M = 0.15; // 15cm × 15cm 印刷想定。実測値に合わせて調整
        arContext.arController.trackPatternMarkerId(markerId, 1);
        log('tracking enabled for id=' + markerId +
            ' (markerWidth=1 unit, real=' + (MARKER_SIZE_M * 100).toFixed(1) + 'cm)', 'ok');
        arState.markerId = markerId;
        arState.markerSizeM = MARKER_SIZE_M;

        // 検出イベントを直接購読
        let lastDetectedAt = 0;
        const CONFIDENCE_THRESHOLD = 0.5; // cfPatt の閾値
        const LOST_TIMEOUT_MS = 300;

        // マーカー検出 → VR座標同期 (false→true 遷移時のみ実行)
        //
        // 座標系メモ:
        //   AR.js マーカー座標系 (印刷面を上にして机に置いた前提):
        //     +X = 右 (印刷の右辺)、+Y = 印刷面内の "北" 方向、+Z = マーカー法線 (= 現実の上)
        //   Three.js VR ワールド:
        //     +X = 右、+Y = 上、+Z = 前方
        //   → AR の +Z を VR の +Y に、AR の +Y を VR の -Z にマップ
        //     (X 軸まわり -90° 回転に相当)
        // マーカーは実世界では「1m の机上」に置かれている前提
        //   → VR 座標系では (0, MARKER_VR_Y, 0) として扱う
        const MARKER_VR_Y = 1.0;

        function syncAvatarToMarker() {
          // 逆行列の平行移動成分 = カメラ位置を marker-local 座標で表した値
          // (markerWidth=1 で得たので単位は "marker widths")
          const inv = new THREE.Matrix4().copy(markerRoot.matrix).invert();
          const camInMarkerWidths = new THREE.Vector3().setFromMatrixPosition(inv);

          // marker widths → メートルへスケール
          const camInMarker = camInMarkerWidths.clone().multiplyScalar(MARKER_SIZE_M);

          // 軸スワップ: AR marker-local → VR world
          //   さらに机上 1m 分のオフセットを Y に加える
          const camInVR = new THREE.Vector3(
             camInMarker.x,                  // 右はそのまま
             camInMarker.z + MARKER_VR_Y,    // マーカー法線 + 机の高さ
            -camInMarker.y                   // マーカー面内 "北" → VR の "後方"
          );

          // markerRoot.position (marker をカメラから見た位置)
          const mp = markerRoot.position;
          log('marker pos in cam=(' +
              mp.x.toFixed(3) + ',' + mp.y.toFixed(3) + ',' + mp.z.toFixed(3) + ')  ' +
              '|len|=' + mp.length().toFixed(3), 'ok');

          log('SYNC → VR=(' +
              camInVR.x.toFixed(2) + ',' +
              camInVR.y.toFixed(2) + ',' +
              camInVR.z.toFixed(2) + ')  ' +
              '[invRaw=' + camInMarker.x.toFixed(2) + ',' +
              camInMarker.y.toFixed(2) + ',' +
              camInMarker.z.toFixed(2) + ']', 'ok');

          if (ROLE === 'camera') {
            // VR 側のユーザー位置を更新 (Socket.IO 経由で他クライアントにも反映される)
            state.mySpawn = { x: camInVR.x, y: camInVR.y, z: camInVR.z };
            camera.position.copy(camInVR);
            // 歩行追跡をこの位置からスタート (アンカー設定)
            startWalking(camInVR);
            // 没入感を維持するため自動で VR タブへ
            if (tabState.active === 'camera') {
              setTimeout(() => switchTab('vr'), 250);
            }
          }
          // observer ロールの場合はログのみ (アバターを持たないため)
        }
        arState.syncAvatarToMarker = syncAvatarToMarker;

        // 行列フォーマット診断は最初の検出時のみ出力
        let matrixDiagShown = false;

        // 異常値フィルタの閾値 (marker-width 単位)
        // 15cm マーカーで 5m 先までを許容 → 5 / 0.15 ≈ 33 marker widths
        const MAX_DISTANCE_WIDTHS = 50;
        const MIN_CONFIDENCE = 0.6;

        arContext.arController.addEventListener('getMarker', (ev) => {
          const m = ev.data.marker;
          if (!m) return;
          if (m.idPatt !== markerId) return;
          if (m.cfPatt < MIN_CONFIDENCE) return; // 信頼度が低すぎ

          const mtxArray = ev.data.matrix; // ARToolkit transform_mat (column-major 16要素)

          // 異常値検出: column-major translation 部分が異常に大きければ拒否
          const tx = mtxArray[12], ty = mtxArray[13], tz = mtxArray[14];
          const distWidths = Math.sqrt(tx * tx + ty * ty + tz * tz);
          if (!isFinite(distWidths) || distWidths > MAX_DISTANCE_WIDTHS || distWidths < 0.1) {
            // 不安定な検出 → 同期スキップ、visible 状態は維持
            if (!matrixDiagShown) {
              matrixDiagShown = true;
              log('reject detection: dist=' + distWidths.toFixed(2) +
                  'w cfPatt=' + m.cfPatt.toFixed(2), 'err');
            }
            return;
          }

          // ====== 初回のみ生データを詳細ログ ======
          if (!matrixDiagShown) {
            matrixDiagShown = true;
            const fmt = (arr) => arr ? '[' +
              Array.from(arr).map((v) => v.toFixed(3)).join(', ') + ']' : 'null';
            log('matrix accepted, dist=' + distWidths.toFixed(2) + 'w', 'ok');
            log('  ' + fmt(mtxArray), 'ok');
          }

          const wasVisible = markerRoot.visible;
          markerRoot.matrix.fromArray(mtxArray);
          markerRoot.matrix.decompose(
            markerRoot.position,
            markerRoot.quaternion,
            markerRoot.scale
          );
          markerRoot.visible = true;
          lastDetectedAt = performance.now();

          // 未検出 → 検出 への遷移時だけ VR 座標を同期する
          if (!wasVisible) {
            syncAvatarToMarker();
          }
        });
        arState.checkLost = () => {
          if (markerRoot.visible &&
              performance.now() - lastDetectedAt > LOST_TIMEOUT_MS) {
            markerRoot.visible = false;
          }
        };

        log('marker anchor ready (id=' + markerId + ')', 'ok');

        // ====== レンダーループ ======
        let updateErr = null;
        function arTick() {
          requestAnimationFrame(arTick);
          if (tabState.active !== 'camera') return;
          if (!video.videoWidth) return;

          if (arState.frameCount === 0) {
            log('AR loop START', 'ok');
          }
          arState.frameCount++;

          try {
            arContext.update(video);
          } catch (e) {
            if (!updateErr) {
              updateErr = e.message;
              log('arContext.update threw: ' + e.message, 'err');
            }
          }

          // 検出イベントが直近 LOST_TIMEOUT_MS 内に無ければ非表示にする
          if (arState.checkLost) arState.checkLost();

          updateMarkerUi(markerRoot);
          arRenderer.render(arScene, arCamera);
        }
        arTick();

        // ====== 持続診断 (2秒ごと) ======
        clearInterval(earlyDiagId);
        arState.diagInterval = setInterval(() => {
          const p = markerRoot.position;
          log('diag: frames=' + arState.frameCount +
              ', visible=' + markerRoot.visible +
              ', pos=(' + p.x.toFixed(2) + ',' + p.y.toFixed(2) + ',' + p.z.toFixed(2) + ')' +
              ', tab=' + tabState.active);
        }, 2000);

        arState.ready = true;
        log('AR tab READY', 'ok');
      } catch (e) {
        clearInterval(earlyDiagId);
        log('initCameraTab error: ' + e.message, 'err');
        container.innerHTML =
          '<div class="cam-error">初期化失敗: ' + e.message +
          '<br>HTTPS とカメラ許可を確認してください。</div>';
      }
    }

    function updateMarkerUi(markerRoot) {
      const t = document.getElementById('marker-text');
      const s = document.getElementById('marker-status');
      if (!t || !s) return;

      if (markerRoot.visible) {
        // changeMatrixMode='modelViewMatrix' のとき markerRoot.position は
        // カメラ原点系での位置。長さがカメラからの距離 (m)
        const dist = markerRoot.position.length();
        t.textContent = 'Hiro 検出中 / 距離 ' + dist.toFixed(2) + ' m';
        s.classList.add('detected');
        if (!arState.markerVisible) {
          arState.markerVisible = true;
          window.uiLog && window.uiLog('Hiro marker FOUND', 'ok');
        }
      } else {
        t.textContent = 'マーカー未検出';
        s.classList.remove('detected');
        if (arState.markerVisible) {
          arState.markerVisible = false;
          window.uiLog && window.uiLog('Hiro marker lost');
        }
      }
    }

    // ============================================================
    // Three.js セットアップ
    // ============================================================
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1c1c28); // 薄暗いブルーグレー (周囲が見える程度)
    scene.fog = new THREE.FogExp2(0x1c1c28, 0.022); // 控えめな霧 (光の筋は見える)

    const camera = new THREE.PerspectiveCamera(
      72,
      window.innerWidth / window.innerHeight,
      0.005,   // near: 5mm → 7.5cm 半径の球の中からは backface が描画されないため映らない
      2000
    );

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(window.innerWidth, window.innerHeight - 44); // タブバー44px分減算
    document.getElementById('tab-vr').appendChild(renderer.domElement);

    // 環境光 (ライト演出と視認性のバランス)
    scene.add(new THREE.AmbientLight(0xffffff, 0.45));
    const dirLight = new THREE.DirectionalLight(0xd0d8e8, 0.45);
    dirLight.position.set(10, 20, 10);
    scene.add(dirLight);
    const hemi = new THREE.HemisphereLight(0x7080a0, 0x303038, 0.3);
    scene.add(hemi);
    // カメラを scene に追加 (子オブジェクトの SpotLight が機能するため)
    scene.add(camera);

    // ============================================================
    // スプレーペイント システム (シングル RT + 加算ブレンド版)
    //   - 床面 (20m × 20m) を共有キャンバスとして扱う
    //   - 1 枚の RenderTarget へ Fragment Shader で粒を「premultiplied alpha + 加算ブレンド」で蓄積
    //     → ping-pong 不要 / RT を読み戻さない / 同フレーム read-write 競合なし
    //   - 床マテリアル: baseColor を背景に paint テクスチャ (premultiplied) を OVER 合成
    //   - スプレーイベント (位置・方向・色・半径・時刻) は Socket.IO で全クライアントへ
    //   - 全クライアントが同じ処理 (raycast→UV→shader pass) を実行 → 結果は決定的に一致
    // ============================================================
    const FIELD_HALF = 10;      // 床は ±10m
    const FIELD_SIZE = 20;      // 全幅 20m
    const PAINT_RES = 1024;     // ペイントテクスチャ解像度
    const paintRTOpts = {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    };
    const paintRT = new THREE.WebGLRenderTarget(PAINT_RES, PAINT_RES, paintRTOpts);
    // 初期化: 透明にクリア (alpha=0)
    {
      const prevTarget = renderer.getRenderTarget();
      const prevClearColor = new THREE.Color();
      renderer.getClearColor(prevClearColor);
      const prevClearAlpha = renderer.getClearAlpha();
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(paintRT);
      renderer.clear();
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(prevClearColor, prevClearAlpha);
    }

    // ペイント書き込みシェーダー
    //   出力: premultiplied alpha (rgb はすでに alpha 乗算済み)
    //   ブレンド: dst.rgb = src.rgb * 1 + dst.rgb * (1 - src.a)  (OVER)
    //            dst.a   = src.a   * 1 + dst.a   * (1 - src.a)
    //   → 粒を撒くたびに RT へ層状に積まれる。読み戻し不要。
    const paintShaderMat = new THREE.ShaderMaterial({
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
        uniform float u_seed;     // 0..1000 程度の小さな値を渡す (float32 精度確保)
        uniform float u_density;

        // ハッシュノイズ (粒状感の元)
        //   入力を mod で範囲制限し float32 精度の崩壊を防ぐ
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
          // 高周波ノイズで粒を散布 (vUv は [0..1] なので 600 倍してテクセル幅程度のノイズに)
          float n = hash(vUv * 600.0 + vec2(u_seed, u_seed * 1.37));
          float threshold = 1.0 - falloff * u_density;
          if (n < threshold) discard;
          // 1 発の不透明度 (中心ほど濃い)
          float alpha = clamp(falloff * 0.6 + 0.25, 0.0, 1.0);
          // premultiplied alpha 出力
          gl_FragColor = vec4(u_color * alpha, alpha);
        }
      `,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    const paintScene = new THREE.Scene();
    const paintCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const paintQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), paintShaderMat);
    paintScene.add(paintQuad);

    // 床ペイント (汎用 applyPaintTo は後段で定義 → 関数巻き上げ)
    function applyPaintToFloor(uv, uvRadius, color, seed) {
      applyPaintTo(paintRT, uv, uvRadius, color, seed);
    }

    // 床マテリアル: 基本色 + ペイントテクスチャ (premultiplied) を OVER 合成
    //   paint.rgb は既に paint.a を乗算済み → そのまま baseColor 上に重ねる
    const floorMaterial = new THREE.ShaderMaterial({
      uniforms: {
        u_baseColor: { value: new THREE.Color(0x55555c) },
        u_paint:     { value: paintRT.texture },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform vec3 u_baseColor;
        uniform sampler2D u_paint;
        void main() {
          vec4 paint = texture2D(u_paint, vUv);
          // premultiplied alpha: paint.rgb は paint.a 乗算済みなので加算ベースで合成
          vec3 col = u_baseColor * (1.0 - paint.a) + paint.rgb;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });

    // ============================================================
    // 環境構築: 床・グリッド・境界・スポーン体積 (中心原点)
    // ============================================================
    // 床: 中心(0,0,0)、20×20 (スプレーペイント可能な ShaderMaterial)
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(FIELD_SIZE, FIELD_SIZE),
      floorMaterial
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, 0, 0);
    ground.name = 'ground';   // ヒット同期用ルックアップキー
    scene.add(ground);

    // ============================================================
    // Paintable レジストリ (床 + FBX サブメッシュ)
    //   各メッシュは userData.paintRT に専用 RT を持ち、Raycaster で
    //   交差した先の RT に対し同じ paintShaderMat を流して着色する
    // ============================================================
    const paintables = [];
    // 床を登録
    ground.userData.paintRT = paintRT;
    paintables.push(ground);

    // 汎用ペイント書き込み (任意の RT へ shader pass)
    function applyPaintTo(rt, uvCenter, uvRadius, color, seed) {
      paintShaderMat.uniforms.u_uvCenter.value.copy(uvCenter);
      paintShaderMat.uniforms.u_radius.value = uvRadius;
      paintShaderMat.uniforms.u_color.value.set(color);
      // seed は時刻 (ms) で巨大 → 0..1000 に圧縮 (float32 精度確保)
      const seedSmall = ((Number(seed) >>> 0) % 100000) * 0.01;
      paintShaderMat.uniforms.u_seed.value = seedSmall;

      const prevTarget = renderer.getRenderTarget();
      const oldAutoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.setRenderTarget(rt);
      renderer.render(paintScene, paintCamera);
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = oldAutoClear;
    }

    // ジオメトリに有効な `uv` 属性が無い場合、bounding box 平面投影で生成
    //   FBX (whale / fox 等) は元々テクスチャを持たないジオメトリだと uv 属性が空 or 全 0 の事があり、
    //   その場合は vPaintUv = uv が常に (0, 0) となり paint が原点コーナーにしか書かれない
    function ensureUV(geometry) {
      if (!geometry || !geometry.attributes || !geometry.attributes.position) return;
      const uv = geometry.attributes.uv;
      let needGenerate = false;
      if (!uv) {
        needGenerate = true;
      } else {
        // 軽く先頭 50 頂点を見て全て (0,0) なら degenerate と判定
        let nonZero = false;
        const sample = Math.min(uv.count, 50);
        for (let i = 0; i < sample; i++) {
          if (Math.abs(uv.getX(i)) > 1e-5 || Math.abs(uv.getY(i)) > 1e-5) { nonZero = true; break; }
        }
        if (!nonZero) needGenerate = true;
      }
      if (!needGenerate) return;
      // bbox の最大 2 軸で planar 投影 (最小軸を投影方向にする = 物体の正面に展開)
      geometry.computeBoundingBox();
      const bb = geometry.boundingBox;
      const sx = bb.max.x - bb.min.x;
      const sy = bb.max.y - bb.min.y;
      const sz = bb.max.z - bb.min.z;
      let pickU, pickV, sizeU, sizeV, minU, minV;
      if (sx <= sy && sx <= sz) {       // X 最小: Y-Z 平面に投影
        pickU = 'y'; pickV = 'z'; sizeU = sy; sizeV = sz; minU = bb.min.y; minV = bb.min.z;
      } else if (sy <= sx && sy <= sz) { // Y 最小: X-Z 平面
        pickU = 'x'; pickV = 'z'; sizeU = sx; sizeV = sz; minU = bb.min.x; minV = bb.min.z;
      } else {                           // Z 最小: X-Y 平面
        pickU = 'x'; pickV = 'y'; sizeU = sx; sizeV = sy; minU = bb.min.x; minV = bb.min.y;
      }
      const pos = geometry.attributes.position;
      const arr = new Float32Array(pos.count * 2);
      const safeU = Math.max(sizeU, 1e-4);
      const safeV = Math.max(sizeV, 1e-4);
      for (let i = 0; i < pos.count; i++) {
        const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
        const uVal = pickU === 'x' ? px : (pickU === 'y' ? py : pz);
        const vVal = pickV === 'x' ? px : (pickV === 'y' ? py : pz);
        arr[i * 2]     = (uVal - minU) / safeU;
        arr[i * 2 + 1] = (vVal - minV) / safeV;
      }
      geometry.setAttribute('uv', new THREE.BufferAttribute(arr, 2));
    }

    // メッシュをペイント可能化 (既存マテリアルを **複製せず** その場で onBeforeCompile 注入)
    //   - 複製しない理由: SkinnedMesh のスケルトン/ボーン束縛や FBXLoader 内部参照は
    //     material.clone() で失われる事があり、アニメーションが止まる原因になる
    //   - 同じマテリアルを共有する複数サブメッシュは **同じ paintRT** を共有 (UV 空間も共有)
    //   - 1 つのモデル (= 1 マテリアル) = 1 paintRT という運用になる
    function makePaintable(mesh, opts) {
      opts = opts || {};
      if (!mesh || !mesh.material) return;
      if (mesh.userData.paintRT) return; // 重複登録防止

      // UV 属性が無いジオメトリには平面投影 UV を生成
      ensureUV(mesh.geometry);

      // mesh.material が配列の場合はサポート外 (FBX は通常単一マテリアル)
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      if (!mat) return;
      if (!mat.userData) mat.userData = {};

      let rt = mat.userData.paintRT;
      if (!rt) {
        // このマテリアル用 paintRT を新規作成
        const res = opts.res || 512;
        rt = new THREE.WebGLRenderTarget(res, res, paintRTOpts);
        // 透明クリア
        const prevTarget = renderer.getRenderTarget();
        const prevClearColor = new THREE.Color();
        renderer.getClearColor(prevClearColor);
        const prevClearAlpha = renderer.getClearAlpha();
        renderer.setClearColor(0x000000, 0);
        renderer.setRenderTarget(rt);
        renderer.clear();
        renderer.setRenderTarget(prevTarget);
        renderer.setClearColor(prevClearColor, prevClearAlpha);
        mat.userData.paintRT = rt;

        // onBeforeCompile はマテリアル毎に 1 度だけ注入
        const userUniform = { value: rt.texture };
        mat.userData.paintUniform = userUniform;
        const origOBC = mat.onBeforeCompile;
        mat.onBeforeCompile = (shader, renderer2) => {
          if (typeof origOBC === 'function') origOBC(shader, renderer2);
          // ★ 動作診断: 各マテリアル初回コンパイル時に 1 度だけログ
          try {
            log('paint inject: ' + (mat.type || 'mat') +
                ' uuid=' + mat.uuid.substr(0, 8) +
                ' frag has <output_fragment>=' + (shader.fragmentShader.indexOf('#include <output_fragment>') !== -1) +
                ' has <opaque_fragment>=' + (shader.fragmentShader.indexOf('#include <opaque_fragment>') !== -1),
              'ok');
          } catch (_) {}
          // 重要: 新たに作る uniform をシェーダーへ追加
          shader.uniforms.u_paint = userUniform;
          // vertex: UV を varying で渡す
          //   - `uv` attribute は Three.js prefix で常に宣言される
          //   - skinning など既存ロジックは触らない
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
          // fragment: 最終色直後に paint を OVER 合成
          //   - output_fragment (r150) / opaque_fragment (r152+) の両方を試す
          //   - どちらも無ければ最後の `}` 直前に挿入
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
          const before = fs;
          const markers = ['#include <output_fragment>', '#include <opaque_fragment>'];
          let injected = false;
          for (const m of markers) {
            if (fs.indexOf(m) !== -1) {
              fs = fs.replace(m, m + '\n' + paintCompose);
              injected = true;
              break;
            }
          }
          if (!injected) {
            // 最後の `}` (main 関数末尾) の直前に挿入
            fs = fs.replace(/\}\s*$/, paintCompose + '\n}');
          }
          shader.fragmentShader = fs;
        };
        // 重要: customProgramCacheKey を一意化して別プログラムを強制
        //   ・無いと 3 つの MeshStandardMaterial が同一 onBeforeCompile 文字列 + 同一プロパティで
        //     プログラムキャッシュキー衝突 → 1 プログラム共有 → shader.uniforms.u_paint が
        //     後発マテリアルで上書きされ全モデルが「最後に登録された RT」を参照する事象を回避
        const _key = 'paintable_' + mat.uuid;
        mat.customProgramCacheKey = function() { return _key; };
        mat.userData.paintInjected = true;
        mat.needsUpdate = true;
      }

      mesh.userData.paintRT = rt;
      paintables.push(mesh);
    }

    // モデル全体 (Group) を traverse し isMesh 全てをペイント可能化
    function paintifyModel(root, opts) {
      if (!root) return;
      root.traverse((c) => {
        if (c.isMesh) makePaintable(c, opts);
      });
    }

    // ============================================================
    // スプレー発射/受信処理
    //   - emitSprayPulse(): カメラ前方を ray → 床面交点を求めてイベント送信 + 自分も再生
    //   - processSprayEvent(): 受信 or ローカル発射されたイベントを Shader pass で書き込み
    //   - 半径は cone 半角 (rad) で送信し、受信側で「距離 × tan(半角)」から世界半径を計算
    //     → 全クライアントで同じ床面 UV / 半径 / シードが算出され、結果が一致する
    // ============================================================
    const SPRAY_HALF_ANGLE = Math.PI / 9;    // 20° (円錐半角) - 視認性重視
    const SPRAY_EMIT_HZ    = 20;             // 1 秒間に何回発射するか
    const SPRAY_MAX_DIST   = 30;             // 30m を越えたら床に届かないものとして無視
    const SPRAY_MIN_UVR    = 0.015;          // UV 半径下限 (約 0.3m: 床ピクセルでも見える大きさ)
    const SPRAY_MAX_UVR    = 0.25;
    const _spraySource = new THREE.Vector3();
    const _sprayDir    = new THREE.Vector3();
    const _sprayHit    = new THREE.Vector3();
    const _sprayUv     = new THREE.Vector2();
    const _sprayRaycaster = new THREE.Raycaster();

    // スプレー視覚化用 (発射者本人の手元から床に伸びる円錐 + 床ヒット円)
    const sprayConeVis = new THREE.Group();
    sprayConeVis.visible = false;
    scene.add(sprayConeVis);
    const sprayHitDisk = new THREE.Mesh(
      new THREE.RingGeometry(0.05, 0.18, 32),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, side: THREE.DoubleSide })
    );
    sprayHitDisk.rotation.x = -Math.PI / 2;
    sprayConeVis.add(sprayHitDisk);

    let _spraySeen = false;
    const _spraySeenObjects = new Set();

    // paintables から name で検索 (受信側で同名オブジェクトを引き当てる)
    function lookupPaintableByName(name) {
      if (!name) return null;
      if (name === 'ground' || name === 'floor') return ground;
      for (const m of paintables) {
        if (m.name === name) return m;
      }
      return null;
    }

    // スプレーイベント処理:
    //   Path 1 (推奨): data.targetName + hitU/hitV を使って直接ペイント
    //     → 動いている FBX に対しレイテンシでズレない (送信側 raycast 結果を再利用)
    //   Path 2 (フォールバック): 位置/方向から raycast (旧クライアント互換、床のみ動作確実)
    function processSprayEvent(data) {
      if (!data || typeof data !== 'object') return;
      const color = (typeof data.color === 'string') ? data.color : '#ffffff';
      const time = (typeof data.time === 'number') ? data.time : performance.now();

      // ---- Path 1: ヒント (送信側で確定した hit 情報) を使う ----
      if (typeof data.targetName === 'string' &&
          typeof data.hitU === 'number' &&
          typeof data.hitV === 'number') {
        const target = lookupPaintableByName(data.targetName);
        if (target && target.userData.paintRT) {
          const uvR = (typeof data.uvRadius === 'number')
            ? Math.max(SPRAY_MIN_UVR, Math.min(SPRAY_MAX_UVR, data.uvRadius))
            : 0.035;
          _sprayUv.set(data.hitU, data.hitV);
          applyPaintTo(target.userData.paintRT, _sprayUv, uvR, color, time);
          if (!_spraySeenObjects.has(target.uuid)) {
            _spraySeenObjects.add(target.uuid);
            const tag = (target === ground) ? 'floor' : data.targetName;
            try { log(`spray hit on ${tag} uv=(${data.hitU.toFixed(2)},${data.hitV.toFixed(2)}) r=${uvR.toFixed(3)} [hint]`, 'ok'); } catch (_) {}
          }
          _spraySeen = true;
          return;
        }
        // ヒント先が見つからなければ raycast へフォールバック
      }

      // ---- Path 2: raycast フォールバック (位置/方向のみ送られてきた旧形式用) ----
      const sx = +data.x, sy = +data.y, sz = +data.z;
      const dx = +data.dx, dy = +data.dy, dz = +data.dz;
      const halfAngle = (typeof data.halfAngle === 'number') ? data.halfAngle : SPRAY_HALF_ANGLE;
      if (!isFinite(sx + sy + sz + dx + dy + dz)) return;

      _spraySource.set(sx, sy, sz);
      _sprayDir.set(dx, dy, dz).normalize();
      if (_sprayDir.lengthSq() < 1e-6) return;

      _sprayRaycaster.set(_spraySource, _sprayDir);
      _sprayRaycaster.far = SPRAY_MAX_DIST;
      _sprayRaycaster.near = 0;

      const hits = _sprayRaycaster.intersectObjects(paintables, false);
      if (hits.length === 0) return;
      const hit = hits[0];
      if (!hit.uv) return;
      if (hit.distance <= 0 || hit.distance > SPRAY_MAX_DIST) return;

      const worldRadius = hit.distance * Math.tan(halfAngle);
      let uvRadius = (hit.object === ground) ? worldRadius / FIELD_SIZE : 0.035;
      uvRadius = Math.max(SPRAY_MIN_UVR, Math.min(SPRAY_MAX_UVR, uvRadius));

      const rt = hit.object.userData.paintRT;
      if (!rt) return;
      applyPaintTo(rt, hit.uv, uvRadius, color, time);

      if (!_spraySeenObjects.has(hit.object.uuid)) {
        _spraySeenObjects.add(hit.object.uuid);
        let tag = (hit.object === ground) ? 'floor' : (hit.object.name || 'mesh');
        if (hit.object !== ground) {
          let p = hit.object;
          while (p && !p.name) p = p.parent;
          if (p && p.name) tag = `${p.name}/${hit.object.name || 'sub'}`;
        }
        try { log(`spray hit on ${tag} uv=(${hit.uv.x.toFixed(2)},${hit.uv.y.toFixed(2)}) r=${uvRadius.toFixed(3)} t=${hit.distance.toFixed(2)}m [raycast]`, 'ok'); } catch (_) {}
      }
      _spraySeen = true;
    }

    // ローカルで自分が発射するときに呼ぶ。サーバーへも送信。
    let sprayState = {
      active: false,
      emitInterval: null,
      lastEmitWall: 0,
    };
    function emitSprayPulse() {
      // 発射元 = カメラ位置、方向 = カメラ前方
      camera.getWorldPosition(_spraySource);
      camera.getWorldDirection(_sprayDir);
      const color = state.myColor || '#ffaa00';
      const halfAngle = SPRAY_HALF_ANGLE;
      const time = Date.now();

      // 発射側で raycast → 当たったオブジェクト名と UV を確定させ、データに同梱
      //   送信側でヒット確定させることで受信側はモデルの移動に影響されず同じ場所を着色できる
      _sprayRaycaster.set(_spraySource, _sprayDir);
      _sprayRaycaster.far = SPRAY_MAX_DIST;
      _sprayRaycaster.near = 0;
      const hits = _sprayRaycaster.intersectObjects(paintables, false);

      const data = {
        // 旧仕様フィールド (位置・方向) — 受信側 raycast フォールバック用
        x: _spraySource.x, y: _spraySource.y, z: _spraySource.z,
        dx: _sprayDir.x,   dy: _sprayDir.y,   dz: _sprayDir.z,
        color, halfAngle, time,
      };

      if (hits.length > 0) {
        const hit = hits[0];
        if (hit.uv && hit.distance > 0 && hit.distance <= SPRAY_MAX_DIST) {
          const worldR = hit.distance * Math.tan(halfAngle);
          const uvR = (hit.object === ground) ? worldR / FIELD_SIZE : 0.035;
          data.targetName = (hit.object === ground) ? 'ground' : (hit.object.name || '');
          data.hitU = hit.uv.x;
          data.hitV = hit.uv.y;
          data.uvRadius = Math.max(SPRAY_MIN_UVR, Math.min(SPRAY_MAX_UVR, uvR));
        }
      }

      processSprayEvent(data);
      if (socket && socket.connected) socket.emit('spray', data);
    }
    function startSpray() {
      if (sprayState.active) return;
      sprayState.active = true;
      sprayConeVis.visible = true;
      sprayHitDisk.material.color.set(state.myColor || '#ffaa00');
      emitSprayPulse(); // 押下直後に 1 発
      sprayState.emitInterval = setInterval(emitSprayPulse, Math.round(1000 / SPRAY_EMIT_HZ));
    }
    function stopSpray() {
      sprayState.active = false;
      sprayConeVis.visible = false;
      if (sprayState.emitInterval) {
        clearInterval(sprayState.emitInterval);
        sprayState.emitInterval = null;
      }
    }
    // フレーム毎に発射者本人にだけ「床ヒット位置リング」を表示
    function updateSprayConeVis() {
      if (!sprayState.active) return;
      camera.getWorldPosition(_spraySource);
      camera.getWorldDirection(_sprayDir);
      if (_sprayDir.y >= -0.001) { sprayHitDisk.visible = false; return; }
      const t = -_spraySource.y / _sprayDir.y;
      if (t <= 0 || t > SPRAY_MAX_DIST) { sprayHitDisk.visible = false; return; }
      _sprayHit.copy(_spraySource).addScaledVector(_sprayDir, t);
      if (Math.abs(_sprayHit.x) > FIELD_HALF || Math.abs(_sprayHit.z) > FIELD_HALF) {
        sprayHitDisk.visible = false; return;
      }
      const wR = t * Math.tan(SPRAY_HALF_ANGLE);
      sprayHitDisk.visible = true;
      sprayHitDisk.position.set(_sprayHit.x, 0.02, _sprayHit.z);
      const scale = Math.max(0.1, wR / 0.18);
      sprayHitDisk.scale.setScalar(scale);
    }

    // 1m グリッド - 暗い床に映えるよう明るめグレー
    const grid = new THREE.GridHelper(20, 20, 0x9a9aa0, 0x7a7a80);
    grid.position.set(0, 0.01, 0);
    scene.add(grid);

    // 5m 主格子 - もっと明るいグレーで強調
    const majorGrid = new THREE.GridHelper(20, 4, 0xb0b0b6, 0xb0b0b6);
    majorGrid.position.set(0, 0.015, 0);
    scene.add(majorGrid);

    // 20m 境界 - 明るいグレー (はっきり区別)
    const boundary = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(20, 0.02, 20)),
      new THREE.LineBasicMaterial({ color: 0xc0c0c6, linewidth: 2 })
    );
    boundary.position.set(0, 0.012, 0);
    scene.add(boundary);

    // スポーン体積 - 中間〜明るいグレー
    const spawnVolume = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(4, 1, 4)),
      new THREE.LineBasicMaterial({ color: 0x9a9aa0, transparent: true, opacity: 0.6 })
    );
    spawnVolume.position.set(0, 1.5, 0);
    scene.add(spawnVolume);

    // 中点マーカー (= AR マーカーの VR 上の位置) - 15cm × 7cm × 15cm
    //   ライトの影響を受けない MeshBasicMaterial で常に指定色
    const centerMarker = new THREE.Mesh(
      new THREE.BoxGeometry(0.15, 0.07, 0.15),
      new THREE.MeshBasicMaterial({ color: 0xc0c0c6 })
    );
    centerMarker.position.set(0, 1.035, 0); // 底面 y=1.0, 上面 y=1.07
    scene.add(centerMarker);

    // 壁エンクロージャー: 中心 (0,0,0) を 8m × 8m で四方に囲む
    //   各壁: 幅 8m × 高さ 5m × 厚さ 0.5m
    //   壁中心位置: 北 z=+4, 南 z=-4, 東 x=+4, 西 x=-4 (壁の内側面が ±4m)
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x55555f,
      roughness: 0.85,
      metalness: 0.05,
      side: THREE.DoubleSide,
    });
    const WALL_H = 5, WALL_T = 0.5, WALL_W = 8, ENC_R = 4;
    function makeWall(w, h, d, x, y, z) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
      m.position.set(x, y, z);
      scene.add(m);
      return m;
    }
    const wallN = makeWall(WALL_W, WALL_H, WALL_T, 0, WALL_H / 2, +ENC_R);
    const wallS = makeWall(WALL_W, WALL_H, WALL_T, 0, WALL_H / 2, -ENC_R);
    const wallE = makeWall(WALL_T, WALL_H, WALL_W, +ENC_R, WALL_H / 2, 0);
    const wallW2 = makeWall(WALL_T, WALL_H, WALL_W, -ENC_R, WALL_H / 2, 0);
    // 周回演出の邪魔になるため非表示 (mesh はシーンに残す)
    wallN.visible = false;
    wallS.visible = false;
    wallE.visible = false;
    wallW2.visible = false;

    // ============================================================
    // Whale (FBX) - 共通空間に浮かべてアニメーション
    //   ピボット方式: 親 Group を原点 (0, ORBIT_Y, 0) に置き、
    //                 鯨は親内で (ORBIT_R, 0, 0) に固定。
    //                 親の Y 軸回転だけで鯨全体が周回する。
    // ============================================================
    const ORBIT_R = 3.0;          // 半径 3m
    const ORBIT_Y_BASE = 2.0;     // 高さ基準 (m)
    const ORBIT_Y_AMP  = 0.5;     // 高さ振幅 (m)
    const ORBIT_Y_FREQ = 2.0;     // 高さ振動周波数 (rad/s)
    // 各周回オブジェクトの状態 (phase: factor-秒, t0: ms 絶対時刻, factor: 倍率)
    //   theta(now) = (phase + factor * (Date.now() - t0) / 1000) × BASE_OMEGA
    //   ─ 全クライアントが同じ Date.now() を共有 → 起動タイミングに依らず同じ位置を再現
    //   ─ 速度倍率変更時はサーバーが phase を凍結し全員へ再ブロードキャストするので、
    //     どのクライアントも同じ位置に「飛ばず」追従する。
    const WHALE_BASE_OMEGA = 1.0;                         // rad/s
    const FOX_BASE_OMEGA = (2 * Math.PI) / 180.0;         // rad/s (3分で1周)
    // 全クライアント共通の固定エポック (= サーバーと同じ Unix epoch 0)。
    let whaleOrbitState = { phase: 0, t0: 0, factor: 1.0 };
    let foxOrbitState   = { phase: 0, t0: 0, factor: 1.0 };
    let humanOrbitState = { phase: 0, t0: 0, factor: 1.0 };

    // サーバー時刻オフセット (ms): サーバー時刻 - ローカル時刻
    //   broadcast に同梱される serverNow から (serverNow - Date.now()) を記録し、
    //   以降は (Date.now() + _serverClockOffset) を「サーバー時刻」として全クライアントで揃える。
    //   これでデバイス間の OS 時計ずれ (NTP 非同期 / 数秒のクロックスキュー) を吸収する。
    let _serverClockOffset = 0;
    function syncedNow() { return Date.now() + _serverClockOffset; }

    // 後方互換用ショートカット (UI 表示専用)
    function whaleSpeedFactorValue() { return whaleOrbitState.factor; }
    function foxSpeedFactorValue()   { return foxOrbitState.factor; }
    function humanSpeedFactorValue() { return humanOrbitState.factor; }
    // 現在の累積 factor-秒 (サーバー時刻ベース)
    function whaleAccum() { return whaleOrbitState.phase + whaleOrbitState.factor * (syncedNow() - whaleOrbitState.t0) / 1000; }
    function foxAccum()   { return foxOrbitState.phase   + foxOrbitState.factor   * (syncedNow() - foxOrbitState.t0)   / 1000; }
    function humanAccum() { return humanOrbitState.phase + humanOrbitState.factor * (syncedNow() - humanOrbitState.t0) / 1000; }

    let whaleObj = null;
    let whaleMixer = null;
    const whaleClock = new THREE.Clock();
    // フィールド可視判定用の使い回し Vector3 (毎フレーム new しない)
    const _fieldVisVec = new THREE.Vector3();

    const whaleOrbitPivot = new THREE.Group();
    whaleOrbitPivot.name = 'whale_orbit_pivot';
    whaleOrbitPivot.position.set(0, ORBIT_Y_BASE, 0);
    scene.add(whaleOrbitPivot);

    function tryLoadWhale(retries) {
      if (typeof THREE.FBXLoader !== 'function') {
        if (retries > 0) {
          setTimeout(() => tryLoadWhale(retries - 1), 200);
        } else {
          log('FBXLoader unavailable', 'err');
        }
        return;
      }
      const loader = new THREE.FBXLoader();
      loader.load('/models/uploads_files_3076168_Whale.fbx',
        (obj) => {
          // 自動スケール: bounding sphere の半径を 3m に正規化
          const box = new THREE.Box3().setFromObject(obj);
          const size = new THREE.Vector3();
          box.getSize(size);
          const maxDim = Math.max(size.x, size.y, size.z);
          const targetSize = 4.0; // 鯨の最大寸法 4m に
          const scale = (maxDim > 0) ? (targetSize / maxDim) : 0.01;
          obj.scale.setScalar(scale);

          // ピボット内のローカル位置: 半径方向に ORBIT_R オフセット
          obj.position.set(ORBIT_R, 0, 0);

          // Whale はマテリアルそのままで白 OK
          obj.name = 'kujira_1';
          whaleOrbitPivot.add(obj);
          whaleObj = obj;
          // スプレーペイント対応 (各サブメッシュに paintRT + 合成シェーダ注入)
          paintifyModel(obj, { res: 512 });

          // 埋め込みアニメーションがあれば再生、なければ簡易自動遊泳
          if (obj.animations && obj.animations.length > 0) {
            whaleMixer = new THREE.AnimationMixer(obj);
            const action = whaleMixer.clipAction(obj.animations[0]);
            action.play();
            log('whale animations=' + obj.animations.length +
                ' clip="' + obj.animations[0].name + '"', 'ok');
          } else {
            log('whale: no embedded animation, using auto swim', 'ok');
          }
          log('whale loaded, scale=' + scale.toFixed(3) +
              ' maxDim=' + maxDim.toFixed(2) + 'm', 'ok');
        },
        (xhr) => {
          if (xhr && xhr.total) {
            const pct = Math.round((xhr.loaded / xhr.total) * 100);
            if (pct % 25 === 0) log('whale loading ' + pct + '%');
          }
        },
        (err) => {
          log('whale load error: ' + (err && err.message ? err.message : err), 'err');
        }
      );
    }
    // 三 → fflate → FBXLoader の順でロード完了を待つ
    tryLoadWhale(50);

    // ============================================================
    // Fox (FBX) - 共通空間の床上で楕円軌道を周回
    //   ヘ 仕様: 床面 (Y=0) 上で
    //     縦 (Z) 30m × 横 (X) 10m の楕円
    //     頂点 = (X=0, Z=5m)
    //     中心 = (X=0, Z=-10m)
    //     周期 = 3分 (180秒)
    // ============================================================
    const FOX_VERTEX_Z   = 5.0;
    const FOX_SEMI_Z     = 15.0;   // 縦 30m / 2
    const FOX_SEMI_X     = 5.0;    // 横 10m / 2
    const FOX_CENTER_Z   = FOX_VERTEX_Z - FOX_SEMI_Z; // = -10
    const FOX_PERIOD_SEC = 180.0;  // 3分 (FOX_BASE_OMEGA は冒頭で定義済み)

    let foxObj = null;
    let foxMixer = null;
    const foxClock = new THREE.Clock();

    // 周回ピボット (位置だけを毎フレーム更新、Fox は子として乗る)
    const foxOrbitGroup = new THREE.Group();
    foxOrbitGroup.name = 'fox_orbit_group';
    foxOrbitGroup.position.set(0, 0, FOX_VERTEX_Z); // 初期位置 = 頂点
    scene.add(foxOrbitGroup);

    function tryLoadFox(retries) {
      if (typeof THREE.FBXLoader !== 'function') {
        if (retries > 0) {
          setTimeout(() => tryLoadFox(retries - 1), 200);
        } else {
          log('FBXLoader unavailable for Fox', 'err');
        }
        return;
      }
      const loader = new THREE.FBXLoader();
      // URL の "+" は %2B にエンコードする必要あり
      loader.load('/models/uploads_files_3076168_Red%2BFox.fbx',
        (obj) => {
          // スケール正規化: 高さ (Y) を 1m に
          const box1 = new THREE.Box3().setFromObject(obj);
          const size = new THREE.Vector3();
          box1.getSize(size);
          const targetHeight = 1.0;
          const heightDim = size.y;
          const scale = (heightDim > 0) ? (targetHeight / heightDim) : 0.01;
          obj.scale.setScalar(scale);

          // 床に立たせる:
          //   X, Z は bounding box の中心を原点 (0, 0) に合わせる
          //   Y は bounding box の最下点が y = 0 (床面) に合うよう持ち上げる
          const box2 = new THREE.Box3().setFromObject(obj);
          const center = new THREE.Vector3();
          box2.getCenter(center);
          obj.position.set(-center.x, -box2.min.y, -center.z);

          // Fox はマテリアルそのままで白 OK
          obj.name = 'Fox_1';
          foxOrbitGroup.add(obj);
          foxObj = obj;
          // スプレーペイント対応
          paintifyModel(obj, { res: 512 });

          if (obj.animations && obj.animations.length > 0) {
            foxMixer = new THREE.AnimationMixer(obj);
            const action = foxMixer.clipAction(obj.animations[0]);
            action.play();
            log('Fox_1 animations=' + obj.animations.length +
                ' clip="' + obj.animations[0].name + '"', 'ok');
          } else {
            log('Fox_1: no embedded animation', 'ok');
          }
          log('Fox_1 loaded, scale=' + scale.toFixed(3) +
              ' height=' + heightDim.toFixed(2) +
              ' floorOffset=(' + (-center.x).toFixed(2) + ',' + (-box2.min.y).toFixed(2) +
              ',' + (-center.z).toFixed(2) + ')', 'ok');
        },
        (xhr) => {
          if (xhr && xhr.total) {
            const pct = Math.round((xhr.loaded / xhr.total) * 100);
            if (pct % 25 === 0) log('fox loading ' + pct + '%');
          }
        },
        (err) => {
          log('fox load error: ' + (err && err.message ? err.message : err), 'err');
        }
      );
    }
    tryLoadFox(50);

    // ============================================================
    // Human (FBX) - 原点に足元を合わせて配置、高さ 1.8m
    // ============================================================
    let humanObj = null;
    let humanMixer = null;
    let humanRootBone = null;     // ルートボーン (ルートモーション無効化用)
    let humanRootInitPos = null;  // 元の初期位置を保持
    const humanClock = new THREE.Clock();

    // 長方形外周パラメータ (回転矩形)
    //   長辺は (-10, 1) と (-3, -20) を通り、長さ 25m
    //   短辺 10m、両指定点を長辺中心に対し対称配置
    //   周期 2 分 = 120 秒、周長 70m
    const HUMAN_LONG_LEN  = 25;
    const HUMAN_SHORT_LEN = 10;
    // 長辺方向ベクトル u (単位)
    const HUMAN_U_DX = 7,  HUMAN_U_DZ = -21;
    const HUMAN_U_LEN = Math.sqrt(HUMAN_U_DX * HUMAN_U_DX + HUMAN_U_DZ * HUMAN_U_DZ); // √490
    const HUMAN_UX = HUMAN_U_DX / HUMAN_U_LEN; // ≈ 0.3162
    const HUMAN_UZ = HUMAN_U_DZ / HUMAN_U_LEN; // ≈ -0.9487
    // 短辺方向ベクトル v (u を 90° CCW 回転)
    const HUMAN_VX = -HUMAN_UZ; // ≈ 0.9487
    const HUMAN_VZ =  HUMAN_UX; // ≈ 0.3162
    // 長辺中心 = (-10,1) と (-3,-20) の中点
    const HUMAN_MID_X = -6.5;
    const HUMAN_MID_Z = -9.5;
    // 4 隅 (A→B が長辺1、B→B' が短辺、B'→A' が長辺2、A'→A が短辺)
    const HUMAN_HALF = HUMAN_LONG_LEN / 2; // 12.5
    const HUMAN_AX = HUMAN_MID_X - HUMAN_HALF * HUMAN_UX;
    const HUMAN_AZ = HUMAN_MID_Z - HUMAN_HALF * HUMAN_UZ;
    const HUMAN_BX = HUMAN_MID_X + HUMAN_HALF * HUMAN_UX;
    const HUMAN_BZ = HUMAN_MID_Z + HUMAN_HALF * HUMAN_UZ;
    const HUMAN_BPX = HUMAN_BX + HUMAN_SHORT_LEN * HUMAN_VX;
    const HUMAN_BPZ = HUMAN_BZ + HUMAN_SHORT_LEN * HUMAN_VZ;
    const HUMAN_APX = HUMAN_AX + HUMAN_SHORT_LEN * HUMAN_VX;
    const HUMAN_APZ = HUMAN_AZ + HUMAN_SHORT_LEN * HUMAN_VZ;
    const HUMAN_RECT_PERIM = 2 * (HUMAN_LONG_LEN + HUMAN_SHORT_LEN); // 70
    const HUMAN_PERIOD_SEC = 120;

    function humanRectPositionAt(s) {
      s = ((s % HUMAN_RECT_PERIM) + HUMAN_RECT_PERIM) % HUMAN_RECT_PERIM;
      const L = HUMAN_LONG_LEN, W = HUMAN_SHORT_LEN;
      if (s < L) {
        // A → B (長辺1)、方向 +u
        const f = s / L;
        return {
          x: HUMAN_AX + (HUMAN_BX - HUMAN_AX) * f,
          z: HUMAN_AZ + (HUMAN_BZ - HUMAN_AZ) * f,
          dx: HUMAN_UX, dz: HUMAN_UZ,
        };
      } else if (s < L + W) {
        // B → B' (短辺)、方向 +v
        const f = (s - L) / W;
        return {
          x: HUMAN_BX + (HUMAN_BPX - HUMAN_BX) * f,
          z: HUMAN_BZ + (HUMAN_BPZ - HUMAN_BZ) * f,
          dx: HUMAN_VX, dz: HUMAN_VZ,
        };
      } else if (s < 2 * L + W) {
        // B' → A' (長辺2)、方向 -u
        const f = (s - L - W) / L;
        return {
          x: HUMAN_BPX + (HUMAN_APX - HUMAN_BPX) * f,
          z: HUMAN_BPZ + (HUMAN_APZ - HUMAN_BPZ) * f,
          dx: -HUMAN_UX, dz: -HUMAN_UZ,
        };
      } else {
        // A' → A (短辺)、方向 -v
        const f = (s - 2 * L - W) / W;
        return {
          x: HUMAN_APX + (HUMAN_AX - HUMAN_APX) * f,
          z: HUMAN_APZ + (HUMAN_AZ - HUMAN_APZ) * f,
          dx: -HUMAN_VX, dz: -HUMAN_VZ,
        };
      }
    }

    // 周回ピボット
    const humanOrbitGroup = new THREE.Group();
    humanOrbitGroup.name = 'human_orbit_group';
    scene.add(humanOrbitGroup);

    function tryLoadHuman(retries) {
      if (typeof THREE.FBXLoader !== 'function') {
        if (retries > 0) {
          setTimeout(() => tryLoadHuman(retries - 1), 200);
        } else {
          log('FBXLoader unavailable for Human', 'err');
        }
        return;
      }
      const loader = new THREE.FBXLoader();
      loader.load('/models/Walking.fbx',
        (obj) => {
          // スケール正規化: 高さ (Y) を 1.8m に
          const box1 = new THREE.Box3().setFromObject(obj);
          const size = new THREE.Vector3();
          box1.getSize(size);
          const targetHeight = 1.8;
          const heightDim = size.y;
          const scale = (heightDim > 0) ? (targetHeight / heightDim) : 0.01;
          obj.scale.setScalar(scale);

          // 床に立たせる:
          //   X, Z は bounding box の中心を原点 (0, 0) に合わせる
          //   Y は bounding box の最下点が y = 0 (床面) に合うよう持ち上げる
          const box2 = new THREE.Box3().setFromObject(obj);
          const center = new THREE.Vector3();
          box2.getCenter(center);
          obj.position.set(-center.x, -box2.min.y, -center.z);

          // マテリアル差し替え: テクスチャ無効化 + 白で再構築
          //   ライティングの濃淡で白黒 (グレースケール) 表現になる
          obj.traverse((c) => {
            if (c.isMesh && c.material) {
              const newMat = new THREE.MeshStandardMaterial({
                color: 0xffffff,
                roughness: 1.0,
                metalness: 0.0,
              });
              // SkinnedMesh の場合は skeleton/skin 情報は自動継承
              c.material = newMat;
            }
          });

          obj.name = 'human_1';
          // scene 直接ではなく、周回ピボットの子にする
          humanOrbitGroup.add(obj);
          humanObj = obj;
          // スプレーペイント対応 (白マテリアル MeshStandardMaterial に注入)
          paintifyModel(obj, { res: 512 });

          // ルートボーン抽出 (SkinnedMesh.skeleton.bones[0] が通常 Hips)
          obj.traverse((child) => {
            if (child.isSkinnedMesh && child.skeleton &&
                child.skeleton.bones.length > 0 && !humanRootBone) {
              humanRootBone = child.skeleton.bones[0];
              // 元の初期位置を保持 (X,Z=0 にロック、Y は元の値を維持)
              humanRootInitPos = humanRootBone.position.clone();
              log('rootBone="' + humanRootBone.name +
                  '" initPos=(' + humanRootInitPos.x.toFixed(3) + ',' +
                  humanRootInitPos.y.toFixed(3) + ',' +
                  humanRootInitPos.z.toFixed(3) + ')', 'ok');
            }
          });

          if (obj.animations && obj.animations.length > 0) {
            humanMixer = new THREE.AnimationMixer(obj);
            const action = humanMixer.clipAction(obj.animations[0]);
            action.play();
            log('human_1 animations=' + obj.animations.length +
                ' clip="' + obj.animations[0].name + '"', 'ok');
          } else {
            log('human_1: no embedded animation', 'ok');
          }
          log('human_1 loaded, scale=' + scale.toFixed(3) +
              ' height=' + heightDim.toFixed(2) +
              ' floorOffset=(' + (-center.x).toFixed(2) + ',' + (-box2.min.y).toFixed(2) +
              ',' + (-center.z).toFixed(2) + ')', 'ok');
        },
        (xhr) => {
          if (xhr && xhr.total) {
            const pct = Math.round((xhr.loaded / xhr.total) * 100);
            if (pct % 25 === 0) log('human loading ' + pct + '%');
          }
        },
        (err) => {
          log('human load error: ' + (err && err.message ? err.message : err), 'err');
        }
      );
    }
    tryLoadHuman(50);

    // ============================================================
    // 壁を這う球体 (直径 30cm、全クライアントで共有)
    //   座標は (s, y) で、s は壁を北→東→南→西と一周する周回距離 (m)
    //   インセット R = ENC_R - 壁厚/2 - 球半径 で壁の内面に貼り付く
    // ============================================================
    const ORB_RADIUS = 0.15; // 30cm 直径
    const ORB_INSET = ENC_R - WALL_T / 2 - ORB_RADIUS; // = 3.60m
    const ORB_SIDE = 2 * ORB_INSET; // 1辺 = 7.2m
    const ORB_PERIM = 4 * ORB_SIDE; // 周長 = 28.8m
    const orbState = { s: 0, y: 2.5 }; // 初期値: 北壁の西端 / 高さ2.5m

    function orbSToXZ(s) {
      // s を周長でラップ
      s = ((s % ORB_PERIM) + ORB_PERIM) % ORB_PERIM;
      const R = ORB_INSET;
      if (s < ORB_SIDE) {
        // 北壁: x が -R → +R、z = +R
        return { x: -R + s, z: +R };
      } else if (s < 2 * ORB_SIDE) {
        // 東壁: z が +R → -R、x = +R
        return { x: +R, z: +R - (s - ORB_SIDE) };
      } else if (s < 3 * ORB_SIDE) {
        // 南壁: x が +R → -R、z = -R
        return { x: +R - (s - 2 * ORB_SIDE), z: -R };
      } else {
        // 西壁: z が -R → +R、x = -R
        return { x: -R, z: -R + (s - 3 * ORB_SIDE) };
      }
    }

    const orb = new THREE.Mesh(
      new THREE.SphereGeometry(ORB_RADIUS, 32, 24),
      new THREE.MeshStandardMaterial({
        color: 0xfb923c,
        emissive: 0xea580c,
        emissiveIntensity: 0.6,
        roughness: 0.4,
        metalness: 0.2,
      })
    );
    function applyOrbState() {
      const xz = orbSToXZ(orbState.s);
      orb.position.set(xz.x, orbState.y, xz.z);
    }
    applyOrbState();
    scene.add(orb);

    // 現在の s 位置における周回方向の接線 (ワールド座標、単位ベクトル)
    function orbTangent(s) {
      s = ((s % ORB_PERIM) + ORB_PERIM) % ORB_PERIM;
      if (s < ORB_SIDE)        return new THREE.Vector3( 1, 0,  0); // 北: +X
      if (s < 2 * ORB_SIDE)    return new THREE.Vector3( 0, 0, -1); // 東: -Z
      if (s < 3 * ORB_SIDE)    return new THREE.Vector3(-1, 0,  0); // 南: -X
      return                          new THREE.Vector3( 0, 0,  1); // 西: +Z
    }
    // ドラッグ開始時に「画面右 = +s か -s か」を決定する
    function getOrbDragSignFactor() {
      const tangent = orbTangent(orbState.s);
      const cameraRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      return Math.sign(cameraRight.dot(tangent)) || 1;
    }

    // 30Hz スロットルで orb 位置をサーバーへ送信 (camera/observer 共用)
    let lastOrbSendAt = 0;
    function sendOrbThrottled() {
      const now = performance.now();
      if (now - lastOrbSendAt < 33) return;
      lastOrbSendAt = now;
      if (socket && socket.connected) {
        socket.emit('orb', { s: orbState.s, y: orbState.y });
      }
    }

    // ============================================================
    // アバター生成
    // ============================================================
    // アバターは "15cm 単色球" のみ。
    // 向きはクォータニオンとしてサーバー経由で同期しているが、視覚化はしない。
    // 「マジックウィンドウ」はデバイス画面そのもの (DeviceOrientation → カメラ姿勢)
    // が担っており、アバターに窓状パーツを付ける必要はない。
    const AVATAR_RADIUS = 0.075;     // 直径15cm
    const OBSERVER_CUBE = 0.15;      // 15cm 立方体

    // role: 'camera' (スマホ=15cm球) | 'observer' (PC=15cm透明立方体)
    function makeAvatar(colorStr, role) {
      const grp = new THREE.Group();
      const col = new THREE.Color(colorStr);

      if (role === 'observer') {
        // 360度マジックウィンドウ: 完全に無色透明 (色味/emissive 一切なし)
        const cube = new THREE.Mesh(
          new THREE.BoxGeometry(OBSERVER_CUBE, OBSERVER_CUBE, OBSERVER_CUBE),
          new THREE.MeshStandardMaterial({
            color: 0xffffff,    // 白固定 = 無色
            opacity: 0.08,      // 強めの透明
            transparent: true,
            side: THREE.FrontSide,
            depthWrite: false,
            roughness: 0.5,
            metalness: 0.0,
            // emissive を一切設定しない (発光なし)
          })
        );
        grp.add(cube);
        // 輪郭線も無色 (白) で極薄。完全に消したい場合はこの 1 ブロックを削除可
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.BoxGeometry(OBSERVER_CUBE, OBSERVER_CUBE, OBSERVER_CUBE)),
          new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18 })
        );
        grp.add(edges);
      } else {
        // camera role: 既存の球体
        const sphere = new THREE.Mesh(
          new THREE.SphereGeometry(AVATAR_RADIUS, 24, 16),
          new THREE.MeshStandardMaterial({
            color: col,
            opacity: 0.85,
            transparent: true,
            side: THREE.FrontSide,
            emissive: col,
            emissiveIntensity: 0.22,
          })
        );
        grp.add(sphere);
      }

      grp.scale.set(0.001, 0.001, 0.001); // ポップ前
      grp.__spawnedAt = performance.now();
      return grp;
    }

    // ========================================================
    // オフアクシス投影行列の計算
    //   eye:           共通視点 (THREE.Vector3)
    //   displayCenter: ディスプレイ中心位置 (THREE.Vector3)
    //   displayQuat:   ディスプレイの向き (THREE.Quaternion)
    //                  ローカル: 右=+X, 上=+Y, 法線(視聴者側)=+Z
    //   w, h:          物理サイズ (m)
    //   near, far:     near/far クリップ面
    // ========================================================
    const _ax = new THREE.Vector3(), _ay = new THREE.Vector3(), _az = new THREE.Vector3();
    const _va = new THREE.Vector3(), _vb = new THREE.Vector3(), _vc = new THREE.Vector3();
    const _camLookMat = new THREE.Matrix4();
    // tick() の off-axis ブロックで毎フレーム使う退避用バッファ (毎フレーム new しない)
    const _oaSavePos = new THREE.Vector3();
    const _oaSaveQuat = new THREE.Quaternion();
    const _oaDispCenter = new THREE.Vector3();
    const _oaDispQuat = new THREE.Quaternion();
    const _oaOffsetQuat = new THREE.Quaternion();
    const _oaEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    const _oaEye = new THREE.Vector3();
    const _oaTmp = new THREE.Vector3();
    // スマホ用: アバターから window までの距離 (= 視線方向 20cm 先)
    const CAM_WINDOW_DIST = 0.20;
    // 180° around Y: avatar の local +Z (背中) を local -Z (前方) に転回するためのプリセット
    const _oaFlipQ = new THREE.Quaternion(0, 1, 0, 0); // axis=Y, angle=π
    function applyOffAxisProjection(cam, eye, displayCenter, displayQuat, w, h, near, far) {
      _ax.set(1, 0, 0).applyQuaternion(displayQuat); // right
      _ay.set(0, 1, 0).applyQuaternion(displayQuat); // up
      _az.set(0, 0, 1).applyQuaternion(displayQuat); // normal (viewer side)

      // 4隅 (BL, BR, TL) を eye 基準で計算
      const hw = w * 0.5, hh = h * 0.5;
      // BL = D - hw*right - hh*up
      _va.copy(displayCenter)
         .addScaledVector(_ax, -hw).addScaledVector(_ay, -hh).sub(eye);
      // BR = D + hw*right - hh*up
      _vb.copy(displayCenter)
         .addScaledVector(_ax, +hw).addScaledVector(_ay, -hh).sub(eye);
      // TL = D - hw*right + hh*up
      _vc.copy(displayCenter)
         .addScaledVector(_ax, -hw).addScaledVector(_ay, +hh).sub(eye);

      // eye → display 面までの距離 (-面法線方向への射影)
      const d = -_va.dot(_az);
      if (d <= 0.001) return false; // eye が画面の裏 or 同一面上

      const k = near / d;
      const l = _va.dot(_ax) * k;
      const r = _vb.dot(_ax) * k;
      const b = _va.dot(_ay) * k;
      const t = _vc.dot(_ay) * k;

      cam.projectionMatrix.makePerspective(l, r, t, b, near, far);
      if (cam.projectionMatrixInverse) {
        cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
      }

      // カメラ位置 = eye、向き = ディスプレイ法線の逆 (画面に正対)
      cam.position.copy(eye);
      _camLookMat.lookAt(eye, _va.copy(eye).sub(_az), _ay);
      cam.quaternion.setFromRotationMatrix(_camLookMat);
      cam.matrixWorldNeedsUpdate = true;
      return true;
    }

    // ディスプレイ表示フレーム (シアン) - 物理サイズで画面の矩形を描画
    //   Master ロールで各アバターの実画面位置を可視化
    function makeDisplayFrame(parent, width, height) {
      const lines = new THREE.LineSegments(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({
          color: 0x06b6d4, transparent: true, opacity: 0.9, fog: false,
        })
      );
      lines.frustumCulled = false;
      lines.userData.__w = -1;
      lines.userData.__h = -1;
      lines.visible = false;
      parent.add(lines);
      updateDisplayFrame(lines, width, height);
      return lines;
    }
    function updateDisplayFrame(frame, width, height) {
      if (!frame) return;
      if (!isFinite(width) || !isFinite(height) || width <= 0 || height <= 0) return;
      if (Math.abs(frame.userData.__w - width) < 1e-4 &&
          Math.abs(frame.userData.__h - height) < 1e-4) return;
      frame.userData.__w = width;
      frame.userData.__h = height;
      const w = width / 2, h = height / 2;
      const pts = [
        new THREE.Vector3(-w, +h, 0), new THREE.Vector3(+w, +h, 0),
        new THREE.Vector3(+w, +h, 0), new THREE.Vector3(+w, -h, 0),
        new THREE.Vector3(+w, -h, 0), new THREE.Vector3(-w, -h, 0),
        new THREE.Vector3(-w, -h, 0), new THREE.Vector3(-w, +h, 0),
        new THREE.Vector3(-w * 0.3, 0, 0), new THREE.Vector3(+w * 0.3, 0, 0),
        new THREE.Vector3(0, -h * 0.3, 0), new THREE.Vector3(0, +h * 0.3, 0),
      ];
      if (frame.geometry) frame.geometry.dispose();
      frame.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    }

    // ============================================================
    // 視錐台 (View Frustum) - MASTER のみ表示
    //   viewerEye から画面 4 隅を通って far plane へ伸びる線分集合
    //   = 「その画面が共通空間のどの領域を映しているか」を可視化
    // ============================================================
    const FAR_DIST = 8; // 視錐台の到達距離 (m)
    function makeViewFrustumLines() {
      const geom = new THREE.BufferGeometry();
      // 8本の線分 = 16頂点
      const positions = new Float32Array(16 * 3);
      geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.LineBasicMaterial({
        color: 0x06b6d4, transparent: true, opacity: 0.35, fog: false,
        depthWrite: false,
      });
      const lines = new THREE.LineSegments(geom, mat);
      lines.frustumCulled = false;
      return lines;
    }
    const _eyeVec = new THREE.Vector3();
    const _cornerTL = new THREE.Vector3(), _cornerTR = new THREE.Vector3();
    const _cornerBR = new THREE.Vector3(), _cornerBL = new THREE.Vector3();
    const _farTL = new THREE.Vector3(), _farTR = new THREE.Vector3();
    const _farBR = new THREE.Vector3(), _farBL = new THREE.Vector3();
    const _dirTmp = new THREE.Vector3();
    function projectFar(corner, eye, out) {
      _dirTmp.copy(corner).sub(eye);
      const d = _dirTmp.length();
      if (d < 1e-4) { out.copy(corner); return; }
      _dirTmp.multiplyScalar(FAR_DIST / d);
      out.copy(eye).add(_dirTmp);
    }
    function updateMasterViewFrustums() {
      _eyeVec.set(viewerEye.x, viewerEye.y, viewerEye.z);
      avatars.forEach((a, id) => {
        if (!a.viewFrustum) {
          a.viewFrustum = makeViewFrustumLines();
          scene.add(a.viewFrustum);
        }
        a.viewFrustum.visible = true;
        const disp = remoteDisplays.get(id) || {};
        const w = (disp.width  > 0 ? disp.width  : 0.5) * 0.5;
        const h = (disp.height > 0 ? disp.height : 0.3) * 0.5;
        // ローカル 4 隅
        _cornerTL.set(-w, +h, 0).applyQuaternion(a.grp.quaternion).add(a.grp.position);
        _cornerTR.set(+w, +h, 0).applyQuaternion(a.grp.quaternion).add(a.grp.position);
        _cornerBR.set(+w, -h, 0).applyQuaternion(a.grp.quaternion).add(a.grp.position);
        _cornerBL.set(-w, -h, 0).applyQuaternion(a.grp.quaternion).add(a.grp.position);
        // far 平面に投影
        projectFar(_cornerTL, _eyeVec, _farTL);
        projectFar(_cornerTR, _eyeVec, _farTR);
        projectFar(_cornerBR, _eyeVec, _farBR);
        projectFar(_cornerBL, _eyeVec, _farBL);
        // 線分頂点更新
        const pos = a.viewFrustum.geometry.attributes.position.array;
        let i = 0;
        function push(p) { pos[i++] = p.x; pos[i++] = p.y; pos[i++] = p.z; }
        // 4 本: eye → far の 4 隅
        push(_eyeVec); push(_farTL);
        push(_eyeVec); push(_farTR);
        push(_eyeVec); push(_farBR);
        push(_eyeVec); push(_farBL);
        // 4 本: far 平面の矩形
        push(_farTL); push(_farTR);
        push(_farTR); push(_farBR);
        push(_farBR); push(_farBL);
        push(_farBL); push(_farTL);
        a.viewFrustum.geometry.attributes.position.needsUpdate = true;
        a.viewFrustum.geometry.computeBoundingSphere();
      });
    }

    function easeOutBack(t) {
      const c1 = 1.70158, c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    }

    // ============================================================
    // 懐中電灯 (SpotLight + ボリュメトリック cone)
    //   parent: アバター Group か Camera。-Z 方向に光を放つ。
    // ============================================================
    const BEAM_LENGTH = 5;
    const BEAM_HALF_ANGLE = Math.PI / 14; // ~12.9° (2回り小さく)
    function makeFlashlight(parent, colorStr) {
      const color = new THREE.Color(colorStr || '#fffacd');

      // SpotLight 本体 (実際に壁や床を照らす)
      const light = new THREE.SpotLight(
        color,
        12,                  // intensity
        BEAM_LENGTH * 1.4,   // distance
        BEAM_HALF_ANGLE,     // angle (半角)
        0.35,                // penumbra (縁のぼけ)
        1.3                  // decay
      );
      light.position.set(0, 0, 0);

      // 向き: parent 座標系での -Z (アバター/カメラの前方)
      const target = new THREE.Object3D();
      target.position.set(0, 0, -1);
      parent.add(target);
      light.target = target;
      parent.add(light);

      // ボリュメトリック cone mesh (空気中の光の筋)
      const radius = BEAM_LENGTH * Math.tan(BEAM_HALF_ANGLE);
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(radius, BEAM_LENGTH, 32, 1, true /* open base */),
        new THREE.MeshBasicMaterial({
          color: color,
          transparent: true,
          opacity: 0.09,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
          fog: false, // 加算合成のためfog影響を消す
        })
      );
      // cone デフォルトは tip +Y, base -Y。
      //   rotation.x = +π/2 で tip→+Z、base→-Z。
      //   position.z = -BEAM_LENGTH/2 で tip を原点に持っていく → base が -Z (前方) に延びる
      cone.rotation.x = Math.PI / 2;
      cone.position.z = -BEAM_LENGTH / 2;
      parent.add(cone);

      return { light, target, cone };
    }

    // ============================================================
    // 自分の懐中電灯 (camera にアタッチ)
    //   camera 自体は scene に add 済みなので、子の light/target/cone も自動更新される
    //   参照を保持しトグル可能にする
    // ============================================================
    const myFlashlight = makeFlashlight(camera, '#fffacd');
    function setMyFlashlight(on) {
      myFlashlight.light.visible = on;
      myFlashlight.cone.visible = on;
    }
    // 初期は OFF (ユーザー要求: ライトは標準で全てオフ)
    setMyFlashlight(false);

    // ============================================================
    // アバター管理
    // ============================================================
    const avatars = new Map(); // id -> { grp, color, targetPos, targetQuat }

    // 自分が observer のときに他の observer を非表示にする判定
    //   - master からも全 observer は見えてほしいので master は除外
    //   - camera 同士は通常通り表示
    function isHiddenAvatar(otherRole) {
      return ROLE === 'observer' && otherRole === 'observer';
    }

    function spawnRemoteAvatar(id, u) {
      if (avatars.has(id)) return;
      const grp = makeAvatar(u.color, u.role || 'camera');
      grp.position.set(u.x || 0, u.y || 2, u.z || 0);
      grp.quaternion.set(u.qx || 0, u.qy || 0, u.qz || 0, u.qw || 1);
      const flashlight = makeFlashlight(grp, u.color);
      const initialOn = (u.lightOn === true);  // 既定 OFF、明示的に true のときだけ ON
      flashlight.light.visible = initialOn;
      flashlight.cone.visible = initialOn;
      // observer 同士はお互いに非表示 (アバター + ライトコーン + フレーム)
      if (isHiddenAvatar(u.role)) {
        grp.visible = false;
        flashlight.light.visible = false;
        flashlight.cone.visible = false;
      }
      // 実画面サイズで表示フレーム生成
      const fw = (u.display && u.display.width)  || 0.5;
      const fh = (u.display && u.display.height) || 0.3;
      const frustum = makeDisplayFrame(grp, fw, fh);
      if (ROLE === 'master') frustum.visible = true;
      if (u.display) remoteDisplays.set(id, u.display);
      grp.userData.__avatarId = id; // Master クリック判定用
      scene.add(grp);
      avatars.set(id, {
        grp,
        flashlight,
        frustum,
        role: u.role || 'camera',
        color: u.color,
        targetPos: new THREE.Vector3(u.x || 0, u.y || 2, u.z || 0),
        targetQuat: new THREE.Quaternion(u.qx || 0, u.qy || 0, u.qz || 0, u.qw || 1),
      });
      if (ROLE === 'master') updateMasterClientList();
      log('avatar spawn ' + (u.role || 'camera') + ' ' + id.slice(0, 6));
    }

    function despawnRemoteAvatar(id) {
      const a = avatars.get(id);
      if (!a) return;
      if (a.viewFrustum) {
        scene.remove(a.viewFrustum);
        if (a.viewFrustum.geometry) a.viewFrustum.geometry.dispose();
        a.viewFrustum = null;
      }
      scene.remove(a.grp);
      avatars.delete(id);
      if (ROLE === 'master') updateMasterClientList();
    }

    function updateCount() {
      document.getElementById('count').textContent = avatars.size + (state.entered ? 1 : 0);
    }

    // ============================================================
    // 状態
    // ============================================================
    const state = {
      myId: null,
      myColor: null,
      mySpawn: null,
      selfGroup: null,
      cameraQuat: new THREE.Quaternion(),
      lastSendTime: 0,
      entered: false, // pose 送信を開始する条件 (camera は入室ボタン、observer は setupObserver で true)
    };

    // ============================================================
    // マルチディスプレイ (オフアクシス投影) 用 状態
    //   myDisplay: 自分のディスプレイ設定
    //   viewerEye: 全クライアント共通の固定視点
    //   remoteDisplays: 他クライアントのディスプレイ設定 (master 用に表示)
    // ============================================================
    const myDisplay = {
      width: 0.5,    // m (推定値で上書き)
      height: 0.3,   // m
      yaw: 0, pitch: 0, roll: 0, // 度
      offaxis: false,
    };
    const viewerEye = { x: 0, y: 2.0, z: 0 };
    const remoteDisplays = new Map(); // id -> display config

    // 画面の物理サイズを推定 (PPI ベース)
    // - スマホ/タブレット: 高 DPI 想定 (300 PPI)
    // - ノート/モニタ: 100 PPI 想定
    function estimateDisplayPhysicalSize() {
      const dpr = window.devicePixelRatio || 1;
      const wPx = window.innerWidth * dpr;
      const hPx = window.innerHeight * dpr;
      // ヒューリスティック: pixel 総量が大きければ PC、小さければモバイル
      const totalPx = wPx * hPx;
      const ppi = (totalPx > 1500 * 800) ? 100 : 300;
      const inch2m = 0.0254;
      myDisplay.width = (window.innerWidth * dpr / ppi) * inch2m;
      myDisplay.height = (window.innerHeight * dpr / ppi) * inch2m;
    }
    estimateDisplayPhysicalSize();
    window.addEventListener('resize', () => {
      estimateDisplayPhysicalSize();
      if (socket && socket.connected) {
        socket.emit('displaySize', { width: myDisplay.width, height: myDisplay.height });
      }
    });

    // UI 表示・非表示トグル
    const uiToggleBtn = document.getElementById('ui-toggle');
    if (uiToggleBtn) {
      uiToggleBtn.addEventListener('click', () => {
        document.body.classList.toggle('ui-hidden');
        uiToggleBtn.textContent = document.body.classList.contains('ui-hidden') ? '◉' : 'UI';
        // tabbar 表示/非表示に合わせて canvas サイズも再計算
        resizeRenderer();
      });
      uiToggleBtn.addEventListener('touchstart', (e) => { e.stopPropagation(); });
    }

    // スマホ (camera ロール) 用 Off-Axis トグル
    //   - eye   = アバター位置 (= camera.position)
    //   - window = 視線方向 20cm 先、サイズ = myDisplay.width/height (自動推定 or サーバー保持値)
    //   ボタン押下時に myDisplay.offaxis をトグルし、サーバーへも notify (master の controlPose で潰されないため)
    const camOaBtn = document.getElementById('cam-offaxis-toggle');
    function syncCamOaBtn() {
      if (!camOaBtn) return;
      const on = !!myDisplay.offaxis;
      camOaBtn.textContent = 'Off-Axis ' + (on ? 'ON' : 'OFF');
      camOaBtn.classList.toggle('is-on', on);
    }
    if (camOaBtn) {
      syncCamOaBtn();
      camOaBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        myDisplay.offaxis = !myDisplay.offaxis;
        if (socket && socket.connected) {
          socket.emit('displayConfig', { offaxis: myDisplay.offaxis });
        }
        log('camera offaxis → ' + (myDisplay.offaxis ? 'ON' : 'OFF'), 'ok');
        syncCamOaBtn();
      });
      camOaBtn.addEventListener('touchstart', (e) => { e.stopPropagation(); });
      // サーバーからの displayConfig 反映時にも追従させる
      state.__syncCamOaBtn = syncCamOaBtn;
    }

    // スプレーボタン (画面上部中央の丸ボタン、UI 非表示時のみ可視)
    //   - 押下中: 円錐スプレーを連続発射 (床にペイント蓄積、全クライアントへ同期)
    //   - 離す: スプレー停止 (着色結果は保持)
    //   ※ UI 復帰は別途 右下の "◉" / "UI" トグルボタンで行う。
    const longPressBtn = document.getElementById('ui-long-press-btn');
    if (longPressBtn) {
      function pressStart(e) {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        longPressBtn.classList.add('pressing');
        startSpray();
        if (navigator.vibrate) navigator.vibrate(15); // 触覚フィードバック (短)
      }
      function pressCancel() {
        if (sprayState.active) stopSpray();
        longPressBtn.classList.remove('pressing');
      }
      longPressBtn.addEventListener('touchstart', pressStart, { passive: false });
      longPressBtn.addEventListener('touchend', pressCancel);
      longPressBtn.addEventListener('touchcancel', pressCancel);
      longPressBtn.addEventListener('mousedown', pressStart);
      longPressBtn.addEventListener('mouseup', pressCancel);
      longPressBtn.addEventListener('mouseleave', pressCancel);
    }

    // ============================================================
    // 歩行追跡 (DeviceMotion 加速度二重積分 + ダンピング)
    //   AR マーカー検出で anchor を設定、その後の移動を積分で推定
    //   短時間・短距離向け。長時間ではドリフトする
    // ============================================================
    const walking = {
      enabled: false,
      anchor: new THREE.Vector3(),  // キャリブレーション時のVR位置
      delta: new THREE.Vector3(),    // anchor からの累積変位
      vel: new THREE.Vector3(),      // 速度
      lastT: 0,
      stillCounter: 0,               // 静止検出カウンタ
    };
    function startWalking(vrPos) {
      walking.enabled = true;
      walking.anchor.copy(vrPos);
      walking.delta.set(0, 0, 0);
      walking.vel.set(0, 0, 0);
      walking.lastT = performance.now();
      walking.stillCounter = 0;
      log('walk tracking: STARTED at (' +
        vrPos.x.toFixed(2) + ',' + vrPos.y.toFixed(2) + ',' + vrPos.z.toFixed(2) + ')', 'ok');
    }
    function stopWalking() {
      walking.enabled = false;
    }
    // デバイスのワールド姿勢 (q1 オフセットなし) - 加速度の世界座標系変換に使用
    const deviceWorldQuat = new THREE.Quaternion();

    window.addEventListener('devicemotion', (e) => {
      if (!walking.enabled) return;
      const a = e.acceleration; // 重力除去済み (両OS対応)
      if (!a || (a.x == null && a.y == null && a.z == null)) return;

      const now = performance.now();
      const dt = Math.min(0.08, (now - walking.lastT) / 1000);
      walking.lastT = now;
      if (dt <= 0) return;

      let ax = a.x || 0, ay = a.y || 0, az = a.z || 0;

      // ノイズ閾値 (デッドゾーン) — 静止時の小さな揺らぎを抑制
      const NOISE = 0.20; // m/s²
      const mag2 = ax * ax + ay * ay + az * az;
      if (mag2 < NOISE * NOISE) {
        // 静止と判定
        walking.stillCounter++;
        if (walking.stillCounter > 6) {
          // ZUPT: 一定時間静止が続いたら速度をゼロにリセット (ドリフト対策)
          walking.vel.multiplyScalar(0);
        }
        return;
      }
      walking.stillCounter = 0;

      // 端末フレーム → 世界フレーム
      const accel = new THREE.Vector3(ax, ay, az).applyQuaternion(deviceWorldQuat);

      // 速度積分 + 強いダンピング (ドリフト抑制)
      walking.vel.addScaledVector(accel, dt);
      walking.vel.multiplyScalar(0.86);

      // 位置積分
      walking.delta.addScaledVector(walking.vel, dt);

      // 20m 四方クランプ (床範囲を超えないよう)
      walking.delta.x = Math.max(-9, Math.min(9, walking.delta.x));
      walking.delta.z = Math.max(-9, Math.min(9, walking.delta.z));
      walking.delta.y = Math.max(-1, Math.min(3, walking.delta.y));
    });

    // ============================================================
    // ロール別: 入室 + コントロール
    // ============================================================
    // role 用 body class (CSS で UI 出し分け)
    document.body.classList.toggle('is-camera',   ROLE === 'camera');
    document.body.classList.toggle('is-observer', ROLE === 'observer');
    document.body.classList.toggle('is-master',   ROLE === 'master');

    if (ROLE === 'observer') {
      document.getElementById('enter-overlay').style.display = 'none';
      document.getElementById('observer-panel').style.display = 'block';
      setupObserver();
    } else if (ROLE === 'master') {
      document.getElementById('enter-overlay').style.display = 'none';
      document.getElementById('observer-panel').style.display = 'block';
      document.getElementById('master-panel').style.display = 'block';
      setupObserver();
      setupMaster();
    } else {
      setupCameraEntry();
    }

    // ============================================================
    // OBSERVER (PC): 自前のOrbitControls + WASD
    // ============================================================
    function setupObserver() {
      // observer もアバター付き = 入室済み扱い
      state.entered = true;

      // 初期視点: 目線の高さ、机から少し離れた位置で原点方向を向く
      camera.position.set(0, 1.7, 4);
      // FPS スタイルの yaw/pitch
      let yaw = Math.PI;  // -Z 方向(原点側)を向く
      let pitch = -0.15;  // 少しだけ下向き
      const _eulerObs = new THREE.Euler(0, 0, 0, 'YXZ');
      function applyYawPitch() {
        _eulerObs.set(pitch, yaw, 0, 'YXZ');
        camera.quaternion.setFromEuler(_eulerObs);
      }
      applyYawPitch();

      const dom = renderer.domElement;
      dom.style.cursor = 'grab';

      // ドラッグ状態管理
      let dragMode = null; // 'look' | 'orb' | null
      let lastX = 0, lastY = 0;
      let orbDragState = null;

      // 球体クリック判定用のレイキャスタ
      const raycaster = new THREE.Raycaster();
      const mouseNDC = new THREE.Vector2();
      function hitTestOrb(clientX, clientY) {
        const rect = dom.getBoundingClientRect();
        mouseNDC.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        mouseNDC.y = -((clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouseNDC, camera);
        const hits = raycaster.intersectObject(orb);
        return hits.length > 0;
      }
      // Master 専用: アバター本体のヒット判定 → id を返す
      function hitTestAvatar(clientX, clientY) {
        if (ROLE !== 'master' || avatars.size === 0) return null;
        const rect = dom.getBoundingClientRect();
        mouseNDC.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        mouseNDC.y = -((clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouseNDC, camera);
        const targets = [];
        avatars.forEach((a) => a.grp.traverse((o) => { if (o.isMesh) targets.push(o); }));
        const hits = raycaster.intersectObjects(targets, false);
        if (hits.length === 0) return null;
        let obj = hits[0].object;
        while (obj && !obj.userData.__avatarId) obj = obj.parent;
        return obj ? obj.userData.__avatarId : null;
      }
      // 地面平面に対するレイ交差で、ドラッグ時の XZ ターゲット位置を求める
      const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      const dragPoint = new THREE.Vector3();
      function planeIntersectXZ(clientX, clientY, planeY) {
        const rect = dom.getBoundingClientRect();
        mouseNDC.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        mouseNDC.y = -((clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouseNDC, camera);
        dragPlane.constant = -planeY;
        const ok = raycaster.ray.intersectPlane(dragPlane, dragPoint);
        return ok ? dragPoint : null;
      }
      // Master 用 avatar ドラッグ状態
      let avatarDragState = null;

      dom.addEventListener('mousedown', (e) => {
        e.preventDefault();
        lastX = e.clientX;
        lastY = e.clientY;
        if (e.button === 0) {
          // Master: アバターをクリックしたら drag (orb より優先)
          if (ROLE === 'master') {
            const aid = hitTestAvatar(e.clientX, e.clientY);
            if (aid) {
              const a = avatars.get(aid);
              if (a) {
                // 選択も同期
                selectedClientId = aid;
                const selEl = document.getElementById('m-client-select');
                if (selEl) selEl.value = aid;
                avatars.forEach((av, id2) => {
                  av.grp.userData.__selectionScale = (id2 === aid) ? 1.3 : 1.0;
                });
                dragMode = 'avatar';
                avatarDragState = {
                  id: aid,
                  startY: a.grp.position.y, // Y は保持
                  startQuat: a.grp.quaternion.clone(),
                };
                dom.style.cursor = 'move';
                return;
              }
            }
          }
          // 左クリック: 球体上なら orb 操作、それ以外は look (画角操作)
          if (hitTestOrb(e.clientX, e.clientY)) {
            dragMode = 'orb';
            orbDragState = {
              startS: orbState.s,
              startY: orbState.y,
              signFactor: getOrbDragSignFactor(),
            };
            dom.style.cursor = 'move';
          } else {
            dragMode = 'look';
            dom.style.cursor = 'grabbing';
          }
        }
      });
      dom.addEventListener('contextmenu', (e) => e.preventDefault());

      // hover 時に orb / アバター上ならカーソルを変える (フィードバック)
      dom.addEventListener('mousemove', (e) => {
        if (dragMode) return;
        if (ROLE === 'master' && hitTestAvatar(e.clientX, e.clientY)) {
          dom.style.cursor = 'move';
        } else if (hitTestOrb(e.clientX, e.clientY)) {
          dom.style.cursor = 'pointer';
        } else {
          dom.style.cursor = 'grab';
        }
      });

      window.addEventListener('mousemove', (e) => {
        if (!dragMode) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        if (dragMode === 'look') {
          // FPS 風: 左右ドラッグで yaw、上下ドラッグで pitch
          const LOOK_SENS = 0.0035;
          yaw -= dx * LOOK_SENS;
          pitch -= dy * LOOK_SENS;
          // pitch を ±88° にクランプ
          const PITCH_LIMIT = Math.PI / 2 - 0.05;
          pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
          applyYawPitch();
        } else if (dragMode === 'orb' && orbDragState) {
          const SENS = 0.012;
          orbDragState.startS += dx * SENS * orbDragState.signFactor;
          orbDragState.startY -= dy * SENS;
          orbState.s = orbDragState.startS;
          orbState.y = Math.max(ORB_RADIUS,
            Math.min(WALL_H - ORB_RADIUS, orbDragState.startY));
          applyOrbState();
          sendOrbThrottled();
        } else if (dragMode === 'avatar' && avatarDragState) {
          // Master: アバターを地面平面 (y = startY) で XZ 移動
          const pt = planeIntersectXZ(e.clientX, e.clientY, avatarDragState.startY);
          if (pt) {
            const a = avatars.get(avatarDragState.id);
            if (a) {
              // ローカルで即時反映 (見た目の遅延を回避)
              a.grp.position.set(pt.x, avatarDragState.startY, pt.z);
              // サーバーへ送信 (30Hz スロットル)
              const now = performance.now();
              if (now - (avatarDragState.lastSend || 0) > 33) {
                avatarDragState.lastSend = now;
                const q = avatarDragState.startQuat;
                if (socket && socket.connected) {
                  socket.emit('controlPose', {
                    targetId: avatarDragState.id,
                    x: pt.x, y: avatarDragState.startY, z: pt.z,
                    qx: q.x, qy: q.y, qz: q.z, qw: q.w,
                  });
                }
              }
              // パネル入力欄も更新
              const ix = document.getElementById('m-x');
              const iz = document.getElementById('m-z');
              if (ix && document.activeElement !== ix) ix.value = pt.x.toFixed(2);
              if (iz && document.activeElement !== iz) iz.value = pt.z.toFixed(2);
            }
          }
        }
      });
      window.addEventListener('mouseup', () => {
        // ドラッグ終了時に最後の一発を確実に送信
        if (dragMode === 'avatar' && avatarDragState) {
          const a = avatars.get(avatarDragState.id);
          if (a && socket && socket.connected) {
            const p = a.grp.position;
            const q = avatarDragState.startQuat;
            socket.emit('controlPose', {
              targetId: avatarDragState.id,
              x: p.x, y: p.y, z: p.z,
              qx: q.x, qy: q.y, qz: q.z, qw: q.w,
            });
          }
        }
        dragMode = null;
        orbDragState = null;
        avatarDragState = null;
        dom.style.cursor = 'grab';
      });
      // ホイールはズーム代わりに前後移動速度の微調整に流用しない方が直感的なので、
      // FPS的に前後への少しのジャンプとして扱う
      dom.addEventListener('wheel', (e) => {
        e.preventDefault();
        const fwd = new THREE.Vector3();
        camera.getWorldDirection(fwd);
        camera.position.addScaledVector(fwd, e.deltaY > 0 ? -0.3 : 0.3);
      }, { passive: false });

      // WASD/QE 移動 (camera.position 直接更新)
      const keys = {};
      window.addEventListener('keydown', (e) => { keys[e.code] = true; });
      window.addEventListener('keyup',   (e) => { keys[e.code] = false; });

      state.__observerTick = () => {
        const speed = keys.ShiftLeft || keys.ShiftRight ? 0.18 : 0.06;
        const fwd = new THREE.Vector3();
        camera.getWorldDirection(fwd);
        fwd.y = 0; fwd.normalize();
        const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();

        const move = new THREE.Vector3();
        if (keys.KeyW) move.add(fwd);
        if (keys.KeyS) move.add(fwd.clone().negate());
        if (keys.KeyA) move.add(right.clone().negate());
        if (keys.KeyD) move.add(right);
        if (keys.KeyQ) move.y -= 1;
        if (keys.KeyE) move.y += 1;
        if (move.lengthSq() > 0) {
          move.normalize().multiplyScalar(speed);
          camera.position.add(move);
        }
      };

      // 自前パネルの操作 (FPS スタイル: テレポート時もカメラ位置のみ更新)
      function teleportFromInputs() {
        const x = parseFloat(document.getElementById('obs-x').value);
        const y = parseFloat(document.getElementById('obs-y').value);
        const z = parseFloat(document.getElementById('obs-z').value);
        if (!isNaN(x) && !isNaN(y) && !isNaN(z)) {
          camera.position.set(x, y, z);
          // 原点を見るように yaw/pitch を再設定
          const dx = -x, dz = -z;
          yaw = Math.atan2(dx, dz);
          pitch = -Math.atan2(y - 1, Math.sqrt(x * x + z * z));
          applyYawPitch();
        }
      }
      document.getElementById('obs-teleport').addEventListener('click', teleportFromInputs);
      ['obs-x', 'obs-y', 'obs-z'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            teleportFromInputs();
            el.blur();
          }
        });
      });

      document.getElementById('obs-overview').addEventListener('click', () => {
        camera.position.set(0, 8, 12);
        yaw = Math.PI;
        pitch = -0.45;
        applyYawPitch();
      });
      document.getElementById('obs-top').addEventListener('click', () => {
        camera.position.set(0, 12, 0.01); // ほぼ真上、僅か後ろにオフセット
        yaw = Math.PI;
        pitch = -Math.PI / 2 + 0.05;
        applyYawPitch();
      });

      // ライト ON/OFF トグル (オブザーバー専用、初期 OFF)
      let lightOn = false;
      const lightBtn = document.getElementById('obs-light-toggle');
      function syncLightBtn() {
        if (!lightBtn) return;
        lightBtn.textContent = '🔦 ライト ' + (lightOn ? 'ON' : 'OFF');
        lightBtn.style.background = lightOn ? '#fbbf24' : '#6b7280';
        lightBtn.style.color = lightOn ? '#422006' : '#1f2937';
      }
      syncLightBtn();
      function toggleLight() {
        lightOn = !lightOn;
        setMyFlashlight(lightOn);
        if (socket && socket.connected) {
          socket.emit('light', { on: lightOn });
        }
        syncLightBtn();
      }
      if (lightBtn) lightBtn.addEventListener('click', toggleLight);

      // フルスクリーン制御
      const fsExitBtn = document.getElementById('fs-exit-btn');
      function enterFs() {
        const el = document.documentElement;
        const req = el.requestFullscreen || el.webkitRequestFullscreen;
        if (req) req.call(el);
      }
      function exitFs() {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) exit.call(document);
      }
      function toggleFs() {
        if (document.fullscreenElement || document.webkitFullscreenElement) exitFs();
        else enterFs();
      }
      document.getElementById('obs-fullscreen').addEventListener('click', toggleFs);
      if (fsExitBtn) fsExitBtn.addEventListener('click', exitFs);

      function onFsChange() {
        const inFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
        document.body.classList.toggle('fs-mode', inFs);
        resizeRenderer();
      }
      document.addEventListener('fullscreenchange', onFsChange);
      document.addEventListener('webkitfullscreenchange', onFsChange);

      // F キーでフルスクリーン、L キーでライト切替 (入力欄にフォーカスがない時のみ)
      window.addEventListener('keydown', (e) => {
        const tag = document.activeElement && document.activeElement.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        if (e.key === 'f' || e.key === 'F') toggleFs();
        else if (e.key === 'l' || e.key === 'L') toggleLight();
      });

      // ============================================================
      // Off-Axis Projection オブザーバー用コントロール
      //   ・トグル: myDisplay.offaxis を切り替え (ローカルのみ、サーバー broadcast 不要)
      //   ・W/H 入力: myDisplay.width/height を直接更新 + サーバーへ displaySize 通知
      //   ・自動取得: window.innerWidth/Height + devicePixelRatio + 96 PPI から推定
      // ============================================================
      const obsOaBtn  = document.getElementById('obs-offaxis-toggle');
      const obsDispW  = document.getElementById('obs-display-w');
      const obsDispH  = document.getElementById('obs-display-h');
      const obsDispAuto = document.getElementById('obs-display-auto');

      function syncObsOffaxisUI() {
        if (obsOaBtn) {
          obsOaBtn.textContent = myDisplay.offaxis ? 'ON' : 'OFF';
          obsOaBtn.style.background = myDisplay.offaxis ? '#06b6d4' : '#475569';
          obsOaBtn.style.color = myDisplay.offaxis ? '#083344' : 'white';
        }
        if (obsDispW && document.activeElement !== obsDispW) {
          obsDispW.value = myDisplay.width.toFixed(3);
        }
        if (obsDispH && document.activeElement !== obsDispH) {
          obsDispH.value = myDisplay.height.toFixed(3);
        }
      }
      // 既定値で UI を初期化
      syncObsOffaxisUI();
      // master broadcast でディスプレイ設定が更新されたら UI も追従させたい:
      //   オブザーバー (= 非マスター) は受信側 displayConfig ハンドラで myDisplay が更新されるので
      //   そのタイミングで UI 同期する
      state.__syncObsOffaxisUI = syncObsOffaxisUI;

      if (obsOaBtn) {
        obsOaBtn.addEventListener('click', () => {
          myDisplay.offaxis = !myDisplay.offaxis;
          // サーバーへ通知 → master の controlPose+displayConfig で offaxis が潰されなくなる
          if (socket && socket.connected) {
            socket.emit('displayConfig', { offaxis: myDisplay.offaxis });
          }
          log('observer offaxis → ' + (myDisplay.offaxis ? 'ON' : 'OFF'), 'ok');
          syncObsOffaxisUI();
        });
      }

      function applyObsDisplaySize() {
        const w = parseFloat(obsDispW.value);
        const h = parseFloat(obsDispH.value);
        if (isFinite(w) && w > 0.01) myDisplay.width = w;
        if (isFinite(h) && h > 0.01) myDisplay.height = h;
        // master/他クライアントへ通知 (サーバーは displaySize を受けて users[id].display を更新)
        if (socket && socket.connected) {
          socket.emit('displaySize', { width: myDisplay.width, height: myDisplay.height });
        }
        log('observer display size: ' + myDisplay.width.toFixed(3) + ' × ' +
            myDisplay.height.toFixed(3) + ' m', 'ok');
        syncObsOffaxisUI();
      }
      if (obsDispW) {
        obsDispW.addEventListener('change', applyObsDisplaySize);
        obsDispW.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyObsDisplaySize(); });
      }
      if (obsDispH) {
        obsDispH.addEventListener('change', applyObsDisplaySize);
        obsDispH.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyObsDisplaySize(); });
      }
      if (obsDispAuto) {
        obsDispAuto.addEventListener('click', () => {
          // 表示中の (ブラウザ可視) ディスプレイサイズを推定:
          //   width(px) × DPR / PPI(=96) × 0.0254 m/inch
          //   PPI は環境差があるためあくまで参考値
          const dpr = window.devicePixelRatio || 1;
          const PPI = 96;
          const m_per_inch = 0.0254;
          myDisplay.width  = (window.innerWidth  * dpr / PPI) * m_per_inch;
          myDisplay.height = (window.innerHeight * dpr / PPI) * m_per_inch;
          applyObsDisplaySize();
        });
      }

      log('observer ready', 'ok');
    }

    // ============================================================
    // MASTER (observer 拡張): 各クライアントを選択して座標/角度を上書き
    // ============================================================
    let selectedClientId = null;

    function updateMasterClientList() {
      const sel = document.getElementById('m-client-select');
      if (!sel) return;
      const current = sel.value;
      sel.innerHTML = '<option value="">-- 未選択 --</option>';
      avatars.forEach((a, id) => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = (a.role || '?') + ' / ' + id.slice(0, 6) +
          ' / ' + (a.color || '');
        sel.appendChild(opt);
      });
      // 選択中だったものを保持
      if (current && avatars.has(current)) sel.value = current;
    }

    function setupMaster() {
      const sel = document.getElementById('m-client-select');
      const ix = document.getElementById('m-x');
      const iy = document.getElementById('m-y');
      const iz = document.getElementById('m-z');
      const iyaw = document.getElementById('m-yaw');
      const btnApply = document.getElementById('m-apply');
      const btnRead = document.getElementById('m-readcurrent');

      function setSelection(id) {
        selectedClientId = id || null;
        // ハイライト更新: 全アバター scale を 1、選択中だけ 1.3 倍
        avatars.forEach((a, aid) => {
          const targetS = (aid === selectedClientId) ? 1.3 : 1.0;
          a.grp.userData.__selectionScale = targetS;
        });
        if (selectedClientId) readCurrentToFields();
      }

      sel.addEventListener('change', () => setSelection(sel.value));

      const ipitch = document.getElementById('m-pitch');
      const iroll = document.getElementById('m-roll');
      const oaBtn = document.getElementById('m-offaxis-toggle');
      const sizeSpan = document.getElementById('m-display-size');

      // display 関連の UI (off-axis ボタン / サイズ表示) だけを再描画
      function refreshDisplayUI() {
        if (!selectedClientId) return;
        const d = remoteDisplays.get(selectedClientId);
        if (d && sizeSpan) {
          sizeSpan.textContent = 'サイズ: ' + (d.width || 0).toFixed(3) + ' × ' +
            (d.height || 0).toFixed(3) + ' m';
        } else if (sizeSpan) {
          sizeSpan.textContent = 'サイズ: --';
        }
        if (oaBtn) {
          const on = !!(d && d.offaxis);
          oaBtn.textContent = on ? 'ON' : 'OFF';
          oaBtn.style.background = on ? '#06b6d4' : '#475569';
          oaBtn.style.color = on ? '#083344' : 'white';
        }
      }
      // master の現在状態を入力欄へ流し込む (位置/角度入力 + UI 再描画)
      function readCurrentToFields() {
        if (!selectedClientId) return;
        const a = avatars.get(selectedClientId);
        if (!a) return;
        const p = a.grp.position;
        ix.value = p.x.toFixed(2);
        iy.value = p.y.toFixed(2);
        iz.value = p.z.toFixed(2);
        // クォータニオン → Euler (YXZ) で yaw/pitch/roll 抽出
        const e = new THREE.Euler().setFromQuaternion(a.grp.quaternion, 'YXZ');
        iyaw.value = (e.y * 180 / Math.PI).toFixed(1);
        if (ipitch) ipitch.value = (e.x * 180 / Math.PI).toFixed(1);
        if (iroll) iroll.value = (e.z * 180 / Math.PI).toFixed(1);
        refreshDisplayUI();
      }
      btnRead.addEventListener('click', readCurrentToFields);
      // 他から呼べるよう state へ公開 (displayConfig 受信時の即時 UI 同期に使用)
      state.__masterRefreshDisplayUI = refreshDisplayUI;

      function applyControl() {
        if (!selectedClientId) { log('未選択', 'err'); return; }
        const x = parseFloat(ix.value);
        const y = parseFloat(iy.value);
        const z = parseFloat(iz.value);
        const yawDeg = parseFloat(iyaw.value);
        const pitchDeg = parseFloat(ipitch ? ipitch.value : 0) || 0;
        const rollDeg = parseFloat(iroll ? iroll.value : 0) || 0;
        if ([x, y, z, yawDeg].some(isNaN)) return;
        const q = new THREE.Quaternion().setFromEuler(
          new THREE.Euler(
            pitchDeg * Math.PI / 180,
            yawDeg   * Math.PI / 180,
            rollDeg  * Math.PI / 180,
            'YXZ'
          )
        );
        if (socket && socket.connected) {
          socket.emit('controlPose', {
            targetId: selectedClientId,
            x, y, z,
            qx: q.x, qy: q.y, qz: q.z, qw: q.w,
          });
          // ディスプレイ向きも同時に更新
          socket.emit('displayConfig', {
            targetId: selectedClientId,
            yaw: yawDeg, pitch: pitchDeg, roll: rollDeg,
          });
          log('controlPose+displayConfig → ' + selectedClientId.slice(0, 6), 'ok');
        }
      }
      btnApply.addEventListener('click', applyControl);
      [ix, iy, iz, iyaw, ipitch, iroll].forEach((el) => {
        if (!el) return;
        el.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            applyControl();
            el.blur();
          }
        });
      });

      // オフアクシス トグル
      if (oaBtn) oaBtn.addEventListener('click', () => {
        if (!selectedClientId) { log('未選択', 'err'); return; }
        const d = remoteDisplays.get(selectedClientId) || {};
        const newOn = !d.offaxis;
        if (socket && socket.connected) {
          socket.emit('displayConfig', {
            targetId: selectedClientId,
            offaxis: newOn,
          });
          log('offaxis → ' + (newOn ? 'ON' : 'OFF') + ' for ' +
            selectedClientId.slice(0, 6), 'ok');
        }
        // 楽観的に remoteDisplays + UI を即時更新 (broadcast 戻り待ちのちらつき防止)
        remoteDisplays.set(selectedClientId, Object.assign({}, d, { offaxis: newOn }));
        refreshDisplayUI();
      });

      // viewerEye 適用
      const veX = document.getElementById('ve-x');
      const veY = document.getElementById('ve-y');
      const veZ = document.getElementById('ve-z');
      const veApply = document.getElementById('ve-apply');
      function applyViewerEye() {
        const vx = parseFloat(veX.value);
        const vy = parseFloat(veY.value);
        const vz = parseFloat(veZ.value);
        if ([vx, vy, vz].some(isNaN)) return;
        if (socket && socket.connected) {
          socket.emit('viewerEye', { x: vx, y: vy, z: vz });
          log('viewerEye send (' + vx + ',' + vy + ',' + vz + ')', 'ok');
        }
      }
      if (veApply) veApply.addEventListener('click', applyViewerEye);
      [veX, veY, veZ].forEach((el) => {
        if (!el) return;
        el.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') { ev.preventDefault(); applyViewerEye(); el.blur(); }
        });
      });

      // 周回速度倍率 (鯨 / 狐 / 人) を個別管理
      const whaleSpeedInput = document.getElementById('m-whale-speed');
      const foxSpeedInput   = document.getElementById('m-fox-speed');
      const humanSpeedInput = document.getElementById('m-human-speed');
      const orbitApplyBtn   = document.getElementById('m-orbit-apply');
      function applyOrbitSpeeds() {
        const data = {};
        if (whaleSpeedInput) {
          const v = parseFloat(whaleSpeedInput.value);
          if (isFinite(v)) data.whale = v;
        }
        if (foxSpeedInput) {
          const v = parseFloat(foxSpeedInput.value);
          if (isFinite(v)) data.fox = v;
        }
        if (humanSpeedInput) {
          const v = parseFloat(humanSpeedInput.value);
          if (isFinite(v)) data.human = v;
        }
        if (socket && socket.connected) {
          socket.emit('orbitSpeed', data);
          log('orbitSpeed send whale=' + (data.whale ?? '-') +
              ' fox=' + (data.fox ?? '-') +
              ' human=' + (data.human ?? '-'), 'ok');
        }
      }
      if (orbitApplyBtn) orbitApplyBtn.addEventListener('click', applyOrbitSpeeds);
      [whaleSpeedInput, foxSpeedInput, humanSpeedInput].forEach((el) => {
        if (!el) return;
        el.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            applyOrbitSpeeds();
            el.blur();
          }
        });
      });

      // クリックでアバター選択 (raycaster はオブザーバー側にあるので簡易追加)
      const dom = renderer.domElement;
      const mray = new THREE.Raycaster();
      const mNDC = new THREE.Vector2();
      dom.addEventListener('click', (e) => {
        // 既存の look ドラッグ判定後の純粋なクリックのみ反応させたいが、簡易化のため常に判定
        const rect = dom.getBoundingClientRect();
        mNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        mray.setFromCamera(mNDC, camera);
        // 全アバター grp の子全部に対しヒットテスト
        const targets = [];
        avatars.forEach((a) => a.grp.traverse((o) => { if (o.isMesh) targets.push(o); }));
        const hits = mray.intersectObjects(targets, false);
        if (hits.length > 0) {
          // 最初のヒットの親 grp に対応する id を探す
          let obj = hits[0].object;
          while (obj && !obj.userData.__avatarId) obj = obj.parent;
          if (obj && obj.userData.__avatarId) {
            sel.value = obj.userData.__avatarId;
            setSelection(obj.userData.__avatarId);
          }
        }
      });

      // 既存アバターにも id を埋め込む (spawn 時には spawnRemoteAvatar 側で設定済み)
      avatars.forEach((a, id) => { a.grp.userData.__avatarId = id; });
      updateMasterClientList();

      log('master ready', 'ok');
    }

    // ============================================================
    // CAMERA (スマホ): 一人称 + DeviceOrientation + iOS permission
    // ============================================================
    function setupCameraEntry() {
      const btn = document.getElementById('enter-btn');
      btn.addEventListener('click', async () => {
        // iOS 13+: DeviceOrientationEvent.requestPermission()
        try {
          if (typeof DeviceOrientationEvent !== 'undefined'
              && typeof DeviceOrientationEvent.requestPermission === 'function') {
            const p = await DeviceOrientationEvent.requestPermission();
            if (p !== 'granted') {
              log('DeviceOrientation 拒否', 'err');
              return;
            }
            log('DeviceOrientation 許可', 'ok');
          }
        } catch (e) {
          log('requestPermission例外: ' + e.message, 'err');
        }
        // iOS 13+: DeviceMotionEvent.requestPermission() (歩行追跡用)
        try {
          if (typeof DeviceMotionEvent !== 'undefined'
              && typeof DeviceMotionEvent.requestPermission === 'function') {
            const p = await DeviceMotionEvent.requestPermission();
            if (p !== 'granted') {
              log('DeviceMotion 拒否 (歩行追跡無効)', 'err');
            } else {
              log('DeviceMotion 許可', 'ok');
            }
          }
        } catch (e) {
          log('DeviceMotion permission 例外: ' + e.message, 'err');
        }

        enterAsCamera();
      });
    }

    function enterAsCamera() {
      state.entered = true;
      // 机 (y=1m) 周辺 + 目線高さを想定したスポーン体積
      //   4m × 1m × 4m、中心 (0, 1.5, 0) → x±2, y 1〜2, z±2
      const x = 0 + (Math.random() - 0.5) * 4;
      const y = 1.5 + (Math.random() - 0.5) * 1;
      const z = 0 + (Math.random() - 0.5) * 4;
      state.mySpawn = { x, y, z };

      camera.position.set(x, y, z);
      log(`spawn: (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`, 'ok');

      // 自分のアバターは "自分の端末のシーンには追加しない"。
      // 他クライアントでは pose ブロードキャスト経由で makeAvatar されるので問題なし。
      // ここに置くとマジックウィンドウや枠が camera の near 内に重なって視界を塞ぐ。
      state.selfGroup = null;

      document.getElementById('enter-overlay').style.display = 'none';
      setupDeviceOrientation();
    }

    function setupDeviceOrientation() {
      // 標準的なDeviceOrientation → Quaternion 変換
      // 参考: Three.js 旧 DeviceOrientationControls
      const euler = new THREE.Euler();
      const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -PI/2 X軸
      const zee = new THREE.Vector3(0, 0, 1);
      const q0 = new THREE.Quaternion();

      let alpha = 0, beta = 0, gamma = 0;
      let screenOrient = (typeof window.orientation === 'number') ? window.orientation : 0;

      window.addEventListener('orientationchange', () => {
        screenOrient = window.orientation || 0;
      });

      window.addEventListener('deviceorientation', (e) => {
        if (e.alpha === null) return;
        alpha = THREE.MathUtils.degToRad(e.alpha);
        beta  = THREE.MathUtils.degToRad(e.beta || 0);
        gamma = THREE.MathUtils.degToRad(e.gamma || 0);
      }, true);

      // tick内で参照するため state に保存
      state.__cameraTick = () => {
        const orient = THREE.MathUtils.degToRad(screenOrient);
        euler.set(beta, alpha, -gamma, 'YXZ');
        camera.quaternion.setFromEuler(euler);
        camera.quaternion.multiply(q1);
        camera.quaternion.multiply(q0.setFromAxisAngle(zee, -orient));

        state.cameraQuat.copy(camera.quaternion);

        // 端末姿勢 (q1 オフセットなし) を歩行追跡用に保持
        //   加速度を世界座標系に変換するのに使う
        deviceWorldQuat.setFromEuler(euler);
        deviceWorldQuat.multiply(q0.setFromAxisAngle(zee, -orient));
      };

      log('DeviceOrientation listener attached');
    }

    // ============================================================
    // ウィンドウサイズ追従
    // ============================================================
    const TABBAR_H = 44;
    function resizeRenderer() {
      const inFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
      const uiHidden = document.body.classList.contains('ui-hidden');
      const tabbarShown = !inFs && !uiHidden;
      const w = window.innerWidth;
      const h = window.innerHeight - (tabbarShown ? TABBAR_H : 0);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }
    window.addEventListener('resize', resizeRenderer);
    resizeRenderer();

    // ============================================================
    // Socket.IO
    // ============================================================
    let socket;
    function waitForIO(cb, n = 100) {
      if (typeof io !== 'undefined') return cb();
      if (n <= 0) { log('socket.io タイムアウト', 'err'); return; }
      setTimeout(() => waitForIO(cb, n - 1), 50);
    }
    waitForIO(() => {
      try {
        const cfg = window.APP_CONFIG || {};
        const url = cfg.socketUrl || undefined;
        socket = url
          ? io(url, { transports: ['websocket', 'polling'] })
          : io({ transports: ['websocket', 'polling'] });
        log('io() → ' + (url || 'same-origin'), 'ok');
        attachSocket();
      } catch (e) {
        log('io 例外: ' + e.message, 'err');
      }
    });

    function attachSocket() {
      socket.on('connect', () => {
        document.getElementById('conn-pill').classList.add('ok');
        document.getElementById('conn-text').textContent = '接続済み';
        log('socket id=' + socket.id.slice(0, 6), 'ok');
      });
      socket.on('disconnect', () => {
        document.getElementById('conn-pill').classList.remove('ok');
        document.getElementById('conn-text').textContent = '切断';
      });
      socket.on('init', ({ id, self, users }) => {
        state.myId = id;
        state.myColor = self.color;
        log(`init: 既存${Object.keys(users).length}人`);
        // ディスプレイサイズをサーバーへ報告
        socket.emit('displaySize', { width: myDisplay.width, height: myDisplay.height });
        for (const [otherId, u] of Object.entries(users)) {
          spawnRemoteAvatar(otherId, u);
          if (u.display) remoteDisplays.set(otherId, u.display);
        }
        updateCount();
      });
      socket.on('join', ({ id, ...u }) => {
        spawnRemoteAvatar(id, u);
        updateCount();
      });
      socket.on('pose', ({ id, role, x, y, z, qx, qy, qz, qw }) => {
        const a = avatars.get(id);
        if (!a) return;
        a.targetPos.set(x, y, z);
        a.targetQuat.set(qx, qy, qz, qw);
        // role が変わったら observer 同士の非表示判定を更新
        if (typeof role === 'string' && role !== a.role) {
          a.role = role;
          const hide = isHiddenAvatar(role);
          if (a.grp) a.grp.visible = !hide;
          if (a.flashlight) {
            a.flashlight.light.visible = !hide && (a.lightOn === true);
            a.flashlight.cone.visible  = !hide && (a.lightOn === true);
          }
        }
      });
      socket.on('leave', ({ id }) => {
        despawnRemoteAvatar(id);
        updateCount();
      });
      // 壁を這う球体: 他クライアントからの更新を反映
      socket.on('orb', (data) => {
        if (typeof data.s === 'number') orbState.s = data.s;
        if (typeof data.y === 'number') orbState.y = data.y;
        applyOrbState();
      });
      // ディスプレイ設定の更新 (自分宛 or 他クライアント)
      // master からの displayConfig 受信時、自分宛なら myDisplay を更新 + UI 同期
      socket.on('displayConfig', ({ id, display }) => {
        if (!display) return;
        if (id === state.myId) {
          if (typeof display.yaw === 'number') myDisplay.yaw = display.yaw;
          if (typeof display.pitch === 'number') myDisplay.pitch = display.pitch;
          if (typeof display.roll === 'number') myDisplay.roll = display.roll;
          if (typeof display.offaxis === 'boolean') myDisplay.offaxis = display.offaxis;
          if (typeof display.width === 'number') myDisplay.width = display.width;
          if (typeof display.height === 'number') myDisplay.height = display.height;
          log('myDisplay updated: ' + myDisplay.width.toFixed(2) + 'x' +
              myDisplay.height.toFixed(2) + 'm  yaw=' + myDisplay.yaw +
              ' offaxis=' + myDisplay.offaxis, 'ok');
          // オブザーバーパネルの off-axis 表示も追従
          if (typeof state.__syncObsOffaxisUI === 'function') state.__syncObsOffaxisUI();
          // スマホ画面上部の off-axis ボタンも追従
          if (typeof state.__syncCamOaBtn === 'function') state.__syncCamOaBtn();
        } else {
          // 部分マージ
          const prev = remoteDisplays.get(id) || {};
          const merged = Object.assign({}, prev, display);
          remoteDisplays.set(id, merged);
          // 該当アバターのフレームをサイズ更新
          const a = avatars.get(id);
          if (a && a.frustum && merged.width && merged.height) {
            updateDisplayFrame(a.frustum, merged.width, merged.height);
          }
          // master が現在この id を選択中なら、ボタン/サイズ表示を即時再描画
          //   → 観察者が offaxis を toggle した瞬間に master のボタンも反応するように
          if (ROLE === 'master' && typeof state.__masterRefreshDisplayUI === 'function') {
            state.__masterRefreshDisplayUI();
          }
        }
      });

      // 他クライアントからのスプレー受信 → 自分の床へ同じ Shader pass を適用
      let _sprayRecvSeen = false;
      socket.on('spray', (data) => {
        if (!_sprayRecvSeen) {
          _sprayRecvSeen = true;
          try { log(`spray RECV from network color=${data && data.color}`, 'ok'); } catch (_) {}
        }
        processSprayEvent(data);
      });

      // 周回状態 (絶対時刻位相方式 + サーバー時刻同期)
      //   新プロトコル: { serverNow, whale: factor, whalePhase, whaleT0, fox: ..., human: ... }
      //   旧プロトコル (factor のみ) も後方互換として受け付ける
      socket.on('orbitSpeed', (data) => {
        if (!data || typeof data !== 'object') return;
        // サーバー時刻オフセットを更新 (デバイス間の OS 時計ずれを吸収)
        if (typeof data.serverNow === 'number' && isFinite(data.serverNow)) {
          _serverClockOffset = data.serverNow - Date.now();
          try { log('clock sync: server offset = ' + _serverClockOffset + ' ms', 'ok'); } catch (_) {}
        }
        const updateUiInput = (factor, inputId) => {
          if (typeof factor !== 'number' || !isFinite(factor)) return;
          const el = document.getElementById(inputId);
          if (el && document.activeElement !== el) el.value = factor.toFixed(2);
        };
        function applyState(state, factor, phase, t0) {
          if (typeof phase === 'number' && typeof t0 === 'number' && isFinite(phase) && isFinite(t0)) {
            // 新プロトコル: phase + t0 + factor を全部更新 (位相凍結状態を再現)
            state.phase = phase;
            state.t0 = t0;
            state.factor = factor;
          } else {
            // 旧プロトコル: factor だけが来た場合、ローカルで位相凍結
            state.phase = state.phase + state.factor * (Date.now() - state.t0) / 1000;
            state.t0 = Date.now();
            state.factor = factor;
          }
        }
        if (typeof data.whale === 'number' && isFinite(data.whale)) {
          applyState(whaleOrbitState, data.whale, data.whalePhase, data.whaleT0);
          updateUiInput(data.whale, 'm-whale-speed');
        }
        if (typeof data.fox === 'number' && isFinite(data.fox)) {
          applyState(foxOrbitState, data.fox, data.foxPhase, data.foxT0);
          updateUiInput(data.fox, 'm-fox-speed');
        }
        if (typeof data.human === 'number' && isFinite(data.human)) {
          applyState(humanOrbitState, data.human, data.humanPhase, data.humanT0);
          updateUiInput(data.human, 'm-human-speed');
        }
        log('orbit speeds: whale=' + whaleOrbitState.factor.toFixed(2) +
            ' fox=' + foxOrbitState.factor.toFixed(2) +
            ' human=' + humanOrbitState.factor.toFixed(2), 'ok');
      });

      // 共通視点位置
      socket.on('viewerEye', ({ x, y, z }) => {
        if (typeof x === 'number') viewerEye.x = x;
        if (typeof y === 'number') viewerEye.y = y;
        if (typeof z === 'number') viewerEye.z = z;
        log('viewerEye → (' + viewerEye.x + ',' + viewerEye.y + ',' + viewerEye.z + ')', 'ok');
        // Master パネルの入力欄も更新
        const vx = document.getElementById('ve-x');
        const vy = document.getElementById('ve-y');
        const vz = document.getElementById('ve-z');
        if (vx && document.activeElement !== vx) vx.value = viewerEye.x.toFixed(2);
        if (vy && document.activeElement !== vy) vy.value = viewerEye.y.toFixed(2);
        if (vz && document.activeElement !== vz) vz.value = viewerEye.z.toFixed(2);
      });

      // 他クライアントの懐中電灯 ON/OFF を反映
      socket.on('light', ({ id, on }) => {
        const a = avatars.get(id);
        if (!a || !a.flashlight) return;
        a.flashlight.light.visible = !!on;
        a.flashlight.cone.visible = !!on;
      });

      // Master からの強制ポーズ。自分宛なら camera を上書き、他はリモートアバターを上書き
      socket.on('forcePose', ({ id, x, y, z, qx, qy, qz, qw }) => {
        log('forcePose RX: ' + (id ? id.slice(0, 6) : '?') +
            ' (' + x.toFixed(1) + ',' + y.toFixed(1) + ',' + z.toFixed(1) + ')', 'ok');
        if (id === state.myId) {
          // 自分の VR camera を強制設定
          camera.position.set(x, y, z);
          camera.quaternion.set(qx || 0, qy || 0, qz || 0, qw || 1);
          if (ROLE === 'camera') {
            state.mySpawn = { x, y, z };
            // 歩行追跡もこの位置にリセット
            if (walking.enabled) {
              walking.anchor.set(x, y, z);
              walking.delta.set(0, 0, 0);
              walking.vel.set(0, 0, 0);
            }
          }
        } else {
          const a = avatars.get(id);
          if (!a) return;
          a.targetPos.set(x, y, z);
          a.targetQuat.set(qx || 0, qy || 0, qz || 0, qw || 1);
          // 即時スナップ
          a.grp.position.set(x, y, z);
          a.grp.quaternion.set(qx || 0, qy || 0, qz || 0, qw || 1);
        }
      });
    }

    // ============================================================
    // スマホ (camera ロール) のタッチで球体を操作
    //   水平ドラッグ: s (壁の周回位置) を変更 (signFactor で左右補正)
    //   垂直ドラッグ: y (高さ) を変更
    // ============================================================
    if (ROLE === 'camera') {
      const dom = renderer.domElement;
      let touchStart = null;
      const ORB_DRAG_SENS = 0.012;

      dom.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        // ログ枠など UI 要素から始まったタッチは無視 (スクロール優先)
        const target = e.target;
        if (target && target.closest && target.closest('#log, #ui-toggle, #tabbar, #status')) return;
        touchStart = {
          x: e.touches[0].clientX,
          y: e.touches[0].clientY,
          startS: orbState.s,
          startY: orbState.y,
          signFactor: getOrbDragSignFactor(),
        };
      }, { passive: false });

      dom.addEventListener('touchmove', (e) => {
        if (!touchStart || e.touches.length !== 1) return;
        e.preventDefault();
        const dx = e.touches[0].clientX - touchStart.x;
        const dy = e.touches[0].clientY - touchStart.y;
        orbState.s = touchStart.startS + dx * ORB_DRAG_SENS * touchStart.signFactor;
        orbState.y = Math.max(ORB_RADIUS,
          Math.min(WALL_H - ORB_RADIUS, touchStart.startY - dy * ORB_DRAG_SENS));
        applyOrbState();
        sendOrbThrottled();
      }, { passive: false });

      dom.addEventListener('touchend', () => { touchStart = null; });
      dom.addEventListener('touchcancel', () => { touchStart = null; });
    }

    function recolor(grp, colorStr) {
      const col = new THREE.Color(colorStr);
      grp.traverse((o) => {
        if (o.material && o.material.color !== undefined) {
          o.material.color.copy(col);
          if (o.material.emissive) o.material.emissive.copy(col);
        }
      });
    }

    // ============================================================
    // ポーズ送信
    // ============================================================
    function sendMyPose() {
      if (!state.entered) return;
      if (!socket || !socket.connected) return;
      if (tabState.active !== 'vr') return; // カメラタブ表示中は送信停止
      const q = camera.quaternion;
      const p = camera.position;
      socket.emit('pose', {
        role: ROLE,
        x: p.x, y: p.y, z: p.z,
        qx: q.x, qy: q.y, qz: q.z, qw: q.w,
      });
    }

    // ============================================================
    // メインループ
    // ============================================================
    const tmpVec = new THREE.Vector3();

    function tick() {
      requestAnimationFrame(tick);
      // スプレー発射中の床ヒット位置リング更新 (発射者本人のみ可視)
      updateSprayConeVis();

      // ロール別の毎フレーム処理
      if (ROLE === 'camera' && state.__cameraTick) state.__cameraTick();
      if ((ROLE === 'observer' || ROLE === 'master') && state.__observerTick) state.__observerTick();

      // 歩行追跡: camera ロールのみ、anchor + delta でカメラ位置を更新
      if (ROLE === 'camera' && walking.enabled) {
        camera.position.copy(walking.anchor).add(walking.delta);
        // state.mySpawn も更新 (他クライアントへブロードキャストされる)
        if (state.mySpawn) {
          state.mySpawn.x = camera.position.x;
          state.mySpawn.y = camera.position.y;
          state.mySpawn.z = camera.position.z;
        }
      }

      // 自分のアバターは自端末では描画しない (他端末では pose 経由で描画される)

      // 自分のポーズを20Hzで送信 (camera/observer どちらも)
      const now = performance.now();
      if (state.entered && now - state.lastSendTime > 50) {
        state.lastSendTime = now;
        sendMyPose();
      }

      // 自分位置UI更新 (常に camera.position から)
      {
        const p = camera.position;
        document.getElementById('my-pos').textContent =
          `${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`;
        if (ROLE === 'observer' || ROLE === 'master') {
          // パネルのXYZを更新(編集中フィールドは触らない)
          const oxe = document.getElementById('obs-x');
          const oye = document.getElementById('obs-y');
          const oze = document.getElementById('obs-z');
          if (oxe && document.activeElement !== oxe) oxe.value = p.x.toFixed(2);
          if (oye && document.activeElement !== oye) oye.value = p.y.toFixed(2);
          if (oze && document.activeElement !== oze) oze.value = p.z.toFixed(2);
        }
      }

      // リモートアバターの補間・ポップ・距離
      let nearest = Infinity;
      avatars.forEach((a) => {
        const o = a.grp;
        o.position.lerp(a.targetPos, 0.2);
        o.quaternion.slerp(a.targetQuat, 0.2);

        const elapsed = now - o.__spawnedAt;
        if (elapsed < 800) {
          const t = Math.min(1, elapsed / 700);
          const s = Math.max(0.001, easeOutBack(t));
          o.scale.set(s, s, s);
        } else {
          // Master モードで選択中なら 1.3 倍にスケール (ハイライト)
          const ss = o.userData.__selectionScale || 1.0;
          o.scale.set(ss, ss, ss);
        }

        // 距離計算
        tmpVec.copy(o.position).sub(camera.position);
        const dist = tmpVec.length();
        if (dist < nearest) nearest = dist;
      });

      document.getElementById('nearest').textContent =
        avatars.size === 0 ? '--' : nearest.toFixed(2);

      // MASTER ロールのみ視錐台を更新 (毎フレーム)
      if (ROLE === 'master') {
        updateMasterViewFrustums();
      }

      // Human (human_1) アニメ + ルートモーション無効化 + 長方形外周周回 (絶対時刻位相方式)
      if (humanObj) {
        const dtH = humanClock.getDelta();
        if (humanMixer) humanMixer.update(dtH);
        if (humanRootBone && humanRootInitPos) {
          humanRootBone.position.set(0, humanRootInitPos.y, 0);
        }
        // 距離 (m) = humanBaseSpeed × accum(factor-秒)
        const humanBaseSpeed = HUMAN_RECT_PERIM / HUMAN_PERIOD_SEC;
        const humanDist = humanBaseSpeed * humanAccum();
        const pt = humanRectPositionAt(humanDist);
        humanOrbitGroup.position.set(pt.x, 0, pt.z);
        humanOrbitGroup.rotation.y = Math.atan2(pt.dx, pt.dz);
      }

      // Fox (Fox_1) アニメーション + 楕円軌道周回 (絶対時刻位相方式)
      if (foxObj) {
        const dtF = foxClock.getDelta();
        if (foxMixer) foxMixer.update(dtF);

        // 角度 (rad) = FOX_BASE_OMEGA × accum(factor-秒)
        const foxTheta = FOX_BASE_OMEGA * foxAccum();
        // 楕円: x = SEMI_X * sin(theta), z = CENTER_Z + SEMI_Z * cos(theta)
        foxOrbitGroup.position.x = FOX_SEMI_X * Math.sin(foxTheta);
        foxOrbitGroup.position.y = 0;
        foxOrbitGroup.position.z = FOX_CENTER_Z + FOX_SEMI_Z * Math.cos(foxTheta);

        // 進行方向 (接線) を向く
        const tx = FOX_SEMI_X * Math.cos(foxTheta);
        const tz = -FOX_SEMI_Z * Math.sin(foxTheta);
        foxOrbitGroup.rotation.y = Math.atan2(tx, tz) + Math.PI;
      }

      // フィールド範囲 (20m × 20m 中心原点) 内なら表示、外なら非表示。
      //   visible 切替は描画のみに影響し、親 Group の周回更新は止まらない。
      const FIELD_HALF = 10;
      function _isInsideField(obj) {
        if (!obj) return false;
        const p = obj.getWorldPosition(_fieldVisVec);
        return p.x >= -FIELD_HALF && p.x <= FIELD_HALF &&
               p.z >= -FIELD_HALF && p.z <= FIELD_HALF;
      }
      if (whaleObj) whaleObj.visible = _isInsideField(whaleObj);
      if (foxObj)   foxObj.visible   = _isInsideField(foxObj);
      if (humanObj) humanObj.visible = _isInsideField(humanObj);

      // Whale (kujira_1) アニメーション + 周回更新 + 上下振動
      //   ・mixer (FBX 埋め込み) は体内ボーンを動かす (体のうねり)
      //   ・親ピボット rotation.y → 円周回 (累積角度 → 速度変更で位置が飛ばない)
      //   ・親ピボット position.y → サインカーブで上下振動
      if (whaleObj) {
        const dtW = whaleClock.getDelta();
        if (whaleMixer) whaleMixer.update(dtW);

        // 絶対時刻位相方式 (全クライアントで Date.now() を共有 → ロード時刻に依らず同じ位置)
        const whaleTheta = WHALE_BASE_OMEGA * whaleAccum();
        whaleOrbitPivot.rotation.y = -whaleTheta;

        // 上下振動もサーバー時刻ベース (全クライアントで完全に揃う)
        const t = syncedNow() * 0.001;
        whaleOrbitPivot.position.y =
          ORBIT_Y_BASE + Math.sin(t * ORBIT_Y_FREQ) * ORBIT_Y_AMP;
      }

      // VRタブが非表示なら描画スキップ (A-Frame が別タブで動いている)
      if (tabState.active === 'vr') {
        // オフアクシス投影が有効なら自分用に専用カメラを構築 → 描画
        //   ※ applyOffAxisProjection は描画時に camera.position/quaternion を eye 起点に上書きする。
        //      自操作 / Master からの位置更新が潰れないよう、描画前に「ユーザー由来のアバター位置」を退避し、
        //      描画後に必ず復元する。アバター位置 = ディスプレイ位置 という運用。
        if (myDisplay.offaxis) {
          // 退避: ユーザー / Master 由来のアバター pose
          _oaSavePos.copy(camera.position);
          _oaSaveQuat.copy(camera.quaternion);

          // ロール別 off-axis ジオメトリ:
          if (ROLE === 'camera') {
            // スマホ視点:
            //   ・eye = アバター位置 = camera.position (= ユーザーの目の位置)
            //   ・dispCenter = アバターの **視線方向 20cm 先**
            //   ・display 姿勢 = camera.quaternion (画面はユーザーに正対)
            //     → display 法線 (local +Z) = camera local +Z = カメラ背面 = eye 側
            //     → flip 不要、applyOffAxisProjection の d > 0 が自然に成立
            //   ・display サイズ = myDisplay.width/height (実機表示サイズ)
            _oaEye.copy(_oaSavePos);
            // forward = camera local -Z in world
            _oaTmp.set(0, 0, -1).applyQuaternion(_oaSaveQuat);
            _oaDispCenter.copy(_oaSavePos).addScaledVector(_oaTmp, CAM_WINDOW_DIST);
            _oaDispQuat.copy(_oaSaveQuat);
          } else {
            // observer / master 視点:
            //   ・eye = 共通固定点 viewerEye
            //   ・dispCenter = アバター位置 (画面がそこに置かれている想定)
            //   ・display 姿勢 = avatar quaternion × Euler × 180°flip
            _oaDispCenter.copy(_oaSavePos);
            _oaEye.set(viewerEye.x, viewerEye.y, viewerEye.z);
            _oaEuler.set(
              myDisplay.pitch * Math.PI / 180,
              myDisplay.yaw   * Math.PI / 180,
              myDisplay.roll  * Math.PI / 180,
              'YXZ'
            );
            _oaOffsetQuat.setFromEuler(_oaEuler);
            _oaDispQuat.copy(_oaSaveQuat).multiply(_oaOffsetQuat).multiply(_oaFlipQ);
          }

          const ok = applyOffAxisProjection(
            camera, _oaEye, _oaDispCenter, _oaDispQuat,
            myDisplay.width, myDisplay.height,
            0.05, 200
          );
          if (!ok) {
            camera.updateProjectionMatrix();
          }

          renderer.render(scene, camera);

          // 復元: カメラ位置/姿勢をユーザー由来の値に戻す
          //   → 次フレームの WASD / マウス / forcePose 処理が camera.position を正しく扱える
          //   → pose 送信もアバター位置 (= ディスプレイ位置) で正しい値が送られる
          camera.position.copy(_oaSavePos);
          camera.quaternion.copy(_oaSaveQuat);
        } else {
          // 通常の対称 perspective に復帰
          camera.aspect = window.innerWidth / (window.innerHeight - 44);
          camera.fov = 72;
          camera.updateProjectionMatrix();
          renderer.render(scene, camera);
        }
      }
    }
    tick();
  }
})();
