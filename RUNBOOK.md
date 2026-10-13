# 起動・運用フロー

## 構成概要

```
[スマホ]
   │
   ├─ https://shared-ar-space.web.app/        ← Firebase Hosting(静的ファイル配信)
   │      ├─ index.html / room.html / ar-test.html
   │      ├─ config.js  (Socket.IO接続先URLを保持)
   │      ├─ vendor/  (A-Frame, AR.js)
   │      └─ data/    (camera_para.dat, patt.hiro)
   │
   └─ wss://shared-ar-space.onrender.com/     ← Render(Socket.IOサーバー)
          └─ server.js (Express + Socket.IO、姿勢ブロードキャストのみ)
```

両方とも Git リポジトリと連動。GitHub に push すると Render が自動デプロイ、Firebase は手動デプロイ。

---

## A. ローカル開発時(同じWi-FiでPCとスマホ)

最も手軽な確認方法。PCのターミナルで:

```bash
cd shared-ar-space
npm install            # 初回のみ
npm start              # サーバー起動
```

`certs/cert.pem` と `certs/key.pem` があれば自動でHTTPSモード。LAN IP が表示されるので、スマホで:

```
https://<表示されたIP>:3000/room.html
```

ローカル開発時は `config.js` の `socketUrl` を空にしておくと同一オリジン接続になります(本番URLが入っているとRenderに繋ぎに行ってしまうので、ローカル試験時は一時的に空にする)。

```javascript
window.APP_CONFIG = {
  socketUrl: '',  // ローカルテスト
};
```

mkcert で証明書を発行する手順(初回のみ):

```bash
brew install mkcert nss
mkcert -install
mkdir -p certs
mkcert -cert-file certs/cert.pem -key-file certs/key.pem localhost <LAN-IP>
```

スマホには mkcert のルートCA(`mkcert -CAROOT` で表示される場所の `rootCA.pem`)を AirDrop 等で送って、設定アプリのプロファイル管理から信頼登録。

---

## B. コード変更を本番に反映する

### B-1. クライアント側(HTML/JS/データファイル)を変更した場合

Firebase Hosting にデプロイ:

```bash
cd shared-ar-space
firebase deploy --only hosting
```

数十秒で完了。Hosting URLは `https://shared-ar-space.web.app`(変わらない)。

### B-2. サーバー側(server.js)を変更した場合

GitHubに push するだけ。Renderが自動的に再デプロイ。

```bash
git add server.js
git commit -m "サーバー変更内容"
git push origin main
```

Renderダッシュボードの「Events」タブで `Deploy live` になれば反映完了(2〜5分)。

### B-3. 両方変更した場合

```bash
git add .
git commit -m "両方変更"
git push origin main                # Render自動デプロイ
firebase deploy --only hosting       # Firebase手動デプロイ
```

---

## C. 各サービスのダッシュボード

| サービス | URL | 用途 |
|---|---|---|
| GitHub | https://github.com/watanaberin/shared-ar-space | コード管理 |
| Render | https://dashboard.render.com | Socket.IOサーバーのログ・環境変数 |
| Firebase | https://console.firebase.google.com/project/shared-ar-space | Hostingの履歴・ロールバック |

### Render で確認すべき項目

- **Events** タブ: デプロイ履歴。`Deploy live` が最新ならOK
- **Logs** タブ: サーバーログ。`Shared VR Space (HTTP)` で起動、`CORS allowed origins:` で許可ドメイン確認、`[+] xxxxx connected` で接続ログ
- **Environment** タブ: 環境変数。`ALLOWED_ORIGINS` が正しい値か確認

### Firebase で確認すべき項目

- **Hosting** メニュー: リリース履歴。問題があれば過去バージョンに即ロールバック可能

---

## D. アクセスURL一覧

| 目的 | URL |
|---|---|
| ランディング | https://shared-ar-space.web.app/ |
| AR共有空間(本番) | https://shared-ar-space.web.app/room.html |
| AR.js単独テスト | https://shared-ar-space.web.app/ar-test.html |
| Renderサーバー(直接) | https://shared-ar-space.onrender.com/ |
| Socket.IOエンドポイント | https://shared-ar-space.onrender.com/socket.io/socket.io.js |

---

## E. よくあるトラブルと対処

### `io() 例外: Can't find variable: io`
socket.ioの読み込みが完了する前に呼ばれている。`room.js` の `waitForIO` で対処済みなので、最新コードがデプロイされているか確認。

### `socket.io FAILED: ...`
Renderサーバーが起きていない or CORSで拒否されている。
- `https://shared-ar-space.onrender.com/` を直接ブラウザで開く → 起きていれば数十秒で応答
- Render の Logs タブで CORS allowed origins を確認

### Renderの無料プランがスリープ
15分アクセスがないとスリープし、次のアクセスは20秒ほど起動に時間がかかる。本番運用なら有料プランに切替、または UptimeRobot などで定期ping。

### マーカーが認識されない
- カメラの解像度・明るさ確認
- Hiroマーカーを十分大きく(印刷推奨)
- マーカー画像: https://github.com/AR-js-org/AR.js/blob/master/data/images/HIRO.jpg

### `firebase deploy` で `Error: No currently active project`
```bash
firebase use shared-ar-space
firebase deploy --only hosting
```

### Firebase URL でアクセスしたが古い内容
Firebase Hosting のキャッシュ。`firebase deploy --only hosting` を再実行、またはブラウザのハードリロード。

---

## F. ファイル変更時のチェックリスト

| 変更したファイル | 必要なアクション |
|---|---|
| `public/index.html` | `firebase deploy --only hosting` |
| `public/room.html` | `firebase deploy --only hosting` |
| `public/room.js` | `firebase deploy --only hosting` |
| `public/config.js` | `firebase deploy --only hosting` |
| `public/ar-test.html` | `firebase deploy --only hosting` |
| `server.js` | `git push origin main`(Render自動) |
| `package.json` | 両方:`git push` + `firebase deploy` |
| `firebase.json` | 設定変更のみ。次の `firebase deploy` で反映 |

---

## G. バックアップ

定期的に取りたい場合(Claudeに頼んでもOK):

```bash
cd shared-ar-space
DATE=$(date +%Y-%m-%d)
rsync -a --exclude='node_modules' --exclude='.npm' --exclude='.firebase' . "../shared-ar-space-backup-$DATE/"
```

GitHubに push してあれば、リポジトリ自体がバックアップになっています。
