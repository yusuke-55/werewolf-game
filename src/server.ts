import express, { Request, Response } from 'express';
import path from 'path';
import { Game } from './game';
import { Role } from './types';
import { UserPlayer } from './userPlayer';

// Reduce noisy console output but keep warnings/errors visible for debugging.
// Only silence debug-level output; keep `console.log`/`console.info` enabled so trace logs appear.
try { (console as any)['debug'] = () => {}; } catch (e) { /* ignore */ }

// Suppress noisy conversation logs (emitPlayerStatement) from flooding server stdout.
// This filters specific console.log lines related to player statements while keeping other logs.
try {
  const _origLog = console.log.bind(console);
  console.log = (...args: any[]) => {
    try {
      const s = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      // filter lines that indicate player statement emission
      if (s.includes('[emitPlayerStatement]')) return;
    } catch (e) {
      // if any error during filtering, fall back to original
    }
    _origLog(...args);
  };
} catch (e) { /* ignore */ }

const app = express();
const PORT = Number(process.env.PORT) || 3002;

// JSONパース用ミドルウェア
app.use(express.json());

// 静的ファイルの配信
app.use(express.static(path.join(__dirname, '../public')));
app.use('/images', express.static(path.join(__dirname, '../image')));

// グローバルなゲームインスタンスとクライアント管理
let currentGame: any = null;
const clients: Response[] = [];
// サーバ側で保持するCO一覧（player_co イベントを集計）
const serverCOs: Array<any> = [];
// memo snapshot to detect updates: playerId -> JSON string of memo fields
const playerMemoSnapshot: Map<number, string> = new Map();

function serverLog(line: string) {
  try { process.stdout.write(String(line) + '\n'); } catch (e) { /* ignore */ }
}

/**
 * SSE (Server-Sent Events) エンドポイント
 */
app.get('/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // クライアントを登録
  clients.push(res);

  // 初期状態を送信
  res.write(`event: connected\ndata: ${JSON.stringify({ status: 'ready' })}\n\n`);

  // クライアント切断時の処理
  req.on('close', () => {
    const index = clients.indexOf(res);
    if (index !== -1) {
      clients.splice(index, 1);
    }
    // 全クライアントが切断されたらゲームをクリーンアップ
    if (clients.length === 0 && currentGame) {
      currentGame.cleanup();
      currentGame = null;
    }
  });
});

/**
 * 全クライアントにイベントを送信
 */
function broadcastEvent(event: string, data: any) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(client => {
    try {
      client.write(message);
      // 起動時フリーズ対策: 全イベントのrawコピーを送るとメッセージ量が増え、
      // クライアント側のデバッグログ等で固まりやすい。
      // 必要な場合のみ `SSE_RAW_COPY=1` で有効化する。
      if (process.env.SSE_RAW_COPY === '1') {
        const raw = `data: ${JSON.stringify({ event, data })}\n\n`;
        client.write(raw);
      }
    } catch (e) {
      // ignore write errors per-client
    }
  });
}


/**
 * ゲーム開始エンドポイント
 */
app.post('/api/start', async (req: Request, res: Response) => {
  // 既に実行中のゲームがあれば強制的にリセット
  if (currentGame) {
    currentGame.cleanup();
    currentGame = null;
  }

  try {
    // フロントエンドからユーザー名・アイコンを受け取る
    const { userName, userIcon } = req.body || {};
    const forced = process.env.FORCE_FORMATION && ['2-1','2-2','3-1'].includes(process.env.FORCE_FORMATION) ? (process.env.FORCE_FORMATION as '2-1'|'2-2'|'3-1') : undefined;
    currentGame = new Game({ userName, userIcon, forcedFormation: forced });

    // イベントリスナーを設定
    currentGame.eventEmitter.on('log', (data: any) => {
      broadcastEvent('log', data);
    });

    currentGame.eventEmitter.on('role_assignment', (data: any) => {
      broadcastEvent('role_assignment', data);
    });

    currentGame.eventEmitter.on('user_role_assignment', (data: any) => {
      broadcastEvent('user_role_assignment', data);
    });

    currentGame.eventEmitter.on('day_start', (data: any) => {
      broadcastEvent('day_start', data);
    });

    currentGame.eventEmitter.on('phase_change', (data: any) => {
      broadcastEvent('phase_change', data);
    });

    currentGame.eventEmitter.on('day_timer_start', (data: any) => {
      broadcastEvent('day_timer_start', data);
    });

    currentGame.eventEmitter.on('day_timer_update', (data: any) => {
      broadcastEvent('day_timer_update', data);
    });

    currentGame.eventEmitter.on('voting_phase_start', (data: any) => {
      broadcastEvent('voting_phase_start', data);
    });

    currentGame.eventEmitter.on('voting_timer_update', (data: any) => {
      broadcastEvent('voting_timer_update', data);
    });

    currentGame.eventEmitter.on('player_operation_phase', (data: any) => {
      broadcastEvent('player_operation_phase', data);
    });

    currentGame.eventEmitter.on('proceed_to_voting', (data: any) => {
      broadcastEvent('proceed_to_voting', data);
    });

    // short visual cue for voting animation
    currentGame.eventEmitter.on('voting_animation', (data: any) => {
      broadcastEvent('voting_animation', data);
    });

    currentGame.eventEmitter.on('statement', (data: any) => {
      broadcastEvent('statement', data);
    });

    // Auto-stop: cleanup server-side game instance and notify clients
    currentGame.eventEmitter.on('auto_stop', () => {
      try {
        broadcastEvent('game_stopped', { reason: 'auto_stop_day2' });
      } catch (e) {}
      try {
        currentGame?.cleanup();
      } catch (e) {}
      currentGame = null;
      serverLog('[AUTO STOP] Game cleaned up after Day 2');
    });

    currentGame.eventEmitter.on('vote', (data: any) => {
      broadcastEvent('vote', data);
    });

    currentGame.eventEmitter.on('execution', (data: any) => {
      broadcastEvent('execution', data);
    });

    currentGame.eventEmitter.on('attack_success', (data: any) => {
      broadcastEvent('attack_success', data);
    });

    currentGame.eventEmitter.on('guard_success', (data: any) => {
      broadcastEvent('guard_success', data);
    });

    currentGame.eventEmitter.on('divination', (data: any) => {
      broadcastEvent('divination', data);
    });

    // Per-CO immediate result reveal for results panel
    currentGame.eventEmitter.on('player_result', (data: any) => {
      broadcastEvent('player_result', data);
    });

    currentGame.eventEmitter.on('mayor_action_rejected', (data: any) => {
      broadcastEvent('mayor_action_rejected', data);
    });

    currentGame.eventEmitter.on('user_death', (data: any) => {
      broadcastEvent('user_death', data);
    });

    currentGame.eventEmitter.on('player_co', (data: any) => {
      broadcastEvent('player_co', data);
    });

    currentGame.eventEmitter.on('gm_message', (data: any) => {
      broadcastEvent('gm_message', data);
    });

    // endgame: flashy victory/defeat overlay
    currentGame.eventEmitter.on('end_effect', (data: any) => {
      broadcastEvent('end_effect', data);
    });

    // endgame: show big "play again" button + reset command UI
    currentGame.eventEmitter.on('show_play_again', (data: any) => {
      broadcastEvent('show_play_again', data);
    });

    // サーバログ: 配役一覧を出力
    currentGame.eventEmitter.on('role_assignment', (data: any) => {
      try {
        serverLog('【配役一覧】');
        const players = data.players || [];
        for (const p of players) {
          const role = p.role || (p as any).role || 'UNKNOWN';
          const displayName = p.name || p.playerName || '';
          serverLog(`${displayName}（ID:${p.id}）: ${role}`);
          // Try to print memos attached to the player instance if available on the server-side Game
          try {
            const playerObj = (currentGame as any).getPlayerById ? (currentGame as any).getPlayerById(p.id) : null;
            if (playerObj) {
              const notes: string[] = [];
              if ((playerObj as any).divinationResults) notes.push(`divinationResults=${JSON.stringify((playerObj as any).divinationResults)}`);
                if ((playerObj as any).mediumResults) notes.push(`mediumResults=${JSON.stringify((playerObj as any).mediumResults)}`);
                if ((playerObj as any).fakeMediumResults) notes.push(`fakeMediumResults=${JSON.stringify((playerObj as any).fakeMediumResults)}`);
              if ((playerObj as any).fakeDivinationResults) notes.push(`fakeDivinationResults=${JSON.stringify((playerObj as any).fakeDivinationResults)}`);
              if ((playerObj as any).nightActionHistory) notes.push(`nightActionHistory=${JSON.stringify((playerObj as any).nightActionHistory)}`);
              if ((playerObj as any).guardHistory) notes.push(`guardHistory=${JSON.stringify((playerObj as any).guardHistory)}`);
              if ((playerObj as any).attackHistory) notes.push(`attackHistory=${JSON.stringify((playerObj as any).attackHistory)}`);
              if ((playerObj as any).confirmedWhite) notes.push(`confirmedWhite=${(playerObj as any).confirmedWhite}`);
              if ((playerObj as any).confirmedBlack) notes.push(`confirmedBlack=${(playerObj as any).confirmedBlack}`);
              for (const n of notes) serverLog(`  - ${n}`);
            }
          } catch (e) { /* ignore per-player note retrieval errors */ }
        }
      } catch (e) { /* ignore */ }
    });

    // サーバログ: COイベントを集計して表示
    currentGame.eventEmitter.on('player_co', (data: any) => {
      try {
        serverCOs.push(data);
        const roleStr = data.claimedRole || data.claimedRole === 0 ? data.claimedRole : '';
        serverLog(`[CO] ${data.playerName || data.playerId} (id:${data.playerId}) claimed:${roleStr} ${data.isFake ? '(fake)' : ''}`);
        if (data.note) {
          serverLog(`  note: ${data.note}`);
        }
      } catch (e) { /* ignore */ }
    });

    // Helper: print per-player memos when they changed
    const emitUpdatedMemos = () => {
      try {
        if (!currentGame) return;
        for (const p of (currentGame as any).players || []) {
          try {
            const pid = p.id;
            const memos: any = {};
            if ((p as any).divinationResults && (p as any).divinationResults.length) memos.divinationResults = (p as any).divinationResults;
            if ((p as any).mediumResults && (p as any).mediumResults.length) memos.mediumResults = (p as any).mediumResults;
            if ((p as any).fakeMediumResults && (p as any).fakeMediumResults.length) memos.fakeMediumResults = (p as any).fakeMediumResults;
            if ((p as any).fakeDivinationResults && (p as any).fakeDivinationResults.length) memos.fakeDivinationResults = (p as any).fakeDivinationResults;
            if ((p as any).nightActionHistory && (p as any).nightActionHistory.length) memos.nightActionHistory = (p as any).nightActionHistory;
            if ((p as any).guardHistory && (p as any).guardHistory.length) memos.guardHistory = (p as any).guardHistory;
            if ((p as any).attackHistory && (p as any).attackHistory.length) memos.attackHistory = (p as any).attackHistory;
            if (typeof (p as any).confirmedWhite !== 'undefined') memos.confirmedWhite = (p as any).confirmedWhite;
            if (typeof (p as any).confirmedBlack !== 'undefined') memos.confirmedBlack = (p as any).confirmedBlack;
            const snap = JSON.stringify(memos || {});
            const prev = playerMemoSnapshot.get(pid) || '';
            if (snap !== prev) {
              // updated
              playerMemoSnapshot.set(pid, snap);
              const disp = p.getDisplayName ? p.getDisplayName() : (p.name || `id:${pid}`);
              serverLog(`【MEMO UPDATE】 ${disp}（ID:${pid}）`);
              const notes: string[] = [];
              if (memos.divinationResults) notes.push(`divinationResults=${JSON.stringify(memos.divinationResults)}`);
              if (memos.mediumResults) notes.push(`mediumResults=${JSON.stringify(memos.mediumResults)}`);
              if (memos.fakeDivinationResults) notes.push(`fakeDivinationResults=${JSON.stringify(memos.fakeDivinationResults)}`);
              if (memos.nightActionHistory) {
                notes.push(`nightActionHistory=${JSON.stringify(memos.nightActionHistory)}`);
                // If this player is a seer CO (real or fake), also print the latest selected variable for quick reference
                try {
                  const state = (currentGame as any).getGameState ? (currentGame as any).getGameState() : null;
                  const isSeerCO = Array.isArray(state?.day1State?.coPlayers) && state.day1State.coPlayers.some((c: any) => c.playerId === pid && c.claimedRole === 'SEER');
                  if (isSeerCO) {
                    const last = (memos.nightActionHistory as any[]).slice(-1)[0];
                    if (last && typeof last.variable === 'string') {
                      notes.push(`  nightAction_variable=${last.variable} (day=${last.day} targetId=${last.targetId})`);
                    }
                  }
                } catch (e) { /* ignore */ }
              }
              if (memos.guardHistory) notes.push(`guardHistory=${JSON.stringify(memos.guardHistory)}`);
              if (memos.attackHistory) notes.push(`attackHistory=${JSON.stringify(memos.attackHistory)}`);
              if (typeof memos.confirmedWhite !== 'undefined') notes.push(`confirmedWhite=${memos.confirmedWhite}`);
              if (typeof memos.confirmedBlack !== 'undefined') notes.push(`confirmedBlack=${memos.confirmedBlack}`);
              for (const n of notes) serverLog(`  - ${n}`);
            }
          } catch (e) { /* per-player ignore */ }
        }
      } catch (e) { /* ignore whole */ }
    };

    // Attach emitUpdatedMemos to events likely to change memos
    ['divination','guard_success','attack_success','player_co','day_start','execution','user_death','statement','night_action_request'].forEach(ev => {
      currentGame!.eventEmitter.on(ev as any, () => {
        try { emitUpdatedMemos(); } catch (e) { /* ignore */ }
      });
    });

    currentGame.eventEmitter.on('night_action_request', (data: any) => {
      broadcastEvent('night_action_request', data);
    });

    currentGame.eventEmitter.on('game_end', (data: any) => {
      broadcastEvent('game_end', data);
      // ゲーム終了後にクリーンアップしてリセット
      setTimeout(() => {
        if (currentGame) {
          try { currentGame.cleanup(); } catch (e) {}
        }
        currentGame = null;
      }, 1000);
    });

    // 停止・再開通知（UI切り替え用）
    currentGame.eventEmitter.on('paused', (data: any) => {
      broadcastEvent('paused', data);
    });
    currentGame.eventEmitter.on('resumed', (data: any) => {
      broadcastEvent('resumed', data);
    });

    // レスポンスを先に返す
    res.json({ message: 'ゲームを開始しました' });
    // クライアントがEventSourceに接続するまで待つ（最大3秒）
    try {
      const waitStart = Date.now();
      while (clients.length === 0 && Date.now() - waitStart < 3000) {
        // small sleep
        await new Promise(r => setTimeout(r, 100));
      }
      if (clients.length === 0) console.log('[Server] No SSE clients connected within timeout; starting game anyway');
      else console.log(`[Server] ${clients.length} SSE client(s) connected; starting game`);
    } catch (e) {
      // ignore
    }
    // ゲーム開始
    // 非同期でゲーム実行（initialize()はrun()の中で呼ばれる）
    currentGame.run().catch((error: any) => {
      console.error('ゲームエラー:', error);
      broadcastEvent('error', { message: error && error.message ? error.message : String(error) });
      currentGame = null;
    });

    // game started
  } catch (error: any) {
    console.error('エラー:', error);
    res.status(500).json({ error: error.message });
    currentGame = null;
  }
});

/**
 * ゲーム状態取得エンドポイント
 */
app.get('/api/status', (_req: Request, res: Response) => {
  if (currentGame) {
    res.json({ 
      running: true,
      state: typeof (currentGame as any).getGameState === 'function' ? (currentGame as any).getGameState() : null,
    });
  } else {
    res.json({ running: false });
  }
});

/**
 * ゲームリセットエンドポイント
 */
app.post('/api/reset', (_req: Request, res: Response) => {
  if (currentGame) {
    currentGame.cleanup();
  }
  currentGame = null;
  res.json({ message: 'ゲームをリセットしました' });
});

/**
 * スキップエンドポイント（フェーズスキップ）
 */
app.post('/api/skip', (_req: Request, res: Response) => {
  if (!currentGame) {
    res.status(400).json({ error: 'ゲームが実行されていません' });
    return;
  }

  // タイマーを0にしてフェーズをスキップ
  currentGame.skipPhase();
  res.json({ message: 'フェーズをスキップしました' });
});

/**
 * ストップエンドポイント（AI発言停止）
 */
app.post('/api/stop', (_req: Request, res: Response) => {
  if (!currentGame) {
    res.status(400).json({ error: 'ゲームが実行されていません' });
    return;
  }

  // AI発言を停止（タイマーは継続）
  currentGame.stopPhase();
  res.json({ message: 'AI発言を停止しました' });
});

/**
 * 村長が「投票」ボタンを押したときに呼ぶエンドポイント
 */
app.post('/api/proceed_to_voting', (_req: Request, res: Response) => {
  if (!currentGame) {
    res.status(400).json({ error: 'ゲームが実行されていません' });
    return;
  }
  try {
    if (typeof (currentGame as any).proceedToVoting === 'function') {
      (currentGame as any).proceedToVoting();
    }
    res.json({ message: '投票フェーズ開始を通知しました' });
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'internal error' });
  }
});

/**
 * 村長操作: 特定役職をCOさせる
 * body: { role: 'SEER'|'MEDIUM'|'KNIGHT' }
 */
app.post('/api/operation/co', (req: Request, res: Response) => {
  if (!currentGame) return res.status(400).json({ error: 'ゲームが実行されていません' });
  const { role } = req.body || {};
  try {
    if (typeof (currentGame as any).forceCO === 'function') {
      (currentGame as any).forceCO(role);
      return res.json({ message: 'CO指示を送信しました' });
    }
    res.status(500).json({ error: 'ゲームで CO を処理できません' });
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'internal error' });
  }
});

/**
 * 村長操作: 指定先を決める
 * body: { type: 'vote'|'divination'|'guard', targetId: number }
 */
app.post('/api/operation/designate', (req: Request, res: Response) => {
  if (!currentGame) return res.status(400).json({ error: 'ゲームが実行されていません' });
  const { type, targetId } = req.body || {};
  try {
    if (typeof (currentGame as any).setDesignate === 'function') {
      // Do not emit a duplicate mayor order here.
      // The UI posts the user line via /api/statement (which now has a reliable fallback
      // to emit 'statement' even without a UserPlayer), so emitting again would duplicate.
      ;(currentGame as any).setDesignate(type, targetId);
      return res.json({ message: '指定先を設定しました' });
    }
    res.status(500).json({ error: 'ゲームで designate を処理できません' });
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'internal error' });
  }
});

/**
 * 指定: 役職を指定してランダム決定（役職ベース）
 * body: { role: 'SEER'|'MEDIUM', type?: 'vote'|'guard' }
 */
app.post('/api/operation/designate_role', (req: Request, res: Response) => {
  if (!currentGame) return res.status(400).json({ error: 'ゲームが実行されていません' });
  const { role, type } = req.body || {};
  try {
    const alive: any[] = typeof (currentGame as any).getAlivePlayers === 'function' ? (currentGame as any).getAlivePlayers() : [];
    if (!alive || alive.length === 0) return res.status(400).json({ error: '生存プレイヤーがいません' });
    const targetRole = role === 'SEER' ? Role.SEER : role === 'MEDIUM' ? Role.MEDIUM : null;
    if (!targetRole) return res.status(400).json({ error: '無効な役職です' });
    const candidates = alive.filter(p => p.role === targetRole && p.isAlive() && !(p instanceof UserPlayer));
    if (candidates.length === 0) return res.status(400).json({ error: '該当役職の生存者がいません' });
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    if (typeof (currentGame as any).setDesignate === 'function') {
      const designateType = type === 'guard' ? 'guard' : 'vote';
      ;(currentGame as any).setDesignate(designateType, pick.id);
      return res.json({ message: '指定先を設定しました', targetId: pick.id, type: designateType });
    }
    res.status(500).json({ error: 'ゲームで designate を処理できません' });
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'internal error' });
  }
});

/**
 * 指定: ランダム指定（type に応じて投票/護衛）
 * body: { type: 'vote'|'guard' }
 */
app.post('/api/operation/designate_random', (req: Request, res: Response) => {
  if (!currentGame) return res.status(400).json({ error: 'ゲームが実行されていません' });
  const { type } = req.body || {};
  try {
    const alive: any[] = typeof (currentGame as any).getAlivePlayers === 'function' ? (currentGame as any).getAlivePlayers() : [];
    if (!alive || alive.length === 0) return res.status(400).json({ error: '生存プレイヤーがいません' });
    const candidates = alive.filter(p => p.isAlive() && !(p instanceof UserPlayer));
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    const designateType = type === 'guard' ? 'guard' : 'vote';
    if (typeof (currentGame as any).setDesignate === 'function') {
      ;(currentGame as any).setDesignate(designateType, pick.id);
      return res.json({ message: 'ランダムに指定しました', targetId: pick.id, type: designateType });
    }
    res.status(500).json({ error: 'ゲームで designate を処理できません' });
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'internal error' });
  }
});

/**
 * 指定: 占い師向けに役職ベースでランダム占い先を設定
 * body: { seerId: number, role: 'SEER'|'MEDIUM' }
 */
app.post('/api/operation/designate_divination_role', (req: Request, res: Response) => {
  if (!currentGame) return res.status(400).json({ error: 'ゲームが実行されていません' });
  const { seerId, role } = req.body || {};
  try {
    if (typeof seerId !== 'number') return res.status(400).json({ error: 'seerId が必要です' });
    const alive: any[] = typeof (currentGame as any).getAlivePlayers === 'function' ? (currentGame as any).getAlivePlayers() : [];
    const targetRole = role === 'SEER' ? Role.SEER : role === 'MEDIUM' ? Role.MEDIUM : null;
    if (!targetRole) return res.status(400).json({ error: '無効な役職です' });
    const candidates = alive.filter(p => p.isAlive() && p.role === targetRole && p.id !== seerId && !(p instanceof UserPlayer));
    if (candidates.length === 0) return res.status(400).json({ error: '該当役職の生存者がいません' });
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    const getPlayerById = (currentGame as any).getPlayerById;
    if (typeof getPlayerById !== 'function') return res.status(500).json({ error: 'ゲームからプレイヤーを取得できません' });
    const seer = getPlayerById.call(currentGame, seerId);
    if (!seer) return res.status(400).json({ error: '該当する占い師が見つかりません' });
    if (typeof (currentGame as any).setDesignateDivinationForSeer === 'function') {
      (currentGame as any).setDesignateDivinationForSeer(seerId, pick.id);
    } else {
      (seer as any).nextDesignateDivination = pick.id;
      try { currentGame.eventEmitter.emit('designate_set', { type: 'divination', seerId, targetId: pick.id }); } catch (e) {}
    }
    return res.json({ message: '占い先をランダム設定しました', seerId, targetId: pick.id });
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'internal error' });
  }
});

/**
 * 指定: 占い師にランダム占い先を設定
 * body: { seerId: number }
 */
app.post('/api/operation/designate_divination_random', (req: Request, res: Response) => {
  if (!currentGame) return res.status(400).json({ error: 'ゲームが実行されていません' });
  const { seerId } = req.body || {};
  try {
    if (typeof seerId !== 'number') return res.status(400).json({ error: 'seerId が必要です' });
    const alive: any[] = typeof (currentGame as any).getAlivePlayers === 'function' ? (currentGame as any).getAlivePlayers() : [];
    const candidates = alive.filter(p => p.isAlive() && p.id !== seerId && !(p instanceof UserPlayer));
    if (candidates.length === 0) return res.status(400).json({ error: '該当するプレイヤーがいません' });
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    const getPlayerById = (currentGame as any).getPlayerById;
    if (typeof getPlayerById !== 'function') return res.status(500).json({ error: 'ゲームからプレイヤーを取得できません' });
    const seer = getPlayerById.call(currentGame, seerId);
    if (!seer) return res.status(400).json({ error: '該当する占い師が見つかりません' });
    if (typeof (currentGame as any).setDesignateDivinationForSeer === 'function') {
      (currentGame as any).setDesignateDivinationForSeer(seerId, pick.id);
    } else {
      (seer as any).nextDesignateDivination = pick.id;
      try { currentGame.eventEmitter.emit('designate_set', { type: 'divination', seerId, targetId: pick.id }); } catch (e) {}
    }
    return res.json({ message: '占い先をランダム設定しました', seerId, targetId: pick.id });
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'internal error' });
  }
});

/**
 * 指定: 特定の占い師へ占い対象を指定する
 * body: { seerId: number, targetId: number }
 */
app.post('/api/operation/designate_divination', (req: Request, res: Response) => {
  if (!currentGame) return res.status(400).json({ error: 'ゲームが実行されていません' });
  const { seerId, targetId } = req.body || {};
  try {
    if (typeof seerId !== 'number') return res.status(400).json({ error: 'seerId が必要です' });
    const getPlayerById = (currentGame as any).getPlayerById;
    if (typeof getPlayerById !== 'function') return res.status(500).json({ error: 'ゲームからプレイヤーを取得できません' });
    const seer = getPlayerById.call(currentGame, seerId);
    if (!seer) return res.status(400).json({ error: '該当する占い師が見つかりません' });
    if (typeof (currentGame as any).setDesignateDivinationForSeer === 'function') {
      (currentGame as any).setDesignateDivinationForSeer(seerId, targetId ?? null);
    } else {
      (seer as any).nextDesignateDivination = targetId ?? null;
      try { currentGame.eventEmitter.emit('designate_set', { type: 'divination', seerId, targetId }); } catch (e) {}
    }
    return res.json({ message: '占い先を指定しました', seerId, targetId });
  } catch (e: any) {
    return res.status(500).json({ error: e.message || 'internal error' });
  }
});

/**
 * 村長操作: 個別に質問
 * body: { targetId: number, questionKey: string }
 */
app.post('/api/operation/question', (req: Request, res: Response) => {
  if (!currentGame) return res.status(400).json({ error: 'ゲームが実行されていません' });
  const { targetId, questionKey } = req.body || {};
  try {
    if (typeof (currentGame as any).askIndividualQuestion === 'function') {
      (currentGame as any).askIndividualQuestion(targetId, questionKey);
      return res.json({ message: '質問を送信しました' });
    }
    res.status(500).json({ error: 'ゲームで質問を処理できません' });
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'internal error' });
  }
});

/**
 * 村長操作: 皆の怪しい人を聞く（会話フェーズへ移行）
 */
app.post('/api/operation/ask_suspicious', (_req: Request, res: Response) => {
  if (!currentGame) return res.status(400).json({ error: 'ゲームが実行されていません' });
  try {
    if (typeof (currentGame as any).askEveryoneSuspicious === 'function') {
      (currentGame as any).askEveryoneSuspicious();
      return res.json({ message: '皆の怪しい人を問いました' });
    }
    res.status(500).json({ error: 'ゲームで処理できません' });
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'internal error' });
  }
});

/**
 * 再開エンドポイント（停止状態から続行）
 */
app.post('/api/resume', (_req: Request, res: Response) => {
  if (!currentGame) {
    res.status(400).json({ error: 'ゲームが実行されていません' });
    return;
  }
  currentGame.resumePhase();
  res.json({ message: 'ゲームを再開しました' });
});

/**
 * ユーザー発言エンドポイント
 */
app.post('/api/statement', async (req: Request, res: Response) => {
  if (!currentGame) {
    res.status(400).json({ error: 'ゲームが実行されていません' });
    return;
  }

  const { playerId, content } = req.body;
  const pid = Number(playerId);
  const text = typeof content === 'string' ? content : String(content ?? '');

  // NOTE: playerId can be 0 in this project. Do not use falsy-checks.
  if (!Number.isFinite(pid) || text.trim().length === 0) {
    res.status(400).json({ error: 'playerId と content が必要です' });
    return;
  }

  // Prefer the in-game handler when available (enables AI reactions etc).
  // However this project can run without an actual UserPlayer in players[],
  // so we fall back to emitting a statement event directly for UI display.
  let handledByGame = false;
  try {
    if (typeof (currentGame as any).handleUserStatement === 'function') {
      handledByGame = await (currentGame as any).handleUserStatement(pid, text);
    }
  } catch (e) {
    handledByGame = false;
  }

  if (!handledByGame) {
    try {
      const state = typeof (currentGame as any).getGameState === 'function' ? (currentGame as any).getGameState() : null;
      const day = (state && typeof state.day === 'number') ? state.day : ((currentGame as any).day ?? 1);
      (currentGame as any).eventEmitter?.emit?.('statement', {
        day,
        playerId: pid,
        playerName: 'あなた',
        content: text,
      });
    } catch (e) {
      // ignore last-resort errors
    }
  }

  res.json({ message: '発言しました', handledByGame });
});

/**
 * ユーザー投票エンドポイント
 */
app.post('/api/vote', (req: Request, res: Response) => {
  if (!currentGame) {
    res.status(400).json({ error: 'ゲームが実行されていません' });
    return;
  }

  const { playerId, targetId } = req.body;

  const pid = Number(playerId);
  const tid = Number(targetId);
  // NOTE: playerId can be 0 in this project. Do not use falsy-checks.
  if (!Number.isFinite(pid) || !Number.isFinite(tid)) {
    res.status(400).json({ error: 'playerId と targetId が必要です' });
    return;
  }

  const success = currentGame.handleUserVote(pid, tid);
  
  if (success) {
    res.json({ message: '投票しました' });
  } else {
    res.status(400).json({ error: '投票できません' });
  }
});

/**
 * ユーザー夜行動エンドポイント
 */
app.post('/api/night-action', (req: Request, res: Response) => {
  if (!currentGame) {
    res.status(400).json({ error: 'ゲームが実行されていません' });
    return;
  }

  const { playerId, targetId } = req.body;

  const pid = Number(playerId);
  const tid = Number(targetId);
  // NOTE: playerId can be 0 in this project. Do not use falsy-checks.
  if (!Number.isFinite(pid) || !Number.isFinite(tid)) {
    res.status(400).json({ error: 'playerId と targetId が必要です' });
    return;
  }

  const success = currentGame.handleUserNightAction(pid, tid);
  
  if (success) {
    res.json({ message: '夜行動を選択しました' });
  } else {
    res.status(400).json({ error: '夜行動を選択できません' });
  }
});

/**
 * ルートエンドポイント
 */
app.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Set global handlers early
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

// サーバー起動（ポート競合時は代替ポートで再試行）
const startServerOn = (port: number) => {
  const server = app.listen(port, () => {
    const actualPort = (server.address() as any)?.port || port;
    const url = `http://localhost:${actualPort}`;
    console.log(`Server listening on ${url}`);
    // Auto-open browser is convenient for manual dev, but noisy for E2E/tests.
    // Disable via AUTO_OPEN_BROWSER=0 or CI=1.
    if (process.env.AUTO_OPEN_BROWSER !== '0' && process.env.CI !== '1') {
      try {
        const { exec } = require('child_process');
        const startCmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
        exec(startCmd, (err: any) => {
          if (err) console.error('Failed to open browser automatically:', err);
        });
      } catch (e) {
        console.error('Auto-open browser error:', e);
      }
    }
  });

  server.on('error', (err: any) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`Port ${port} in use, trying an ephemeral port...`);
      // try ephemeral port (0) which lets OS pick a free port
      try {
        const srv2 = app.listen(0, () => {
          const p2 = (srv2.address() as any)?.port;
          const url2 = `http://localhost:${p2}`;
          console.log(`Server listening on fallback port ${p2} -> ${url2}`);
          if (process.env.AUTO_OPEN_BROWSER !== '0' && process.env.CI !== '1') {
            try {
              const { exec } = require('child_process');
              const startCmd = process.platform === 'win32' ? `start "" "${url2}"` : process.platform === 'darwin' ? `open "${url2}"` : `xdg-open "${url2}"`;
              exec(startCmd, (e: any) => { if (e) console.error('Failed to open browser automatically:', e); });
            } catch (e) { console.error('Auto-open browser error:', e); }
          }
        });
        srv2.on('error', (e: any) => {
          console.error('Fallback server error:', e);
          process.exit(1);
        });
      } catch (e) {
        console.error('Failed to bind fallback port:', e);
        process.exit(1);
      }
    } else {
      console.error('Server error:', err);
      process.exit(1);
    }
  });
};

startServerOn(PORT);
