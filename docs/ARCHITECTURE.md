# プロジェクト構造

```
werewolf-AI-prototype/
├── src/
│   ├── index.ts          # メインエントリーポイント
│   ├── types.ts          # 型定義とインターフェース
│   ├── player.ts         # プレイヤークラスと役職別クラス
│   ├── game.ts           # ゲーム進行管理クラス
│   └── ai-logic.ts       # AI思考ロジックユーティリティ
├── package.json          # パッケージ設定
├── tsconfig.json         # TypeScript設定
└── README.md             # プロジェクト概要
```

## アーキテクチャ設計

### 1. 型定義 (types.ts)
- ゲームで使用する全ての型、Enum、インターフェースを定義
- `Role`: 役職（村人、人狼、占い師、霊媒師、騎士、狂人）
- `Team`: 陣営（村人陣営、人狼陣営）
- `PlayerStatus`: プレイヤー状態（生存、死亡）
- `Phase`: ゲームフェーズ（昼、夜）
- 各種レコード型（発言、投票、占い結果など）

### 2. プレイヤークラス (player.ts)
- **基底クラス `Player`**
  - 全役職共通のプロパティとメソッド
  - 抽象メソッド: `makeStatement()`, `vote()`, `nightAction()`
  
- **役職別クラス**
  - `Villager`: 村人（能力なし）
  - `Werewolf`: 人狼（夜に襲撃）
  - `Seer`: 占い師（夜に占い）
  - `Medium`: 霊媒師（処刑者の正体を知る）
  - `Knight`: 騎士（夜に護衛）
  - `Madman`: 狂人（人狼陣営だが能力なし）

### 3. ゲーム管理 (game.ts)
- **`Game`クラス**
  - ゲーム全体の進行を管理
  - プレイヤー管理、フェーズ管理
  - 昼フェーズ処理（発言→投票→処刑）
  - 夜フェーズ処理（襲撃、占い、護衛）
  - 勝利条件判定

### 4. AI思考ロジック (ai-logic.ts)
- 各AIが意思決定する際の補助ユーティリティ
- 疑わしさスコアの計算
- 重み付きランダム選択
- 発言分析機能

## データフロー

```
1. ゲーム初期化
   └→ プレイヤー作成（役職をランダムに割り当て）

2. 各日のループ
   ├→ 昼フェーズ
   │   ├→ 全プレイヤーが発言
   │   ├→ 全プレイヤーが投票
   │   └→ 最多得票者を処刑
   │
   ├→ 勝利判定
   │
   ├→ 夜フェーズ
   │   ├→ 人狼が襲撃
   │   ├→ 騎士が護衛
   │   ├→ 占い師が占い
   │   └→ 霊媒師に情報付与
   │
   └→ 勝利判定

3. ゲーム終了
   └→ 結果表示
```

## 拡張ポイント

### 現状の実装レベル
- ✅ 基本的なゲーム進行ロジック
- ✅ 9人プレイヤー、6役職
- ✅ 昼夜フェーズ
- ✅ 発言、投票、夜行動
- ✅ 勝利条件判定
- ⚠️ AI思考：簡易的なランダム選択

### 今後の拡張可能性

#### 1. AI思考の高度化
- LLM（GPT-4, Claude等）を統合して発言生成
- 過去の発言ログから推論
- 投票傾向の分析
- 役職ごとの戦略パターン実装

#### 2. バックエンド実装（Laravel）
```
api/
├── app/
│   ├── Models/
│   │   ├── Game.php
│   │   ├── Player.php
│   │   └── GameLog.php
│   ├── Http/
│   │   └── Controllers/
│   │       └── GameController.php
│   └── Services/
│       └── WerewolfGameService.php
```

#### 3. フロントエンド実装（React + TypeScript）
```
frontend/
├── src/
│   ├── components/
│   │   ├── GameBoard.tsx
│   │   ├── PlayerCard.tsx
│   │   ├── ChatLog.tsx
│   │   └── VotePanel.tsx
│   ├── hooks/
│   │   └── useGameState.ts
│   └── types/
│       └── game.types.ts
```

#### 4. データベース設計（MySQL）
```sql
-- ゲームテーブル
games (id, status, current_day, winner, created_at, updated_at)

-- プレイヤーテーブル
players (id, game_id, name, role, team, status, created_at)

-- 発言ログテーブル
statements (id, game_id, player_id, day, content, created_at)

-- 投票記録テーブル
votes (id, game_id, day, voter_id, target_id, created_at)

-- 夜行動記録テーブル
night_actions (id, game_id, day, player_id, action_type, target_id, result, created_at)
```

#### 5. Docker構成
```yaml
version: '3.8'
services:
  frontend:
    build: ./frontend
    ports:
      - "3000:3000"
  backend:
    build: ./backend
    ports:
      - "8000:8000"
  db:
    image: mysql:8.0
    environment:
      MYSQL_DATABASE: werewolf
      MYSQL_ROOT_PASSWORD: password
```

## 実装の優先順位

### Phase 1: コンソール版完成 ✅
- [x] 基本ロジック実装
- [x] 全役職の実装
- [x] ゲーム進行フロー

### Phase 2: AI思考の改善
- [ ] より戦略的な投票ロジック
- [ ] 役職に応じた発言パターン
- [ ] LLM統合（オプション）

### Phase 3: API化
- [ ] Laravel バックエンド実装
- [ ] RESTful API設計
- [ ] WebSocket対応（リアルタイム更新）

### Phase 4: フロントエンド
- [ ] React UI実装
- [ ] リアルタイムゲーム表示
- [ ] ログビューア

### Phase 5: データ永続化
- [ ] MySQL統合
- [ ] ゲーム履歴機能
- [ ] 統計情報表示
