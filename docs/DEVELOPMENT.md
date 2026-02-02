# 開発ガイド

## セットアップ

### 必要な環境
- Node.js 20以上
- npm
- Docker & Docker Compose（オプション）

### ローカル環境でのセットアップ

```bash
# 依存関係をインストール
npm install

# 開発モードで実行
npm run dev

# ビルド
npm run build

# プロダクションモードで実行
npm start
```

### Docker環境でのセットアップ

```bash
# Dockerコンテナをビルド＆起動
docker-compose up --build

# バックグラウンドで実行
docker-compose up -d

# ログを確認
docker-compose logs -f

# 停止
docker-compose down
```

## コードスタイル

### TypeScriptの基本ルール
- strictモードを使用
- 型定義は明示的に行う
- any型の使用は避ける
- クラスベースのOOPスタイルを採用

### 命名規則
- クラス名: PascalCase (`Player`, `Game`)
- 関数名: camelCase (`makeStatement`, `nightAction`)
- 定数: UPPER_SNAKE_CASE (`MAX_PLAYERS`)
- Enum: PascalCase (`Role`, `Team`)
- インターフェース: PascalCase (`Statement`, `VoteRecord`)

## プロジェクト構造の拡張

### バックエンド追加時
```bash
# Laravelプロジェクト作成
composer create-project laravel/laravel backend
cd backend

# 必要なパッケージをインストール
composer require pusher/pusher-php-server
composer require predis/predis
```

### フロントエンド追加時
```bash
# Reactプロジェクト作成
npx create-react-app frontend --template typescript
cd frontend

# 必要なパッケージをインストール
npm install axios socket.io-client
npm install @types/socket.io-client --save-dev
```

## AI思考ロジックの拡張

### 基本的なAI戦略の追加

1. `player.ts`で各役職のメソッドを拡張
2. `ai-logic.ts`に共通ロジックを追加
3. 過去の発言ログや投票履歴を分析する関数を実装

### LLM統合の例

```typescript
import OpenAI from 'openai';

class AIPlayer extends Player {
  private openai: OpenAI;

  async makeStatement(day: number, alivePlayers: Player[]): Promise<string> {
    const prompt = this.buildPrompt(day, alivePlayers);
    
    const response = await this.openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'あなたは人狼ゲームのプレイヤーです。' },
        { role: 'user', content: prompt }
      ]
    });
    
    return response.choices[0].message.content || '';
  }

  private buildPrompt(day: number, alivePlayers: Player[]): string {
    // 発言ログ、投票履歴、自分の役職情報などを含むプロンプトを生成
    return `
      【状況】
      現在${day}日目です。
      生存者: ${alivePlayers.map(p => p.name).join(', ')}
      
      【あなたの役職】
      ${this.role}
      
      【過去の発言】
      ${this.statements.map(s => `${s.playerName}: ${s.content}`).join('\n')}
      
      【指示】
      この状況で適切な発言をしてください。
    `;
  }
}
```

## テストの追加

### ユニットテストのセットアップ

```bash
npm install --save-dev jest @types/jest ts-jest
```

`jest.config.js`を作成:
```javascript
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
};
```

### テストの例

```typescript
// tests/player.test.ts
import { Villager, Werewolf } from '../src/player';

describe('Player', () => {
  test('Villagerは村人陣営である', () => {
    const villager = new Villager(1, 'テスト村人');
    expect(villager.team).toBe(Team.VILLAGER);
  });

  test('Werewolfは人狼陣営である', () => {
    const werewolf = new Werewolf(2, 'テスト人狼');
    expect(werewolf.team).toBe(Team.WEREWOLF);
  });

  test('killメソッドでプレイヤーが死亡する', () => {
    const player = new Villager(1, 'テスト');
    player.kill();
    expect(player.isAlive()).toBe(false);
  });
});
```

## デバッグ

### ログ出力の追加

```typescript
// src/utils/logger.ts
export class Logger {
  static debug(message: string, data?: any) {
    if (process.env.DEBUG === 'true') {
      console.log(`[DEBUG] ${message}`, data || '');
    }
  }

  static info(message: string) {
    console.log(`[INFO] ${message}`);
  }

  static error(message: string, error?: Error) {
    console.error(`[ERROR] ${message}`, error || '');
  }
}
```

使用例:
```typescript
Logger.debug('投票処理開始', { day: this.day, voters: alivePlayers.length });
```

## パフォーマンス最適化

### ゲーム進行の高速化
- 非同期処理の活用
- 不要なログ出力の削減
- データ構造の最適化（Map、Setの活用）

### メモリ使用量の削減
- 古いログデータの削除
- 大量のゲーム実行時はメモリリークに注意

## トラブルシューティング

### よくある問題

1. **TypeScriptコンパイルエラー**
   ```bash
   # node_modulesとdistを削除して再インストール
   rm -rf node_modules dist
   npm install
   npm run build
   ```

2. **実行時エラー: Cannot find module**
   ```bash
   # ビルドが必要
   npm run build
   npm start
   ```

3. **Docker実行エラー**
   ```bash
   # コンテナとイメージを完全に削除して再ビルド
   docker-compose down -v
   docker-compose up --build
   ```

## コントリビューション

1. 機能追加やバグ修正を行う場合は、まずIssueを作成
2. ブランチを作成して作業
3. コミットメッセージは明確に
4. プルリクエストを作成

## ライセンス

MIT License
