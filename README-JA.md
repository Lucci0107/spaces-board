# Spaces Board（スペース予定共有サイト）Mac での動かし方

## 1. Node.js を入れる
- Node.js **22.13 以上**（推奨: 24 LTS）が必要です（内蔵の `node:sqlite` を使うため。Node 20 では動きません）。
- https://nodejs.org から LTS をインストール、または `brew install node`
- 確認: `node -v`

## 2. 準備
```bash
cd ~/Downloads/spaces-board   # 解凍したフォルダ
npm install
```

## 3. デモモード（キー不要）
```bash
npm start        # または node server.js
```
ブラウザで http://localhost:3000 を開きます。止めるときは Ctrl+C。

## 4. 本物の Xログイン
### 4-1. 公開URL（トンネル）を作る
```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:3000
```
表示される `https://xxxx.trycloudflare.com` をコピー（このターミナルは開いたまま）。
※ URL は起動のたびに変わるので、変わったら 4-2・4-3 をやり直してください。

### 4-2. X Developer Console（アプリ: **X-analyzer-NiziUcci**）
User authentication settings で:
- 種類: Web App（Confidential client）
- Callback URI: `https://xxxx.trycloudflare.com/callback`
- Website URL: `https://xxxx.trycloudflare.com`
- スコープ: `tweet.read` `users.read` `space.read` `offline.access`
保存します。

### 4-3. .env を作る
フォルダ内に `.env` というファイルを作成:
```
X_CLIENT_ID=（Client ID）
X_CLIENT_SECRET=（Client Secret）
SESSION_SECRET=（ランダム文字列）
BASE_URL=https://xxxx.trycloudflare.com
```
SESSION_SECRET は `openssl rand -hex 32` で作れます。`.env` は他人に渡さないでください。

### 4-4. キー付きで起動
別のターミナルで:
```bash
./start.sh
```
（`.env` を読み込んで起動します。`npm start` だけでは .env は読まれません。）
`https://xxxx.trycloudflare.com` を開いて「Xでログイン」を試します。
