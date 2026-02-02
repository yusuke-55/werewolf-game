# Node.js用のDockerfile（現在のコンソール版）
FROM node:20-alpine

WORKDIR /app

# package.jsonとpackage-lock.jsonをコピー
COPY package*.json ./

# 依存関係をインストール
RUN npm ci --ignore-scripts

# ソースコードをコピー
COPY . .

# TypeScriptをビルド
RUN npm run build

# アプリケーション実行
CMD ["npm", "start"]
