# Render（無料）にデプロイする手順

1. このフォルダをGitHubのリポジトリにpush（`.env` と `*.db` は含めない。.gitignore済み）
2. https://dashboard.render.com →「New +」→「Web Service」→ リポジトリを選択
   - Runtime: Docker（Dockerfile同梱、Node 24）/ Instance Type: **Free**
   - または「New + → Blueprint」で render.yaml を読み込む
3. Environment に設定：
   - `X_CLIENT_ID` / `X_CLIENT_SECRET`：X Developer Consoleの値
   - `SESSION_SECRET`：長いランダム文字列（Blueprintなら自動生成）
   - `BASE_URL`：最初は空でOK。デプロイ後に出るURL `https://サービス名.onrender.com` を入れて再デプロイ
   - `PORT` はRenderが自動設定するので不要
4. X Developer Console（X-analyzer-NiziUcci）の User authentication settings：
   - Callback URI：`https://サービス名.onrender.com/callback`
   - Website URL：`https://サービス名.onrender.com`
5. `https://サービス名.onrender.com` を開いて「Xでログイン」

## 注意（無料枠）
- 永続ディスクがないため、SQLite（spaces.db）のデータは再起動・再デプロイ・スリープ復帰で**消えます**。お試し用と割り切ってください。残したい場合は無料Postgres等へ移行が必要です。
- 15分アクセスがないとスリープし、次回表示に約1分かかります。
