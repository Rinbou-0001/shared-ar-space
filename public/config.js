// config.js - 接続先設定
//
// Socket.IOサーバーのURL:
//   - ローカル開発(同一サーバー上): 空文字 '' → 同一オリジン接続
//   - 本番(Firebase Hosting からアクセス): 'https://your-app.onrender.com' のようにNodeホストのURL
//
// このファイルだけ書き換えれば接続先を切替可能。
//
// ※ Firebase Hostingへデプロイ時は、socketUrl を Render/Railway 等のURLに設定してください。

window.APP_CONFIG = {
  // 同一オリジン(npm start で起動した場合)
  socketUrl: '',

  // 本番例:
  // socketUrl: 'https://shared-ar-space.onrender.com',
};
