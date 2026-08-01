# 技術構成

- Cloudflare Workers: 配信とAPI
- Hono / Hono JSX: ルーティングとサーバー描画
- Vite+: 開発、型検査、テスト、ビルド
- Cloudflare D1: 期限付き募集と匿名イベント
- TypeScript 7 / Node.js 24 LTS / npm

Better Authは使わない。個人アカウントを作る必要がなく、短命な管理能力URLの方が保存データと操作負担を小さくできるため。

CSSとSVGはリポジトリ内で管理し、公式ゲーム素材、外部フォント、外部JavaScriptを読み込まない。
