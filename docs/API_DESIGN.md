# API設計書（今後の実装用）

## 概要
このドキュメントは、将来LaravelでAPIを実装する際の設計書です。

## ベースURL
```
http://localhost:8000/api
```

## エンドポイント

### 1. ゲーム管理

#### ゲーム作成
```http
POST /games
```

**リクエスト**
```json
{
  "player_count": 9,
  "roles": {
    "villager": 3,
    "werewolf": 2,
    "seer": 1,
    "medium": 1,
    "knight": 1,
    "madman": 1
  }
}
```

**レスポンス**
```json
{
  "id": 1,
  "status": "initialized",
  "current_day": 0,
  "players": [
    {
      "id": 1,
      "name": "プレイヤー1",
      "role": "villager",
      "team": "villager",
      "status": "alive"
    }
  ],
  "created_at": "2025-12-21T10:00:00Z"
}
```

#### ゲーム開始
```http
POST /games/{gameId}/start
```

**レスポンス**
```json
{
  "id": 1,
  "status": "in_progress",
  "current_day": 1,
  "phase": "day"
}
```

#### ゲーム状態取得
```http
GET /games/{gameId}
```

**レスポンス**
```json
{
  "id": 1,
  "status": "in_progress",
  "current_day": 2,
  "phase": "night",
  "players": [...],
  "alive_count": {
    "villager_team": 4,
    "werewolf_team": 2
  }
}
```

### 2. フェーズ進行

#### 昼フェーズ - 発言
```http
POST /games/{gameId}/days/{day}/statements
```

**リクエスト**
```json
{
  "player_id": 1,
  "content": "占い師です。プレイヤー3は人狼でした。"
}
```

**レスポンス**
```json
{
  "id": 1,
  "game_id": 1,
  "day": 2,
  "player_id": 1,
  "player_name": "プレイヤー1",
  "content": "占い師です。プレイヤー3は人狼でした。",
  "created_at": "2025-12-21T10:05:00Z"
}
```

#### 昼フェーズ - 投票
```http
POST /games/{gameId}/days/{day}/votes
```

**リクエスト**
```json
{
  "voter_id": 1,
  "target_id": 3
}
```

**レスポンス**
```json
{
  "id": 1,
  "game_id": 1,
  "day": 2,
  "voter_id": 1,
  "target_id": 3,
  "created_at": "2025-12-21T10:10:00Z"
}
```

#### 昼フェーズ - 処刑実行
```http
POST /games/{gameId}/days/{day}/execute
```

**レスポンス**
```json
{
  "executed_player_id": 3,
  "executed_player_name": "プレイヤー3",
  "role": "werewolf",
  "result": "werewolf eliminated"
}
```

#### 夜フェーズ - 行動
```http
POST /games/{gameId}/nights/{day}/actions
```

**リクエスト**
```json
{
  "player_id": 4,
  "action_type": "attack",
  "target_id": 5
}
```

**レスポンス**
```json
{
  "id": 1,
  "game_id": 1,
  "day": 2,
  "player_id": 4,
  "action_type": "attack",
  "target_id": 5,
  "result": "success",
  "created_at": "2025-12-21T10:15:00Z"
}
```

### 3. ログ取得

#### 発言ログ取得
```http
GET /games/{gameId}/statements?day={day}
```

**レスポンス**
```json
{
  "statements": [
    {
      "id": 1,
      "day": 2,
      "player_id": 1,
      "player_name": "プレイヤー1",
      "content": "占い師です。",
      "created_at": "2025-12-21T10:05:00Z"
    }
  ]
}
```

#### 投票履歴取得
```http
GET /games/{gameId}/votes?day={day}
```

**レスポンス**
```json
{
  "votes": [
    {
      "id": 1,
      "day": 2,
      "voter_id": 1,
      "voter_name": "プレイヤー1",
      "target_id": 3,
      "target_name": "プレイヤー3",
      "created_at": "2025-12-21T10:10:00Z"
    }
  ]
}
```

### 4. AI実行

#### AI自動進行
```http
POST /games/{gameId}/ai/execute
```

**リクエスト**
```json
{
  "phase": "day",
  "auto_progress": true
}
```

**レスポンス**
```json
{
  "phase": "day",
  "actions_taken": [
    {
      "player_id": 1,
      "action": "statement",
      "content": "占い師です。"
    },
    {
      "player_id": 1,
      "action": "vote",
      "target_id": 3
    }
  ],
  "next_phase": "night"
}
```

## WebSocket（リアルタイム更新）

### 接続
```
ws://localhost:8000/ws/games/{gameId}
```

### イベント

#### ゲーム状態更新
```json
{
  "event": "game_update",
  "data": {
    "current_day": 2,
    "phase": "night",
    "alive_players": 7
  }
}
```

#### 新しい発言
```json
{
  "event": "new_statement",
  "data": {
    "player_id": 1,
    "player_name": "プレイヤー1",
    "content": "占い師です。"
  }
}
```

#### 投票完了
```json
{
  "event": "vote_complete",
  "data": {
    "executed_player_id": 3,
    "executed_player_name": "プレイヤー3"
  }
}
```

#### ゲーム終了
```json
{
  "event": "game_end",
  "data": {
    "winner": "villager",
    "reason": "人狼を全て処刑しました",
    "final_day": 3
  }
}
```

## エラーレスポンス

```json
{
  "error": {
    "code": "INVALID_ACTION",
    "message": "このプレイヤーは既に死亡しています",
    "details": {
      "player_id": 3,
      "status": "dead"
    }
  }
}
```

### エラーコード一覧
- `GAME_NOT_FOUND`: ゲームが見つかりません
- `INVALID_PHASE`: 無効なフェーズです
- `PLAYER_DEAD`: プレイヤーは死亡しています
- `ALREADY_VOTED`: 既に投票済みです
- `INVALID_TARGET`: 無効なターゲットです
- `GAME_ALREADY_ENDED`: ゲームは既に終了しています
