import {
  Role,
  Team,
  Phase,
  Statement,
  VoteRecord,
  DivinationResult,
  MediumResult,
  GameResult,
  COInfo,
  COType,
} from './types';
import {
  Player,
  Villager,
  Werewolf,
  Seer,
  Medium,
  Knight,
  Madman,
} from './player';
import { UserPlayer } from './userPlayer';
import { EventEmitter } from './events';
import { CHARACTERS, DIALOGUES } from './characters';

// 初日進行の再開に必要な状態
type Day1State = {
  stage: 'greetings' | 'co_request' | 'co_sequence' | 'seer_results' | 'debate_start' | 'vote_candidates' | 'done';
  aiPlayerIds: number[];
  greetingsIndex: number;
  greetingsIntroDone: boolean;
  formation: '2-1' | '2-2' | '3-1';
  coPlayers: Array<{ playerId: number; claimedRole: Role; isFake: boolean }>;
  coOrder: number[]; // coPlayers の順序インデックス
  coIndex: number;   // 次に処理する coOrder の位置
  whitelistIds: number[]; // 白扱いにした対象
  seerIndex: number; // 次に処理する占いCOインデックス
  // moderatorId removed: no moderator concept anymore
  designateTargetId?: number | null; // 進行役が指定した投票対象のプレイヤーID
  designateDay?: number | null; // 指定が行われた日
};

/**
 * ゲーム進行管理クラス
 */
export interface GameOptions {
  userName?: string;
  userIcon?: string;
  debugRoleMap?: { [playerId: number]: string } | undefined;
  forcedFormation?: '2-1' | '2-2' | '3-1';
}

export class Game {
  private players: Player[] = [];
  private day: number = 0;
  private phase: Phase = Phase.DAY;
  private statements: Statement[] = [];
  private voteHistory: VoteRecord[] = [];
  private executedPlayerIds: number[] = [];
  public eventEmitter: EventEmitter = new EventEmitter();
  private userName: string = 'あなた';
  // コンストラクタ経由で渡される未適用デバッグ割当（id->role）
  private debugRoleMap: { [playerId: number]: string } | undefined;
  private forcedFormation?: '2-1' | '2-2' | '3-1';

  // 襲撃結果保持用
  private lastNightAttackResult: { attackTargetId: number | null; guardTargetId: number | null } = { attackTargetId: null, guardTargetId: null };

  // 翌夜(=当日夜)の襲撃予定者（村長の個別質問 thinking_attack などから参照）
  private plannedNextAttackTargetId: number | null = null;

  // Avoid duplicate acknowledgement when UI posts a mayor order statement and then calls setDesignate right after.
  private lastGuardOrderAckDay: number = 0;
  private lastGuardOrderAckAt: number = 0;

  // タイマー関連
  private dayPhaseTimer: NodeJS.Timeout | null = null;
  private dayPhaseTimeRemaining: number = 0;
  private dayPhaseResolve: (() => void) | null = null; // dayPhaseの待機を解除するコールバック
  private dayPhasePromise: Promise<void> | null = null;
  private votingTimer: NodeJS.Timeout | null = null; // 投票タイマー
  private votingTimeRemaining: number = 0; // 投票時間（秒）
  private votingSkipped: boolean = false; // 投票スキップフラグ
  private votingResolve: (() => void) | null = null; // 投票待機の解除用コールバック
  private aiStatementCooldowns: Map<number, number> = new Map(); // プレイヤーID → 最後の発言時刻
  private aiStatementsStopped: boolean = false; // AI発言停止フラグ
  private suspendAIStatements: boolean = false; // 一時的にAI自動発言を待機させるフラグ
  private aiStatementCooldownTime: number = 13000; // 13秒
  private currentDiscussionTheme: 'normal' | 'seer_co' | 'medium_co' = 'normal'; // 議論テーマ
  private lastCOPlayerName: string = ''; // 最後にCOしたプレイヤー名
  private coHistory: COInfo[] = []; // CO履歴（矛盾検出用）
  private day1State: Day1State | null = null; // 初日進行の状態
  // 村長操作のカウンタ（サーバ側で日ごとに管理）
  private mayorIndividualQuestionCount: number = 0;
  private mayorAskSuspiciousCount: number = 0;
  private mayorCounterDay: number = 0;

  /**
   * ゲーム進行管理クラス
   */
  constructor(options?: GameOptions) {
    if (options?.userName) this.userName = options.userName;
    if (options?.debugRoleMap) this.debugRoleMap = options.debugRoleMap;
    if (options?.forcedFormation) this.forcedFormation = options.forcedFormation;
  }

  private emitPlayerResult(payload: any, source: string): void {
    try {
      console.log(`[EMIT player_result] source=${source} speaker=${payload.speakerId} day=${payload.day} target=${payload.targetId} result=${payload.result}`);
    } catch (e) {}
    try { this.eventEmitter.emit('player_result', payload); } catch (e) {}
  }

  /**
   * Force an AI player to CO a role (triggered by mayor)
   */
  public forceCO(role: Role | string | undefined): void {
    if (!role) return;
    try {
      const wanted = (role as string).toUpperCase();

      // Async sequence so multiple COs can be emitted in order with small delays
      (async () => {
        try {
          // First, have the mayor (user) speak the order line, then wait a bit for a natural cadence.
          try {
            this.emitMayorOrderForCO(wanted);
            await this.delay(700);
          } catch (e) { /* ignore */ }

          // If the mayor requests CO before Day1 flow starts, Day1 state (including CO candidates)
          // may not yet be initialized. Initialize it here so "all seer CO" can respond consistently.
          try {
            if ((wanted === 'SEER' || wanted === 'MEDIUM') && !this.day1State) {
              this.ensureDay1StateInitialized(this.getAlivePlayers());
            }
          } catch (e) { /* ignore */ }

          // If day1State has coPlayers and coOrder, use that order to emit COs for SEER/MEDIUM
          const state = this.day1State;
          if ((wanted === 'SEER' || wanted === 'MEDIUM') && state && Array.isArray(state.coPlayers) && Array.isArray(state.coOrder)) {
            // iterate in coOrder sequence
            for (const idx of state.coOrder) {
              try {
                const c = state.coPlayers[idx];
                if (!c) continue;
                const claimed = String(c.claimedRole || '').toUpperCase();
                if (claimed !== wanted) continue;
                const p = this.getPlayerById(c.playerId);
                if (!p || !p.isAlive()) continue;
                if (p instanceof UserPlayer) continue;
                const claimedRole = c.claimedRole;
                const name = p.getDisplayName();
                // Record CO into coHistory and broadcast player_co (do not rely on statement text parsing)
                try { this.recordAndBroadcastCOFromKey(p, claimedRole, this.day); } catch (e) { /* ignore */ }
                // select template
                const tplKey = wanted === 'SEER' ? 'seer_co' : 'medium_co';
                const tpl = (DIALOGUES[p.name] as any)?.[tplKey] || (wanted === 'SEER' ? '占いCOします！' : '霊能者COします！');
                const stmt = typeof tpl === 'string' ? tpl : String(tpl);
                this.statements.push({ day: this.day, playerId: p.id, playerName: name, content: stmt });
                this.emitPlayerStatement(p, stmt, this.day, tplKey);
                // If this CO is a Seer or Medium, emit a player_result event so clients can show their stored result immediately
                try {
                  if (claimedRole === Role.SEER) {
                    // Emit all stored divination results (real then fake) so CO on later days shows past results too
                    try {
                      const lastAnn: any = (p as any).lastAnnouncedDivination;
                      const divs: Array<any> = (p as any).divinationResults || [];
                      const fdivs: Array<any> = (p as any).fakeDivinationResults || [];
                      const byDay: Map<number, any> = new Map();
                      // prefer real divs
                      divs.forEach(r => { if (r && typeof r.day === 'number') byDay.set(r.day, r); });
                      // fill missing days with fake divs
                      fdivs.forEach(r => { if (r && typeof r.day === 'number' && !byDay.has(r.day)) byDay.set(r.day, r); });
                      // lastAnn should override the day entry if present
                      if (lastAnn && typeof lastAnn.day === 'number') byDay.set(lastAnn.day, { day: lastAnn.day, targetId: lastAnn.targetId, result: lastAnn.result });
                      const days = Array.from(byDay.keys()).sort((a,b) => a - b);
                      for (const d of days) {
                        const rec = byDay.get(d);
                        if (!rec || typeof rec.targetId !== 'number') continue;
                        const targetPlayer = this.getPlayerById(rec.targetId);
                        const targetName = targetPlayer ? targetPlayer.getDisplayName() : '（不明）';
                        const resultLabel = rec.result === DivinationResult.WEREWOLF ? 'black' : 'white';
                        try { this.emitPlayerResult({ speakerId: p.id, day: rec.day || this.day, targetId: rec.targetId, result: resultLabel, targetName, type: 'seer' }, 'co_iter'); } catch (e) {}
                      }
                    } catch (e) {}
                  } else if (claimedRole === Role.MEDIUM) {
                    // Emit all medium results (chronological)
                    try {
                      const mres: Array<any> = (p as any).mediumResults || [];
                      const byDay: Map<number, any> = new Map();
                      mres.forEach(r => { if (r && typeof r.day === 'number') byDay.set(r.day, r); });
                      const days = Array.from(byDay.keys()).sort((a,b) => a - b);
                      for (const d of days) {
                        const rec = byDay.get(d);
                        if (!rec || typeof rec.targetId !== 'number') continue;
                        const targetPlayer = this.getPlayerById(rec.targetId);
                        const targetName = targetPlayer ? targetPlayer.getDisplayName() : '（不明）';
                        const resultLabel = rec.result === MediumResult.WEREWOLF ? 'black' : 'white';
                        try { this.emitPlayerResult({ speakerId: p.id, day: rec.day || this.day, targetId: rec.targetId, result: resultLabel, targetName, type: 'medium' }, 'co_iter_medium'); } catch (e) {}
                      }
                    } catch (e) {}
                  }
                } catch (e) {}
                // notify memos updated for this player
                try { this.eventEmitter.emit('player_memo_update', { playerId: p.id }); } catch (e) {}
                await this.delay(800);
              } catch (e) { /* per-co ignore */ }
            }
            return;
          }

          // Fallback: find player(s) with matching actual role
          if (wanted === 'KNIGHT') {
            const knights = this.getAlivePlayers().filter(p => p.role === Role.KNIGHT && !(p instanceof UserPlayer));
            for (const k of knights) {
              try {
                const tpl = (DIALOGUES[k.name] as any)?.hunter_co || (DIALOGUES[k.name] as any)?.knight_co || '狩人COします！';
                const name = k.getDisplayName();
                try { this.recordAndBroadcastCOFromKey(k, Role.KNIGHT, this.day); } catch (e) { /* ignore */ }
                this.statements.push({ day: this.day, playerId: k.id, playerName: name, content: tpl });
                this.emitPlayerStatement(k, tpl, this.day, 'hunter_co');
                try { this.eventEmitter.emit('player_memo_update', { playerId: k.id }); } catch (e) {}
                await this.delay(800);
              } catch (e) {}
            }
            return;
          }

          // Generic single CO fallback: pick alive AI who has matching actual role, otherwise random
          const candidates = this.getAlivePlayers().filter(p => !(p instanceof UserPlayer));
          if (candidates.length === 0) return;
          let picked: Player | undefined = candidates.find(p => String(p.role) === wanted);
          if (!picked) picked = candidates[Math.floor(Math.random() * candidates.length)];
          if (!picked) return;
          const claimedRole = (Role as any)[wanted] || Role.VILLAGER;
          const name = picked.getDisplayName();
          try { this.recordAndBroadcastCOFromKey(picked, claimedRole, this.day); } catch (e) { /* ignore */ }
          const stmt = claimedRole === Role.SEER ? ((DIALOGUES[picked.name] as any)?.seer_co || '占いCOします！')
            : claimedRole === Role.MEDIUM ? ((DIALOGUES[picked.name] as any)?.medium_co || '霊能者COします！')
            : claimedRole === Role.KNIGHT ? ((DIALOGUES[picked.name] as any)?.hunter_co || (DIALOGUES[picked.name] as any)?.knight_co || '狩人COします！')
            : '役職を名乗ります。';
          this.statements.push({ day: this.day, playerId: picked.id, playerName: name, content: stmt });
          const key = claimedRole === Role.SEER ? 'seer_co'
            : claimedRole === Role.MEDIUM ? 'medium_co'
            : claimedRole === Role.KNIGHT ? 'hunter_co'
            : undefined;
          this.emitPlayerStatement(picked, stmt, this.day, key);
          try { this.eventEmitter.emit('player_memo_update', { playerId: picked.id }); } catch (e) {}
        } catch (e) { /* ignore inner async errors */ }
      })();
    } catch (e) { /* ignore */ }
  }

  private emitMayorOrderForCO(wantedUpper: string): void {
    const orderKey = wantedUpper === 'SEER'
      ? 'order_seer_co'
      : wantedUpper === 'MEDIUM'
        ? 'order_medium_co'
        : wantedUpper === 'KNIGHT'
          ? 'order_hunter_co'
          : null;
    if (!orderKey) return;

    const fallbackText = wantedUpper === 'SEER'
      ? '占い師はCOしてくれ。'
      : wantedUpper === 'MEDIUM'
        ? '霊能者はCOしてくれ。'
        : '狩人はCOしてくれ。';

    let content = fallbackText;
    try {
      const tpl = (DIALOGUES['ユーザー'] as any)?.[orderKey];
      if (typeof tpl === 'string' && tpl.trim().length > 0) content = tpl;
    } catch (e) {
      // ignore
    }

    const day = this.day || 1;
    const userPlayer = (this.players.find(pl => pl instanceof (UserPlayer as any)) as UserPlayer | undefined)
      || new UserPlayer(0, this.userName || 'あなた', Role.VILLAGER, Team.VILLAGER);

    this.statements.push({ day, playerId: userPlayer.id, playerName: userPlayer.getDisplayName(), content });
    this.emitPlayerStatement(userPlayer, content, day, orderKey);
  }

  /**
   * Set a designate target (vote/divination/guard) from mayor
   */
  public setDesignate(type: string | undefined, targetId: number | undefined, opts?: { emitOrder?: boolean }): void {
    if (!this.day1State) this.day1State = { stage: 'greetings', aiPlayerIds: [], greetingsIndex: 0, greetingsIntroDone: false, formation: '2-1', coPlayers: [], coOrder: [], coIndex: 0, whitelistIds: [], seerIndex: 0 };
    if (!type || typeof targetId !== 'number') return;
    const t = type.toLowerCase();
    if (t === 'vote') {
      const day = this.day || 1;
      // Mayor speaks the designate order line (user statement) first
      if (opts?.emitOrder) {
        try {
          const target = this.getPlayerById(Number(targetId));
          const targetName = target ? target.getDisplayName() : '〇〇';
          let tpl = '投票は〇〇にしてくれ。';
          try {
            const userTpl = (DIALOGUES['ユーザー'] as any)?.order_designate_vote;
            if (typeof userTpl === 'string' && userTpl.trim().length > 0) tpl = userTpl;
          } catch (e) {}
          const content = String(tpl).replace(/〇〇/g, targetName);
          const userPlayer = (this.players.find(pl => pl instanceof (UserPlayer as any)) as UserPlayer | undefined)
            || new UserPlayer(0, this.userName || 'あなた', Role.VILLAGER, Team.VILLAGER);
          this.statements.push({ day, playerId: userPlayer.id, playerName: userPlayer.getDisplayName(), content });
          this.emitPlayerStatement(userPlayer, content, day, 'order_designate_vote');
        } catch (e) { /* ignore */ }
      }

      this.day1State.designateTargetId = Number(targetId);
      this.day1State.designateDay = day;
      this.eventEmitter.emit('designate_set', { type: 'vote', targetId });
      // 市長が投票先を指定したとき、他のAIが短く了承の発言をする演出を入れる
      (async () => {
        try {
          await this.delay(700);
          const aliveAi = this.getAlivePlayers().filter(p => !(p instanceof UserPlayer) && p.isAlive() && p.id !== targetId);
          if (!aliveAi || aliveAi.length === 0) return;
          // shuffle
          const shuffled = aliveAi.slice().sort(() => Math.random() - 0.5);
          const count = Math.min(2, shuffled.length);
          for (let i = 0; i < count; i++) {
            try {
              const sp = shuffled[i];
              const tplAcc = (DIALOGUES[sp.name] as any)?.acknowledge || 'わかりました。';
              const accTxt = typeof tplAcc === 'string' ? tplAcc : String(tplAcc);
              this.statements.push({ day, playerId: sp.id, playerName: sp.getDisplayName(), content: accTxt });
              this.emitPlayerStatement(sp, accTxt, day, 'acknowledge');
              await this.delay(700);
            } catch (e) { /* per-speaker ignore */ }
          }
        } catch (e) { /* ignore overall */ }
      })();
      // 指定は保存しておき、投票フェーズ開始時に実際の投票へ反映する（即時反映は行わない）
      // (投票の即時反映ロジックは `proceedToVoting()` 実行時に適用されます)
    } else if (t === 'divination') {
      // store as a request for seer CO(s) (true or fake) to use next night
      try {
        const day = this.day || 1;
        const seerCOIds = new Set<number>();

        // Prefer actual CO evidence
        try {
          for (const c of (this.coHistory || []) as Array<any>) {
            if (!c) continue;
            if (c.claimedRole !== Role.SEER) continue;
            if (!(c.coType === COType.TRUE_CO || c.coType === COType.CONTRADICTORY_CO)) continue;
            if (c.day == null || c.day > day) continue;
            if (typeof c.playerId === 'number') seerCOIds.add(c.playerId);
          }
        } catch (e) {}

        // Fallback: planned CO list (formation)
        if (seerCOIds.size === 0) {
          try {
            const cps: any[] = ((this.day1State as any)?.coPlayers) || [];
            for (const c of cps) {
              if (c && c.claimedRole === Role.SEER && typeof c.playerId === 'number') seerCOIds.add(c.playerId);
            }
          } catch (e) {}
        }

        // Last fallback: actual seer role
        if (seerCOIds.size === 0) {
          try {
            for (const p of this.players) {
              if (p.role === Role.SEER && p.isAlive() && !(p instanceof UserPlayer)) seerCOIds.add(p.id);
            }
          } catch (e) {}
        }

        for (const id of Array.from(seerCOIds)) {
          const s = this.getPlayerById(id);
          if (!s) continue;
          if (!s.isAlive()) continue;
          if (s instanceof UserPlayer) continue;
          // seer cannot divine themselves; ignore/clear such designation
          (s as any).nextDesignateDivination = (s.id === targetId ? null : targetId);
        }
        this.eventEmitter.emit('designate_set', { type: 'divination', targetId });
      } catch (e) {}
    } else if (t === 'guard') {
      try {
        const day = this.day || 1;
        const knights = this.players.filter(p => p.role === Role.KNIGHT && p.isAlive() && !(p instanceof UserPlayer));
        for (const k of knights) {
          (k as any).nextDesignateGuard = targetId;
        }
        this.eventEmitter.emit('designate_set', { type: 'guard', targetId });

        // If a living knight has already CO'd as KNIGHT, let them acknowledge the order.
        // (Use shared helper to suppress duplicates when the UI also sent a statement.)
        this.acknowledgeGuardOrderIfKnightCO(day);
      } catch (e) {}
    }
  }

  /**
   * Set divination designate for a specific seer (mayor -> seerId), and let the seer acknowledge
   * if they are alive and have CO'd as SEER.
   */
  public setDesignateDivinationForSeer(seerId: number, targetId: number | null | undefined): void {
    if (typeof seerId !== 'number') return;
    const day = this.day || 1;
    const seer = this.getPlayerById(seerId);
    if (!seer) return;
    if (!(seer as any).isAlive || !seer.isAlive()) return;
    if (seer instanceof (UserPlayer as any)) return;

    // seer cannot divine themselves
    if (typeof targetId === 'number' && targetId === seerId) {
      targetId = null;
    }

    try { (seer as any).nextDesignateDivination = (typeof targetId === 'number' ? targetId : null); } catch (e) {}
    try { this.eventEmitter.emit('designate_set', { type: 'divination', seerId, targetId }); } catch (e) {}

    // acknowledge only when the seer has CO'd as SEER
    (async () => {
      try {
        if (this.aiStatementsStopped) return;
        // CO check: day1State.coPlayers or coHistory
        let hasCO = false;
        try {
          const day1CoPlayers: any[] = ((this.day1State as any)?.coPlayers) || [];
          if (day1CoPlayers.some(c => c && c.playerId === seerId && c.claimedRole === Role.SEER)) hasCO = true;
        } catch (e) {}
        if (!hasCO) {
          try {
            const coHistory: any[] = (this.coHistory as any) || [];
            if (coHistory.some(c => c && c.playerId === seerId && c.claimedRole === Role.SEER && (c.coType === COType.TRUE_CO || c.coType === COType.CONTRADICTORY_CO))) hasCO = true;
          } catch (e) {}
        }
        if (!hasCO) return;

        await this.delay(600);
        if (this.aiStatementsStopped) return;
        if (!seer.isAlive()) return;

        const tplAcc = (DIALOGUES[seer.name] as any)?.acknowledge || 'わかりました。';
        const accTxt = typeof tplAcc === 'string' ? tplAcc : String(tplAcc);
        this.statements.push({ day, playerId: seer.id, playerName: seer.getDisplayName(), content: accTxt });
        this.emitPlayerStatement(seer, accTxt, day, 'acknowledge');
      } catch (e) { /* ignore */ }
    })();
  }

  /**
   * Ask an individual AI a question (mayor -> AI). questionKey is one of predefined options.
   */
  public askIndividualQuestion(targetId: number | undefined, questionKey: string | undefined): void {
    // enforce server-side per-day limit (3)
    this.resetMayorCountersIfNeeded();
    if (this.mayorIndividualQuestionCount >= 3) {
      this.eventEmitter.emit('mayor_action_rejected', { type: 'individual_question', reason: 'limit_exceeded' });
      return;
    }
    if (typeof targetId !== 'number' || !questionKey) return;
    const p = this.getPlayerById(targetId);
    if (!p) return;
    const qMap: any = {
      'ask_if_ok_to_be_divined': '自分が占われても構わない？',
      'ask_if_ok_to_be_sacrificed': '自分が犠牲でも厭わない？',
      'ask_if_have_role': '何か役職持っている？',
      'ask_who_will_be_attacked': '明日誰が襲われると思う？',
      'ask_why_suspicious': 'なぜ〇〇が怪しいと思う？'
    };
    const text = qMap[questionKey] || questionKey;
    // Emit an event for mayor question
    this.eventEmitter.emit('mayor_question', { targetId, questionKey, text });
    // Prepare and emit the user's spoken question (use DIALOGUES 'ユーザー' templates when available)
    try {
      const userPlayer = this.players.find(pl => pl instanceof (UserPlayer as any)) as UserPlayer | undefined;
      const userQKeyMap: any = {
        'ask_if_ok_to_be_divined': 'question_seer',
        'ask_if_ok_to_be_sacrificed': 'question_sacrifice',
        'ask_if_have_role': 'question_position',
        'ask_who_will_be_attacked': 'question_attack',
      };
      const ukey = userQKeyMap[questionKey] || null;
      let userTpl = null as string | null;
      try { userTpl = (DIALOGUES['ユーザー'] as any)?.[ukey] || null; } catch (e) { userTpl = null; }
      const userText = (typeof userTpl === 'string' ? userTpl.replace(/〇〇/g, p.getDisplayName()) : text);
      if (userPlayer) {
        this.statements.push({ day: this.day, playerId: userPlayer.id, playerName: userPlayer.getDisplayName(), content: userText });
        try { this.emitPlayerStatement(userPlayer, userText, this.day, ukey || questionKey); } catch (e) {}
      } else {
        // fallback: log the mayor question
        this.eventEmitter.emit('log', { message: `村長が${p.getDisplayName()}に質問：「${userText}」`, type: 'section' });
      }
    } catch (e) {}

    // Schedule the target AI's reply based on question type.
    this.mayorIndividualQuestionCount++;
    (async () => {
      try { await this.delay(700); } catch (e) {}
      try {
        const pickWeighted = (weights: Record<string, number>): string => {
          const entries = Object.entries(weights).filter(([, w]) => typeof w === 'number' && w > 0);
          if (entries.length === 0) return Object.keys(weights)[0] || '';
          const total = entries.reduce((s, [, w]) => s + w, 0);
          let r = Math.random() * total;
          for (const [k, w] of entries) {
            r -= w;
            if (r <= 0) return k;
          }
          return entries[entries.length - 1][0];
        };

        if (questionKey === 'ask_if_ok_to_be_divined') {
          const defaultWeights = { no_problem_seer: 0.5, accept_seer: 0.35, deny_seer: 0.15 };
          const weightsByRole: Partial<Record<Role, Record<string, number>>> = {
            [Role.SEER]: { no_problem_seer: 0.6, accept_seer: 0.3, deny_seer: 0.1 },
            [Role.MEDIUM]: { no_problem_seer: 0.45, accept_seer: 0.35, deny_seer: 0.2 },
            [Role.KNIGHT]: { no_problem_seer: 0.45, accept_seer: 0.35, deny_seer: 0.2 },
            [Role.WEREWOLF]: { no_problem_seer: 0.2, accept_seer: 0.5, deny_seer: 0.3 },
            [Role.MADMAN]: { no_problem_seer: 0.35, accept_seer: 0.45, deny_seer: 0.2 },
          };
          const pick = pickWeighted(weightsByRole[p.role] || defaultWeights);
          const tpl = ((DIALOGUES[p.name] as any) || {})[pick] as string | undefined;
          const replyTxt = tpl ? tpl.replace(/〇〇/g, p.getDisplayName()) : (pick === 'no_problem_seer' ? '構いません。' : pick === 'accept_seer' ? '受け入れます。' : 'やめてください！');
          this.statements.push({ day: this.day, playerId: p.id, playerName: p.getDisplayName(), content: replyTxt });
          try { this.emitPlayerStatement(p, replyTxt, this.day, pick); } catch (e) {}
        } else if (questionKey === 'ask_if_ok_to_be_sacrificed') {
          const defaultWeights = { no_problem_sacrifice: 0.1, accept_sacrifice: 0.3, deny_sacrifice: 0.6 };
          const weightsByRole: Partial<Record<Role, Record<string, number>>> = {
            [Role.SEER]: { no_problem_sacrifice: 0.05, accept_sacrifice: 0.25, deny_sacrifice: 0.7 },
            [Role.MEDIUM]: { no_problem_sacrifice: 0.05, accept_sacrifice: 0.25, deny_sacrifice: 0.7 },
            [Role.KNIGHT]: { no_problem_sacrifice: 0.05, accept_sacrifice: 0.25, deny_sacrifice: 0.7 },
            [Role.WEREWOLF]: { no_problem_sacrifice: 0.2, accept_sacrifice: 0.35, deny_sacrifice: 0.45 },
            [Role.MADMAN]: { no_problem_sacrifice: 0.2, accept_sacrifice: 0.45, deny_sacrifice: 0.35 },
          };
          const pick = pickWeighted(weightsByRole[p.role] || defaultWeights);
          const tpl = ((DIALOGUES[p.name] as any) || {})[pick] as string | undefined;
          const replyTxt = tpl ? tpl.replace(/〇〇/g, p.getDisplayName()) : (pick === 'no_problem_sacrifice' ? '構いません。' : pick === 'accept_sacrifice' ? '受け入れます。' : 'やめてください！');
          this.statements.push({ day: this.day, playerId: p.id, playerName: p.getDisplayName(), content: replyTxt });
          try { this.emitPlayerStatement(p, replyTxt, this.day, pick); } catch (e) {}
        } else if (questionKey === 'ask_if_have_role') {
          // respond with yes_position or no_position (role/CO-aware)
          const hasCO = (() => {
            try {
              const day1 = this.day1State as any;
              const inDay1 = Array.isArray(day1?.coPlayers) && day1.coPlayers.some((c: any) => c && c.playerId === p.id);
              const inHistory = (this.coHistory || []).some((c: any) => c && c.playerId === p.id && (c.coType === COType.TRUE_CO || c.coType === COType.CONTRADICTORY_CO));
              return !!(inDay1 || inHistory);
            } catch (e) {
              return false;
            }
          })();

          const plannedCO = (() => {
            try {
              const day1 = this.day1State as any;
              return Array.isArray(day1?.coPlayers) && day1.coPlayers.some((c: any) => c && c.playerId === p.id);
            } catch (e) {
              return false;
            }
          })();

          let weights = { yes_position: 0.1, no_position: 0.9 };
          if (hasCO) {
            weights = { yes_position: 1.0, no_position: 0.0 };
          } else if (p.role === Role.SEER || p.role === Role.MEDIUM || p.role === Role.KNIGHT) {
            weights = this.day <= 1 ? { yes_position: 0.2, no_position: 0.8 } : { yes_position: 0.6, no_position: 0.4 };
          } else if (p.role === Role.WEREWOLF || p.role === Role.MADMAN) {
            if (plannedCO) weights = { yes_position: 0.7, no_position: 0.3 };
            else weights = this.day <= 1 ? { yes_position: 0.2, no_position: 0.8 } : { yes_position: 0.3, no_position: 0.7 };
          } else {
            weights = { yes_position: 0.05, no_position: 0.95 };
          }

          const pick = pickWeighted(weights);
          const tpl = ((DIALOGUES[p.name] as any) || {})[pick] as string | undefined;
          const replyTxt = tpl ? tpl.replace(/〇〇/g, p.getDisplayName()) : (pick === 'yes_position' ? 'はい、あります。' : 'いいえ、ありません。');
          this.statements.push({ day: this.day, playerId: p.id, playerName: p.getDisplayName(), content: replyTxt });
          try { this.emitPlayerStatement(p, replyTxt, this.day, pick); } catch (e) {}
        } else if (questionKey === 'ask_who_will_be_attacked') {
          const tpl = ((DIALOGUES[p.name] as any) || {})['thinking_attack'] as string | undefined;
          // pick a name (role-based probability): planned next attack target vs random
          const candidates = this.getAlivePlayers().filter(pl => pl.isAlive() && pl.id !== p.id && !(pl instanceof UserPlayer));
          const plannedId = this.plannedNextAttackTargetId;
          const plannedPlayer = (typeof plannedId === 'number') ? this.getPlayerById(plannedId) : null;
          const plannedOk = !!(plannedPlayer && plannedPlayer.isAlive() && plannedPlayer.id !== p.id && !(plannedPlayer instanceof UserPlayer));

          const plannedProbByRole: Partial<Record<Role, number>> = {
            [Role.VILLAGER]: 0.5,
            [Role.SEER]: 0.55,
            [Role.MEDIUM]: 0.5,
            [Role.KNIGHT]: 0.55,
            [Role.WEREWOLF]: 0.2,
            [Role.MADMAN]: 0.35,
          };
          const plannedProb = plannedProbByRole[p.role] ?? 0.5;

          let chosenName = '誰か';
          if (plannedOk && Math.random() < plannedProb) {
            chosenName = plannedPlayer!.getDisplayName();
          } else {
            const pool = candidates.filter(c => !plannedOk || c.id !== plannedPlayer!.id);
            const chosen = (pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : (candidates.length > 0 ? candidates[Math.floor(Math.random() * candidates.length)] : null));
            chosenName = chosen ? chosen.getDisplayName() : '誰か';
          }

          const replyTxt = tpl ? tpl.replace(/〇〇/g, chosenName) : `そうですね…${chosenName}とか？`;
          this.statements.push({ day: this.day, playerId: p.id, playerName: p.getDisplayName(), content: replyTxt });
          try { this.emitPlayerStatement(p, replyTxt, this.day, 'thinking_attack'); } catch (e) {}
        } else {
          // fallback single reply
          let reply = '';
          if (questionKey === 'ask_why_suspicious') reply = '発言の様子が不自然だったからです。';
          else reply = 'わかりません。';
          this.statements.push({ day: this.day, playerId: p.id, playerName: p.getDisplayName(), content: reply });
          try { this.emitPlayerStatement(p, reply, this.day); } catch (e) {}
        }
      } catch (e) { /* ignore errors in reply scheduling */ }
    })();
  }

  /**
   * Ask all AI to state who they find suspicious (moves into conversation phase)
   */
  public async askEveryoneSuspicious(): Promise<void> {
    // enforce server-side per-day limit (1)
    this.resetMayorCountersIfNeeded();
    if (this.mayorAskSuspiciousCount >= 1) {
      this.eventEmitter.emit('mayor_action_rejected', { type: 'ask_suspicious', reason: 'limit_exceeded' });
      return;
    }
    this.mayorAskSuspiciousCount++;
    // Emit event to inform clients that conversation phase should be entered
    this.eventEmitter.emit('enter_conversation_phase', { day: this.day });
    // Have each alive AI emit a suspicious-person or none_suspect statement in sequence
    const aliveAi = this.getAlivePlayers().filter(p => !(p instanceof UserPlayer));
    for (const ai of aliveAi) {
      try {
        if (!ai.isAlive()) continue;
        // small delay between speakers to feel natural
        await this.delay(900);

        // Determine probabilities by alignment
        // 村人陣営(人狼、狂人以外): 70% suspect, 30% none_suspect
        // 人狼陣営(人狼、狂人): 40% suspect, 60% none_suspect
        const isWolfFaction = (ai.role === Role.WEREWOLF || ai.role === Role.MADMAN);
        const suspectProb = isWolfFaction ? 0.4 : 0.7;
        const roll = Math.random();

        if (roll < suspectProb) {
          // produce a suspect statement: pick target randomly
          // - confirmedWhite は含めない
          // - 人狼が suspect を言う場合は相方(自分以外の人狼)を含めない
          const alivePlayers = this.getAlivePlayers().filter(p => p.isAlive());
          let candidates = alivePlayers.filter(p => p.id !== ai.id && !(p as any).confirmedWhite);
          if (ai.role === Role.WEREWOLF) {
            candidates = candidates.filter(p => p.role !== Role.WEREWOLF);
          }

          if (candidates.length === 0) {
            // No valid candidates under the constraints -> fall back to none_suspect
            const tpl = ((DIALOGUES[ai.name] as any) || {})['none_suspect'] as string | undefined;
            const txt = tpl || '特に怪しい人はいないように思います。';
            this.statements.push({ day: this.day, playerId: ai.id, playerName: ai.getDisplayName(), content: txt });
            this.emitPlayerStatement(ai, txt, this.day, 'none_suspect');
          } else {
            const target = candidates[Math.floor(Math.random() * candidates.length)];
            const targetName = target ? target.getDisplayName() : '誰か';
            const tpl = ((DIALOGUES[ai.name] as any) || {})['suspect'] as string | undefined;
            const txt = tpl ? tpl.replace(/〇〇/g, targetName) : `${targetName}が怪しいと思います。`;
            this.statements.push({ day: this.day, playerId: ai.id, playerName: ai.getDisplayName(), content: txt });
            this.emitPlayerStatement(ai, txt, this.day, 'suspect');
          }
        } else {
          // none_suspect
          const tpl = ((DIALOGUES[ai.name] as any) || {})['none_suspect'] as string | undefined;
          const txt = tpl || '特に怪しい人はいないように思います。';
          this.statements.push({ day: this.day, playerId: ai.id, playerName: ai.getDisplayName(), content: txt });
          this.emitPlayerStatement(ai, txt, this.day, 'none_suspect');
        }
      } catch (e) { /* ignore per-ai */ }
    }
  }

  /**
   * Start the day-phase timer if not already running. Returns immediately.
   * The created promise is stored in `dayPhasePromise` and resolved when time expires.
   */
  private startDayTimer(): void {
    // Timers removed for new mayor-driven flow: no-op
    return;
  }

  /**
   * Emit seer announce/reason/result for Day2 after ask_seer_results_first
   */
  private async emitDay2SeerResultsFromDay1(): Promise<void> {
    try {
      try { console.log(`[TRACE emitDay2SeerResultsFromDay1] called day=${this.day} aiStatementsStopped=${this.aiStatementsStopped}`); } catch(e) {}
      if (this.aiStatementsStopped) { try { console.log('[TRACE emitDay2SeerResultsFromDay1] returning early: aiStatementsStopped=true'); } catch(e) {} ; return; }
      const __SHOW_CONVERSATION_LOGS = process.env.SHOW_CONVERSATION_LOGS === '1';
      const day = this.day;
      const day1 = this.day1State;
      if (!day1) return;

      // NOTE: day1State.coPlayers は「CO予定(編成)」であり、実際にCOしたことの証拠ではない。
      // 自動発言は「実際にCOした」場合のみ許可するため、coHistory のみを参照する。
      const isSeerCOUpToToday = (playerId: number): boolean => {
        try {
          return (this.coHistory || []).some((c: any) =>
            c && c.playerId === playerId && c.day != null && c.day <= day &&
            (c.coType === COType.TRUE_CO || c.coType === COType.CONTRADICTORY_CO) &&
            c.claimedRole === Role.SEER
          );
        } catch (e) {
          return false;
        }
      };

      // Determine seer CO players.
      // IMPORTANT: Only seers who have actually CO'd (day1 or any day up to today) should auto-announce results.
      let seerCOs: Player[] = [];
      try {
        const seerIds = new Set<number>();
        for (const c of (this.coHistory || []) as Array<any>) {
          if (!c) continue;
          if (c.claimedRole !== Role.SEER) continue;
          if (!(c.coType === COType.TRUE_CO || c.coType === COType.CONTRADICTORY_CO)) continue;
          if (c.day == null || c.day > day) continue;
          if (typeof c.playerId === 'number') seerIds.add(c.playerId);
        }

        seerCOs = Array.from(seerIds)
          .map(id => this.getPlayerById(id))
          .filter((p: Player | null): p is Player => !!p)
          .filter(p => isSeerCOUpToToday(p.id));

        try {
          if (__SHOW_CONVERSATION_LOGS) {
            console.log(`[TRACE emitDay2SeerResultsFromDay1] coHistorySeerIds=[${Array.from(seerIds).join(',')}] seerCOs=${seerCOs.map(s => `${s.id}:${s.getDisplayName()}`).join(' | ')}`);
          }
        } catch (e) {}
      } catch (e) {
        seerCOs = [];
      }
      if (seerCOs.length === 0) return;

      // announce targets first
      for (const seerPlayer of seerCOs) {
        if (this.aiStatementsStopped) break;
        if (!seerPlayer.isAlive()) continue;
        // Skip if this seer has not CO'd (safety guard)
        if (!isSeerCOUpToToday(seerPlayer.id)) continue;
        try {
          // determine target from recorded divinationResults, fakeDivinationResults, or nightActionHistory
          let targetId: number | null = null;
          const divs: Array<any> = (seerPlayer as any).divinationResults || [];
          // check true divination results for current day then fallback to day-1
          let rec = divs.find((r: any) => r && r.day === day);
          if (!rec) rec = divs.find((r: any) => r && r.day === day - 1);
          // If we fell back to previous day's record, do not mutate internal state;
          // simply use the previous-day `rec` for announcement (no duplication).
          if (rec && typeof rec.targetId === 'number') targetId = rec.targetId;
          // if still null, check fake divination results (for fake seers)
          if (targetId == null) {
            const fdivs: Array<any> = (seerPlayer as any).fakeDivinationResults || [];
            let frec = fdivs.find((r: any) => r && r.day === day);
            if (!frec) frec = fdivs.find((r: any) => r && r.day === day - 1);
            if (frec && typeof frec.targetId === 'number') targetId = frec.targetId;
          }
          // final fallback: nightActionHistory entries (if any)
          if (targetId == null) {
            const nh: Array<any> = (seerPlayer as any).nightActionHistory || [];
            let nrec = nh.slice().reverse().find((r: any) => r && r.day === day);
            if (!nrec) nrec = nh.slice().reverse().find((r: any) => r && r.day === day - 1);
            // do not copy previous day's nightActionHistory into current day; prefer divination/fake records
            if (nrec && typeof nrec.targetId === 'number') targetId = nrec.targetId;
          }
          if (targetId == null) continue;
          const target = this.getPlayerById(targetId);
          const targetName = target ? target.getDisplayName() : '';
          const tpl = ((DIALOGUES[seerPlayer.name] as any) || {})['announce_seer_target'] as string | undefined;
          const txt = tpl ? tpl.replace(/〇〇/g, targetName) : `${targetName}を占いました！`;
          this.statements.push({ day: day, playerId: seerPlayer.id, playerName: seerPlayer.getDisplayName(), content: txt });
          this.emitPlayerStatement(seerPlayer, txt, day);
          try {
            (seerPlayer as any).lastAnnouncedDivination = { day, targetId: targetId, result: (divs && divs.find((r:any)=>r && r.day===day) ) ? (divs.find((r:any)=>r && r.day===day)!.result) : undefined };
          } catch(e) {}
            // Also emit a player_result event matching this announced target (prefer recorded result if present)
            try {
              let resultLabel: string | null = null;
              try {
                const divs: Array<any> = (seerPlayer as any).divinationResults || [];
                const rec = divs.find((r: any) => r && r.day === day) || divs.find((r: any) => r && r.day === day - 1) || null;
                if (rec && rec.result != null) resultLabel = rec.result === DivinationResult.WEREWOLF ? 'black' : 'white';
              } catch (e) { /* ignore */ }
              if (resultLabel == null) {
                // fallback derive from actual role
                const t = this.getPlayerById(targetId!);
                if (t) resultLabel = t.role === Role.WEREWOLF ? 'black' : 'white';
              }
              if (typeof targetId === 'number' && resultLabel != null) {
                const t = this.getPlayerById(targetId);
                const targetName = t ? t.getDisplayName() : '（不明）';
                try { this.emitPlayerResult({ speakerId: seerPlayer.id, day: day, targetId: targetId, result: resultLabel, targetName, type: 'seer' }, 'announce'); } catch (e) {}
              }
            } catch (e) { /* ignore player_result emission errors */ }
          await this.delay(700);
        } catch (e) { /* per seer ignore */ }
      }

      if (this.aiStatementsStopped) return;
      await this.delay(700);

      // seer reasons
      for (const sp of seerCOs) {
        if (this.aiStatementsStopped) break;
        if (!sp.isAlive()) continue;
        try {
          const hist: Array<any> = (sp as any).nightActionHistory || [];
          // Prefer a non-null variable from the current day; fall back to the most
          // recent non-null variable from the previous day. This avoids using
          // day1 entries that intentionally have variable===null.
          let rec = hist.slice().reverse().find((r: any) => r && r.day === day && r.variable != null);
          if (!rec) rec = hist.slice().reverse().find((r: any) => r && r.day === day - 1 && r.variable != null);
          const variable = rec ? rec.variable : null;
          if (variable) {
            const key = `seer_reason_${variable}`;
            const tpl = ((DIALOGUES[sp.name] as any) || {})[key] as string | undefined;
            let txt: string = '';
            // Prefer any announced target recorded earlier in this turn
            const lastAnn: any = (sp as any).lastAnnouncedDivination;
            let rec: any = null;
            if (lastAnn && lastAnn.day === day && typeof lastAnn.targetId === 'number') {
              rec = { day: lastAnn.day, targetId: lastAnn.targetId, result: lastAnn.result };
            } else {
              const divs: Array<any> = (sp as any).divinationResults || [];
              rec = divs.find((r: any) => r && r.day === day) || divs.find((r: any) => r && r.day === day - 1) || null;
              if (!rec) {
                const farr: Array<any> = (sp as any).fakeDivinationResults || [];
                rec = farr.find((r: any) => r && r.day === day) || farr.find((r: any) => r && r.day === day - 1) || null;
              }
            }
            if (!rec) continue;
            if (!txt) txt = tpl || ((DIALOGUES[sp.name] as any)?.seer_reason_intuition) || '理由は直感です。';
            this.statements.push({ day: day, playerId: sp.id, playerName: sp.getDisplayName(), content: txt });
            try {
              this.emitPlayerStatement(sp, txt, day, key);
            } catch (e) { this.emitPlayerStatement(sp, txt, day); }
            await this.delay(700);
          }
        } catch (e) { /* per-seer ignore */ }
      }

      if (this.aiStatementsStopped) return;
      await this.delay(700);

      // seer results
      for (const sp of seerCOs) {
        if (this.aiStatementsStopped) break;
        if (!sp.isAlive()) continue;
        try {
          // Prefer the announced divination if present so announcement/result stay consistent
          const lastAnn: any = (sp as any).lastAnnouncedDivination;
          let rec: any = null;
          if (lastAnn && lastAnn.day === day && typeof lastAnn.targetId === 'number') {
            rec = { day: lastAnn.day, targetId: lastAnn.targetId, result: lastAnn.result };
          } else {
            const divs: Array<any> = (sp as any).divinationResults || [];
            rec = divs.find((r: any) => r && r.day === day) || divs.find((r: any) => r && r.day === day - 1) || null;
            if (!rec) {
              const farr: Array<any> = (sp as any).fakeDivinationResults || [];
              rec = farr.find((r: any) => r && r.day === day) || farr.find((r: any) => r && r.day === day - 1) || null;
            }
          }
          if (!rec) continue;
          let res = rec.result as DivinationResult | undefined;
          const targetId = typeof rec.targetId === 'number' ? rec.targetId : null;
          // If the announced record had no explicit result stored, try to derive it
          if (res == null && typeof targetId === 'number') {
            try {
              const divs2: Array<any> = (sp as any).divinationResults || [];
              const found = divs2.find((r: any) => r && r.day === day) || divs2.find((r: any) => r && r.day === day - 1) || null;
              if (found && found.result != null) res = found.result as DivinationResult;
              else {
                const t = this.getPlayerById(targetId);
                if (t) res = t.role === Role.WEREWOLF ? DivinationResult.WEREWOLF : DivinationResult.HUMAN;
              }
            } catch (e) { /* ignore derivation errors */ }
          }
          const key = res === DivinationResult.WEREWOLF ? 'seer_result_black' : 'seer_result_white';
          const tpl = ((DIALOGUES[sp.name] as any) || {})[key] as string | undefined;
          let txt = '';
          if (tpl) {
            if (tpl.includes('〇〇') && targetId != null) {
              const tp = this.getPlayerById(targetId);
              const disp = tp ? tp.getDisplayName() : '';
              txt = tpl.replace(/〇〇/g, disp);
            } else {
              txt = tpl;
            }
          } else {
            txt = res === DivinationResult.WEREWOLF ? '結果は黒です！' : '結果は白です。';
          }
          this.statements.push({ day: day, playerId: sp.id, playerName: sp.getDisplayName(), content: txt });
          try { this.emitPlayerStatement(sp, txt, day, key); } catch (e) { this.emitPlayerStatement(sp, txt, day); }
          await this.delay(700);
        } catch (e) { /* per-seer ignore */ }
      }
      if (this.aiStatementsStopped) return;
      // After all seer results, wait a bit then possibly emit found_black / panda
      try {
        await this.delay(700);
        // collect day results for seer COs
        const resultsByTarget = new Map<number, Array<DivinationResult>>();
        for (const sp of seerCOs) {
          try {
            const divs: Array<any> = (sp as any).divinationResults || [];
            // prefer current day, but fallback to previous day (Day2 reads Day1 night's results)
            let rec = divs.find((r: any) => r && r.day === day) || divs.find((r: any) => r && r.day === day - 1);
            if (!rec) {
              const farr: Array<any> = (sp as any).fakeDivinationResults || [];
              rec = farr.find((r: any) => r && r.day === day) || farr.find((r: any) => r && r.day === day - 1);
            }
            if (!rec || typeof rec.targetId !== 'number') continue;
            const tid: number = rec.targetId;
            const arr = resultsByTarget.get(tid) || [];
            arr.push(rec.result as DivinationResult);
            resultsByTarget.set(tid, arr);
            // set panda flags on the target player for UI/logic
            try {
              const tp = this.getPlayerById(tid);
              if (tp) {
                if (rec.result === DivinationResult.WEREWOLF) (tp as any).pandaBlack = true;
                if (rec.result === DivinationResult.HUMAN) (tp as any).pandaWhite = true;
              }
            } catch (e) { /* ignore */ }
          } catch (e) { /* per seer ignore */ }
        }

        // determine if any black exists, and whether any black is contradicted by white
        let anyBlack = false;
        let contradictoryTargetId: number | null = null;
        let anyBlackTargetId: number | null = null;
        for (const [tid, arr] of resultsByTarget.entries()) {
          const hasBlack = arr.some(r => r === DivinationResult.WEREWOLF);
          const hasWhite = arr.some(r => r === DivinationResult.HUMAN);
          if (hasBlack && anyBlackTargetId == null) anyBlackTargetId = tid;
          if (hasBlack) anyBlack = true;
          if (hasBlack && hasWhite) {
            contradictoryTargetId = tid; break;
          }
        }

        if (anyBlack) {
          // choose speakers: alive, not User, not seerCOs
          const seerIds = new Set(seerCOs.map(s => s.id));
          const speakerCandidates = this.getAlivePlayers().filter(p => !(p instanceof UserPlayer) && !seerIds.has(p.id));
          const emittedSpeakerIds: number[] = [];
          // Compute message type and target outside the candidate block so later steps
          // (e.g., deny_wolf) can reference the same target.
          const msgType = contradictoryTargetId != null ? 'panda' : 'found_black';
          const targetForMsg = contradictoryTargetId != null ? contradictoryTargetId : anyBlackTargetId;
          const targetName = targetForMsg != null ? (this.getPlayerById(targetForMsg)?.getDisplayName() || '') : '';
          if (speakerCandidates.length > 0) {
            const shuffled = speakerCandidates.slice().sort(() => Math.random() - 0.5);
            const count = Math.min(2, shuffled.length);
            for (let i = 0; i < count; i++) {
              if (this.aiStatementsStopped) break;
              const speaker = shuffled[i];
              emittedSpeakerIds.push(speaker.id);
              const tpl = ((DIALOGUES[speaker.name] as any) || {})[msgType] as string | undefined;
              let txt = tpl || (msgType === 'panda' ? 'パンダ？' : '黒！');
              if (txt.includes('〇〇') && targetName) txt = txt.replace(/〇〇/g, targetName);
              this.statements.push({ day: day, playerId: speaker.id, playerName: speaker.getDisplayName(), content: txt });
              this.emitPlayerStatement(speaker, txt, day);
              await this.delay(700);
            }
          }

          // After found_black/panda, wait and then have each seer CO who had a black result
          // state a deny_wolf directed at the emitted speaker(s) in sequence.
          try {
            await this.delay(700);
            // collect seer players who had black result this day
            const blackSeers: Player[] = [];
            for (const sp of seerCOs) {
              try {
                const divs: Array<any> = (sp as any).divinationResults || [];
                // prefer current day, but fallback to previous day's record (Day2 reads Day1 night's results)
                let rec = divs.find((r: any) => r && r.day === day) || divs.find((r: any) => r && r.day === day - 1);
                // If we fell back to previous day's record, do not mutate internal state;
                // use the previous-day `rec` for deny_wolf logic (no duplication).
                if (!rec) {
                  const farr: Array<any> = (sp as any).fakeDivinationResults || [];
                  rec = farr.find((r: any) => r && r.day === day) || farr.find((r: any) => r && r.day === day - 1);
                    // If rec is from previous day, use it directly for deny_wolf logic (no mutation).
                }
                if (rec && rec.result === DivinationResult.WEREWOLF) {
                  blackSeers.push(sp);
                }
              } catch (e) { /* per seer ignore */ }
            }

            if (blackSeers.length > 0 && emittedSpeakerIds.length > 0) {
              // Make the player who was judged black (targetForMsg) speak deny_wolf
              try {
                const targetIdForDeny = targetForMsg != null ? targetForMsg : anyBlackTargetId;
                if (typeof targetIdForDeny === 'number') {
                  const targetPlayer = this.getPlayerById(targetIdForDeny);
                  if (targetPlayer && targetPlayer.isAlive()) {
                    await this.delay(700);
                    // Prefer showing the seer CO who judged this player black.
                    // Fall back to the earlier emitted speaker if no such seer exists.
                    let seerNameForReplace: string | null = null;
                    try {
                      if (blackSeers && blackSeers.length > 0) {
                        seerNameForReplace = blackSeers[0].getDisplayName();
                      } else if (emittedSpeakerIds && emittedSpeakerIds.length > 0) {
                        const addrId = emittedSpeakerIds[0];
                        const addr = this.getPlayerById(addrId);
                        if (addr) seerNameForReplace = addr.getDisplayName();
                      }
                    } catch (e) { /* ignore */ }
                    const tpl = ((DIALOGUES[targetPlayer.name] as any) || {})['deny_wolf'] as string | undefined;
                    let txt = tpl || '私は人狼じゃないです！';
                    if (seerNameForReplace && txt.includes('〇〇')) txt = txt.replace(/〇〇/g, seerNameForReplace);
                    this.statements.push({ day: day, playerId: targetPlayer.id, playerName: targetPlayer.getDisplayName(), content: txt });
                    this.emitPlayerStatement(targetPlayer, txt, day);
                  }
                }
              } catch (e) { /* ignore per-target errors */ }
            }
          } catch (e) { /* ignore */ }
          // After deny_wolf emissions, if any players have been marked confirmedBlack
          // by the seer CO results, have two random non-user, non-seer players
          // announce confirmation using 'found_black_confirm'.
          try {
            await this.delay(700);
            const confirmedPlayers = this.players.filter(p => !!((p as any).confirmedBlack));
            if (confirmedPlayers.length > 0) {
              const seerIds = new Set(seerCOs.map(s => s.id));
              const speakerCandidates = this.getAlivePlayers().filter(p => !(p instanceof UserPlayer) && !seerIds.has(p.id));
              if (speakerCandidates.length > 0) {
                const shuffled = speakerCandidates.slice().sort(() => Math.random() - 0.5);
                const count = Math.min(2, shuffled.length);
                // prefer referencing the first confirmed player when templates include placeholder
                const confirmed = confirmedPlayers[0];
                const confirmedName = confirmed.getDisplayName();
                for (let i = 0; i < count; i++) {
                  if (this.aiStatementsStopped) break;
                  const speaker = shuffled[i];
                  const tpl = ((DIALOGUES[speaker.name] as any) || {})['found_black_confirm'] as string | undefined;
                  let txt = tpl || '黒確です！';
                  if (txt.includes('〇〇')) txt = txt.replace(/〇〇/g, confirmedName);
                  this.statements.push({ day: day, playerId: speaker.id, playerName: speaker.getDisplayName(), content: txt });
                  this.emitPlayerStatement(speaker, txt, day);
                  await this.delay(700);
                }
              }
            }
          } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore overall */ }

      // --- 追加: 占い結果直後に霊能COが直近の霊能結果を発言する（ユーザーの要求により常時発生） ---
      try {
        const mediumCOs = (day1.coPlayers || [])
          .filter((c: any) => c.claimedRole === Role.MEDIUM)
          .map((c: any) => this.getPlayerById(c.playerId))
          .filter((p: Player | null): p is Player => !!p && p.isAlive());
        if (mediumCOs.length > 0) {
          // choose a non-user medium if possible
          let speaker = mediumCOs.find((p: Player) => !(p instanceof UserPlayer));
          if (!speaker) speaker = mediumCOs[0];
          try {
            // Determine if this medium CO was fake (based on day1 state)
            const wasFakeMedium = ((day1 && (day1 as any).coPlayers) || []).some((c: any) => c.playerId === speaker.id && c.claimedRole === Role.MEDIUM && c.isFake);
            // Prefer fakeMediumResults for fake mediums, otherwise use real mediumResults (fallback to fake if none)
            let mres: Array<any> = [];
            if (wasFakeMedium) {
              mres = (speaker as any).fakeMediumResults || [];
            }
            if ((!mres || mres.length === 0)) {
              mres = (speaker as any).mediumResults || (speaker as any).fakeMediumResults || [];
            }
            if (mres && mres.length > 0) {
              const latest = mres[mres.length - 1];
              if (latest && typeof latest.targetId === 'number') {
                const tp = this.getPlayerById(latest.targetId);
                const targetDisp = tp ? tp.getDisplayName() : '';
                const key = latest.result === MediumResult.WEREWOLF ? 'medium_result_black' : 'medium_result_white';
                const tpl = ((DIALOGUES[speaker.name] as any) || {})[key] as string | undefined;
                let txt = '';
                if (tpl) {
                  if (tpl.includes('〇〇')) txt = tpl.replace(/〇〇/g, targetDisp);
                  else txt = tpl;
                } else {
                  txt = latest.result === MediumResult.WEREWOLF ? `${targetDisp}は人狼でした！` : `${targetDisp}は人狼ではありませんでした…`;
                }
                this.statements.push({ day: day, playerId: speaker.id, playerName: speaker.getDisplayName(), content: txt });
                try { this.emitPlayerStatement(speaker, txt, day, key); } catch (e) { this.emitPlayerStatement(speaker, txt, day); }
              }
            }
          } catch (e) { /* per-medium ignore */ }
        }
        // After medium_result emission, have two random alive players (excluding User and medium COs)
        // acknowledge the announcement with `accept_understood` after a short delay.
        try {
          await this.delay(700);
          const mediumIds = new Set(mediumCOs.map((m: Player) => m.id));
          const candidates = this.getAlivePlayers().filter(p => !(p instanceof UserPlayer) && !mediumIds.has(p.id));
          if (candidates.length > 0) {
            const shuffled = candidates.slice().sort(() => Math.random() - 0.5);
            const count = Math.min(2, shuffled.length);
            for (let si = 0; si < count; si++) {
              if (this.aiStatementsStopped) break;
              const spk = shuffled[si];
              const tplAcc = (DIALOGUES[spk.name] as any)?.accept_understood || 'なるほど、わかりました。';
              const accTxt = tplAcc.replace(/〇〇/g, spk.getDisplayName());
              this.statements.push({ day: day, playerId: spk.id, playerName: spk.getDisplayName(), content: accTxt });
              this.emitPlayerStatement(spk, accTxt, day);
              await this.delay(700);
            }
          }
        } catch (e) { /* ignore ack errors */ }
      } catch (e) { /* ignore added medium emission errors */ }
    } catch (e) {
      console.log('[DEBUG emitDay2SeerResultsFromDay1 top error]', e);
    }
  }

  // 発言をフロントに送出するか判定（ユーザーは常に出す。AIは DIALOGUES にある定義のみ出力）
  private isAllowedAIStatement(player: Player, content: string, key?: string): boolean {
    if (player instanceof UserPlayer) return true;
    // endgame victory shouts should be allowed regardless of phase
    if (key === 'victory') return true;
    // ユーザー要求: 昼フェーズでは 'greeting' と 'call' のみ許可し、その他は一切出さない
    const dlg = (DIALOGUES as any)[player.name] || {};
    if (!content || content.trim().length === 0) return false;
    // allow specific keyed templates even during Day / operation phases
    const allowedKeysDuringDay = new Set([
      'seer_co','medium_co','hunter_co','seer_result_white','seer_result_black','medium_result','player_co','suspect','none_suspect','accept_understood',
      'acknowledge',
      // question/response keys added so AI can reply to mayor individual questions during Day
      'no_problem_seer','accept_seer','deny_seer','no_problem_sacrifice','accept_sacrifice','deny_sacrifice','yes_position','no_position','thinking_attack'
    ]);
    if (key && (allowedKeysDuringDay.has(key) || String(key).startsWith('medium_result'))) return true;

    if (this.phase === Phase.DAY) {
      const greetingTpl = dlg.greeting;
      const callTpl = dlg.call;
      // greeting: テンプレートが正規表現的な表記を含む場合があるため、まず正規表現で試す
      if (typeof greetingTpl === 'string' && greetingTpl.length > 0) {
        try {
          const re = new RegExp('^' + greetingTpl + '$');
          if (re.test(content)) return true;
        } catch (e) {
          // 正規表現化に失敗したら厳密一致で判定
          if (content === greetingTpl) return true;
        }
        if (content === greetingTpl) return true;
      }
      if (typeof callTpl === 'string' && callTpl.length > 0 && content === callTpl) return true;
      // それ以外は許可しない
      return false;
    }
    // 夜などの非昼フェーズでは一切出さない（GM と死亡表示以外の AI 発言を禁止）
    return false;
  }

  // プレイヤー発言（ログ + statement イベント）を条件付きで送出する
  private emitPlayerStatement(player: Player, content: string, day: number, key?: string) {
    const __SHOW_CONVERSATION_LOGS = process.env.SHOW_CONVERSATION_LOGS === '1';
    try { if (__SHOW_CONVERSATION_LOGS) console.log(`[emitPlayerStatement] attempt playerId=${player && (player as any).id} name=${player && (player as any).name} key=${key || ''} content="${String(content).slice(0,120)}"`); } catch (e) {}
    if (!this.isAllowedAIStatement(player, content, key)) {
      try { if (__SHOW_CONVERSATION_LOGS) console.log(`[emitPlayerStatement] blocked by isAllowedAIStatement playerId=${player && (player as any).id} key=${key || ''}`); } catch (e) {}
      return;
    }

    // AI の単なる自己紹介（例: "ジョンさんです。"）は表示しない
    if (!(player instanceof UserPlayer)) {
      const display = player.getDisplayName();
      const esc = display.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const selfIntroRegex = new RegExp(`^${esc}です。?$`);
      if (selfIntroRegex.test(content) || new RegExp(`^${esc}です、?$`).test(content)) {
        try { if (__SHOW_CONVERSATION_LOGS) console.log(`[emitPlayerStatement] suppressed self-intro for playerId=${player.id} display=${display} content="${content}"`); } catch (e) {}
        return;
      }
      // または名前だけでの自己紹介（例: "ジョンです。"）も除外
      const nameEsc = player.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const nameSelfIntro = new RegExp(`^${nameEsc}です。?$`);
      if (nameSelfIntro.test(content)) {
        try { if (__SHOW_CONVERSATION_LOGS) console.log(`[emitPlayerStatement] suppressed name-self-intro for playerId=${player.id} name=${player.name} content="${content}"`); } catch (e) {}
        return;
      }

      // AI が他プレイヤーの名前を呼ぶ際のみ敬称を付与する
      for (const p of this.players) {
        if (p.id === player.id) continue; // 自分自身は除外
        const plain = p.name;
        if (!plain) continue;
        const honor = plain === 'あなた' ? 'あなた' : `${plain}さん`;
        if (content.includes(plain) && !content.includes(honor)) {
          // 単純な置換（全一致）
          const re = new RegExp(plain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
          content = content.replace(re, honor);
        }
      }
    }

    const message = `${player.getDisplayName()}: ${content}`;
    try {
      this.eventEmitter.emit('log', { message, type: 'statement' });
    } catch (e) {
      if (__SHOW_CONVERSATION_LOGS) console.log('[emitPlayerStatement] emit log ERROR', e);
    }
    try {
      this.eventEmitter.emit('statement', { playerId: player.id, playerName: player.getDisplayName(), content, day, key });
    } catch (e) {
      if (__SHOW_CONVERSATION_LOGS) console.log('[emitPlayerStatement] emit statement ERROR', e);
    }

    // CO系の発言キーは、発言時点でCO履歴にも反映する（襲撃優先ロジックが参照するため）。
    // NOTE: ユーザー発言は handleUserStatement 側で detectAndBroadcastCO を呼ぶのでここでは対象外。
    try {
      if (!(player instanceof UserPlayer) && (key === 'seer_co' || key === 'medium_co' || key === 'hunter_co')) {
        const role = key === 'seer_co' ? Role.SEER : key === 'medium_co' ? Role.MEDIUM : Role.KNIGHT;
        this.recordAndBroadcastCOFromKey(player, role, day);
      }
    } catch (e) {
      // ignore
    }
    // Ensure the player's own statement record is updated for internal lookups
    try {
      const stmt: any = { day, playerId: player.id, playerName: player.getDisplayName(), content };
      if (key) stmt.key = key;
      // call Player.recordStatement if available
      try { (player as any).recordStatement(stmt); } catch (e) { /* ignore */ }
    } catch (e) { /* ignore recording errors */ }
    try { if (__SHOW_CONVERSATION_LOGS) console.log(`[emitPlayerStatement] emitted playerId=${player.id}`); } catch (e) {}
  }
  /**
   * プレイヤーIDでプレイヤーを取得
   */
  public getPlayerById(id: number): Player | null {
    return this.players.find(p => p.id === id) || null;
  }

  /**
   * デバッグ用: 指定プレイヤーの役職を強制的に設定し、クライアントに通知する
   */
  public forceSetPlayerRole(playerId: number, role: Role | string): boolean {
    const p = this.getPlayerById(playerId);
    if (!p) return false;
    try {
      // まず同じ役職を持つ別プレイヤーを探し、見つかれば役職をスワップする
      const desiredRole = (role as any) as Role;
      console.log(`[Debug] forceSetPlayerRole called: playerId=${playerId}, desiredRole=${desiredRole}`);
      const other = this.players.find(pl => pl.id !== playerId && pl.role === desiredRole);
      if (other) {
        console.log(`[Debug] swap target found: id=${other.id}, name=${other.name}, role=${other.role}`);
        const origRole = p.role;

        // 役職文字列を入れ替え
        (p as any).role = desiredRole as any;
        (other as any).role = origRole as any;

        console.log(`[Debug] swapped roles: ${p.name}(id:${p.id}) -> ${p.role}, ${other.name}(id:${other.id}) -> ${other.role}`);

        // 可能ならば、占い師の内部データ（divinationResults 等）を移し替える
        try {
          const pHasDiv = (p as any).divinationResults !== undefined;
          const oHasDiv = (other as any).divinationResults !== undefined;
          if (pHasDiv || oHasDiv) {
            const tmp = (p as any).divinationResults || [];
            (p as any).divinationResults = (other as any).divinationResults || [];
            (other as any).divinationResults = tmp;
          }
        } catch (e) {
          // ignore internal-transfer errors
        }
      } else {
        // 対象の役職を持つプレイヤーがいなければ単純に設定
        (p as any).role = desiredRole as any;
        console.log(`[Debug] no swap target; set player ${p.name}(id:${p.id}) role -> ${p.role}`);
      }

      // ユーザー向けの割当イベント（ユーザーが対象の場合）
      if (p.name === this.userName || p.id === 1) {
        this.eventEmitter.emit('user_role_assignment', {
          playerId: p.id,
          playerName: p.name,
          icon: (p as any).icon,
          role: (p as any).role,
          team: (p as any).team,
        });
      }

      // もし他プレイヤーとスワップした場合、その相手がユーザーであれば user_role_assignment を再送
      if (other && (other.name === this.userName || other.id === 1)) {
        this.eventEmitter.emit('user_role_assignment', {
          playerId: other.id,
          playerName: other.name,
          icon: (other as any).icon,
          role: (other as any).role,
          team: (other as any).team,
        });
      }

      // 全体の役職割当を再送してクライアントを更新
      this.eventEmitter.emit('role_assignment', {
        players: this.players.map(pl => ({
          id: pl.id,
          name: pl.getDisplayName(),
          icon: (pl as any).icon,
          role: (pl as any).role,
          team: (pl as any).team,
          isAlive: pl.isAlive(),
        }))
      });
      console.log('[Debug] role_assignment emitted after forceSetPlayerRole');
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * ユーザー発言を処理
   */
  public async handleUserStatement(playerId: number, content: string): Promise<boolean> {
    const player = this.getPlayerById(playerId);
    
    if (!player || !(player instanceof UserPlayer) || !player.isAlive()) {
      return false;
    }

    if (this.phase !== Phase.DAY) {
      return false;
    }

    // ユーザー発言の禁止チェックを無効化（ユーザーが占いCOや占い結果を送信できるようにする）

    // 発言を追加
    this.statements.push({
      day: this.day,
      playerId: player.id,
      playerName: player.getDisplayName(),
      content,
    });

    this.emitPlayerStatement(player, content, this.day);
    
    // CO検出
    this.detectAndBroadcastCO(content, player);
    
    // 全プレイヤーに発言を共有
    this.players.forEach(p => p.updateStatements(this.statements));

    // 村長の護衛指示（指定/任せる）が発言された場合、狩人CO済みの狩人が了承発言する
    try {
      const c = String(content || '').trim();
      if (/^護衛先は.+にしてくれ。?$/.test(c) || /^護衛先は狩人に任せる。?$/.test(c)) {
        this.acknowledgeGuardOrderIfKnightCO(this.day || 1);
      }
    } catch (e) {
      // ignore
    }
    
    // 疑いの対象者を検出し、優先的に反応させる
    this.detectSuspicion(content);
    
    // 対抗確認要求の検出
    if (/対抗.*いますか|対抗.*ない|対抗.*いない/.test(content)) {
      // 議論テーマを全プレイヤーに伝達
      this.players.forEach(p => {
        if (!(p instanceof UserPlayer)) {
          p.setDiscussionContext(this.currentDiscussionTheme, this.lastCOPlayerName, true);
        }
      });
    }
    
    // ユーザー発言の重要度を判定
    const priority = this.getUserStatementPriority(content);
    
    // 重要度が高い発言には複数AIが強制反応（非同期で実行）
    if (priority >= 1) {
      // 自然なチャット演出: ユーザー発言の直後は少し間を置いてからAI反応させる
      setTimeout(() => {
        this.triggerMultipleAIResponse(priority).catch(err => {
          console.error('AI反応エラー:', err);
        });
      }, 700);
    }

    return true;
  }

  private acknowledgeGuardOrderIfKnightCO(day: number): void {
    try {
      if (this.aiStatementsStopped) return;
      const now = Date.now();
      if (this.lastGuardOrderAckDay === day && now - this.lastGuardOrderAckAt < 2000) return;

      const knights = this.players.filter(p => p.role === Role.KNIGHT && p.isAlive() && !(p instanceof UserPlayer));
      if (!knights || knights.length === 0) return;

      const day1CoPlayers: any[] = ((this.day1State as any)?.coPlayers) || [];
      const coHistory: any[] = (this.coHistory as any) || [];

      const coKnights = knights.filter(k => {
        try {
          const inDay1 = day1CoPlayers.some(c => c && c.playerId === k.id && c.claimedRole === Role.KNIGHT);
          if (inDay1) return true;
        } catch (e) {}
        try {
          const inHistory = coHistory.some(c => c && c.playerId === k.id && c.claimedRole === Role.KNIGHT && (c.coType === COType.TRUE_CO || c.coType === COType.CONTRADICTORY_CO));
          if (inHistory) return true;
        } catch (e) {}
        return false;
      });

      if (coKnights.length === 0) return;

      this.lastGuardOrderAckDay = day;
      this.lastGuardOrderAckAt = now;

      (async () => {
        try {
          await this.delay(600);
          for (const sp of coKnights) {
            try {
              if (this.aiStatementsStopped) break;
              if (!sp.isAlive()) continue;
              const tplAcc = (DIALOGUES[sp.name] as any)?.acknowledge || 'わかりました。';
              const accTxt = typeof tplAcc === 'string' ? tplAcc : String(tplAcc);
              this.statements.push({ day, playerId: sp.id, playerName: sp.getDisplayName(), content: accTxt });
              this.emitPlayerStatement(sp, accTxt, day, 'acknowledge');
              await this.delay(500);
            } catch (e) { /* per-knight ignore */ }
          }
        } catch (e) { /* ignore */ }
      })();
    } catch (e) {
      // ignore
    }
  }
  
  /**
   * ユーザー発言から疑いの対象を検出
   */
  private detectSuspicion(content: string): void {
    // プレイヤー名を含む疑いパターンを検出
    const suspicionPatterns = [
      /([ぁ-ん\w]+).*怪しい/,
      /([ぁ-ん\w]+).*疑わしい/,
      /([ぁ-ん\w]+).*人狼/,
      /([ぁ-ん\w]+).*嘘/,
      /([ぁ-ん\w]+).*信用できない/,
      /([ぁ-ん\w]+).*偽/,
    ];
    
    for (const pattern of suspicionPatterns) {
      const match = content.match(pattern);
      if (match && match[1]) {
        // マッチしたプレイヤー名を記録
        const suspectedName = match[1];
        const suspectedPlayer = this.players.find(p => p.name === suspectedName || p.name.includes(suspectedName));
        if (suspectedPlayer && !(suspectedPlayer instanceof UserPlayer)) {
          // 疑われたプレイヤーに強制反応フラグを設定（優先的に反応させる）
          (suspectedPlayer as any).setForceReaction(true);
        }
      }
    }
  }
  
  /**
   * CO検出と全プレイヤーへの通知（厳密な判定）
   */
  private detectAndBroadcastCO(content: string, player: Player): void {
    // CO検出ロジック：厳密な条件で「真のCO」を判定
    const coDetectionResult = this.analyzeCoStatement(content);
    
    // CO ではない場合は処理終了
    if (coDetectionResult.type === COType.NOT_CO) {
      return;
    }
    
    // 役職が検出されない場合は処理終了
    if (!coDetectionResult.role) {
      return;
    }
    
    // 矛盾CO の判定
    const playerCOHistory = this.coHistory || [];
    const previousCO = playerCOHistory.find(
      co => co.playerId === player.id && co.day === this.day && co.coType === COType.TRUE_CO
    );
    
    let finalCOType = coDetectionResult.type;
    
    if (previousCO && previousCO.claimedRole !== coDetectionResult.role) {
      // 同一プレイヤーが異なる役職をCOしている = 矛盾
      finalCOType = COType.CONTRADICTORY_CO;
      
      // ログに矛盾を記録
      this.eventEmitter.emit('log', { 
        message: `[矛盾検出] ${player.getDisplayName()}が矛盾したCOをしています（前：${this.getRoleNameJa(previousCO.claimedRole)} → 今：${this.getRoleNameJa(coDetectionResult.role)})`, 
        type: 'warning' 
      });
      
      // 矛盾COに対して複数キャラが反応するようにフラグを設定
      const alivePlayers = this.getAlivePlayers().filter(p => !(p instanceof UserPlayer));
      const responders = alivePlayers.slice(0, Math.min(3, alivePlayers.length));
      responders.forEach(p => {
        (p as any).setForceReaction(true);
      });
    }
    
    // CO履歴に記録
    if (!this.coHistory) {
      this.coHistory = [];
    }
    
    const coInfo: COInfo = {
      playerId: player.id,
      playerName: player.getDisplayName(),
      claimedRole: coDetectionResult.role,
      day: this.day,
      coType: finalCOType,
    };
    
    this.coHistory.push(coInfo);

    // 狩人COが成立した時点で「次に襲撃されそうな対象」をCO者に寄せる。
    // nightPhase 側で、狩人CO候補の中に planned があればそれを優先する。
    try {
      if (coInfo.claimedRole === Role.KNIGHT && player.isAlive() && !(player instanceof UserPlayer) && player.team !== Team.WEREWOLF) {
        this.plannedNextAttackTargetId = player.id;
      }
    } catch (e) {
      // ignore
    }
    
    // 真のCOまたは矛盾COの場合のみプレイヤーに通知
    if (finalCOType === COType.TRUE_CO || finalCOType === COType.CONTRADICTORY_CO) {
      // 全プレイヤーにCO情報を通知
      this.players.forEach(p => {
        if (p.isAlive() && p.id !== player.id) {
          p.receiveCOInfo(coInfo);
        }
      });
      
      // 議論テーマを設定
      if (coDetectionResult.role === Role.SEER) {
        this.currentDiscussionTheme = 'seer_co';
      } else if (coDetectionResult.role === Role.MEDIUM) {
        this.currentDiscussionTheme = 'medium_co';
      }
      this.lastCOPlayerName = player.name;

      // [CO検出] ログはプレイ中のノイズになりやすいので通常は表示しない。
      // デバッグ時（debugRoleMapが設定されている場合）のみ表示する。
      if (this.debugRoleMap) {
        const coTypeText = finalCOType === COType.CONTRADICTORY_CO ? '[矛盾]' : '';
        this.eventEmitter.emit('log', {
          message: `${coTypeText}[CO検出] ${player.getDisplayName()}が${this.getRoleNameJa(coDetectionResult.role)}をCO`,
          type: 'system'
        });
      }
    }
  }

  /**
   * AI側のCO（seer_co/medium_co/hunter_coキー）を、発言テキスト解析に依存せず確実に履歴へ反映する。
   * 一部キャラのCOセリフが正規表現にマッチしない場合でも、翌日の自動発言判定が崩れないようにする。
   */
  private recordAndBroadcastCOFromKey(player: Player, claimedRole: Role, day: number): void {
    try {
      if (!player) return;
      if (!this.coHistory) this.coHistory = [];

      // Avoid duplicates
      const already = (this.coHistory as any[]).some((c: any) =>
        c && c.playerId === player.id && c.day === day && c.claimedRole === claimedRole &&
        (c.coType === COType.TRUE_CO || c.coType === COType.CONTRADICTORY_CO)
      );
      if (already) return;

      // Contradiction if the same player already TRUE_CO'd a different role today
      const previousTrue = (this.coHistory as any[]).find((c: any) =>
        c && c.playerId === player.id && c.day === day && c.coType === COType.TRUE_CO
      );
      let finalCOType: COType = COType.TRUE_CO;
      if (previousTrue && previousTrue.claimedRole && previousTrue.claimedRole !== claimedRole) {
        finalCOType = COType.CONTRADICTORY_CO;
      }

      const coInfo: COInfo = {
        playerId: player.id,
        playerName: player.getDisplayName(),
        claimedRole,
        day,
        coType: finalCOType,
      };
      this.coHistory.push(coInfo);

      // 狩人COが成立した時点で「次に襲撃されそうな対象」をCO者に寄せる。
      // nightPhase 側で、狩人CO候補の中に planned があればそれを優先する。
      try {
        if (coInfo.claimedRole === Role.KNIGHT && player.isAlive() && !(player instanceof UserPlayer) && player.team !== Team.WEREWOLF) {
          this.plannedNextAttackTargetId = player.id;
        }
      } catch (e) {
        // ignore
      }

      // Notify all players (same as detectAndBroadcastCO for TRUE/CONTRADICTORY)
      if (finalCOType === COType.TRUE_CO || finalCOType === COType.CONTRADICTORY_CO) {
        this.players.forEach(p => {
          if (p.isAlive() && p.id !== player.id) {
            try { p.receiveCOInfo(coInfo); } catch (e) {}
          }
        });

        if (claimedRole === Role.SEER) this.currentDiscussionTheme = 'seer_co';
        else if (claimedRole === Role.MEDIUM) this.currentDiscussionTheme = 'medium_co';
        this.lastCOPlayerName = player.name;
      }

      // Also broadcast to UI (client uses this to track CO lists)
      try {
        const isFake = (player as any).role !== claimedRole;
        this.eventEmitter.emit('player_co', { playerId: player.id, playerName: player.getDisplayName(), claimedRole, isFake });
      } catch (e) {
        // ignore
      }
    } catch (e) {
      // ignore
    }
  }
  
  /**
   * CO文を分析して、役職と CO タイプを判定
   * @returns { role: 検出された役職（null なら非CO）, type: CO タイプ }
   */
  private analyzeCoStatement(content: string): { role: Role | null; type: COType } {
    // 否定表現が含まれる場合は無効なCO
    if (/ではない|じゃない|違う|ちがう|〜ない|ないです/.test(content)) {
      // 否定表現（例: "占い師ではない"）は CO とはみなさない
      return { role: null, type: COType.NOT_CO };
    }
    
    // 質問文は CO ではない
    // NOTE: 「COあります！」を誤って質問扱いしないよう、"あります" 単体では判定しない
    if (/\?|？|いますか|います\?|いる\?|いない\?|ありますか/.test(content)) {
      return { role: null, type: COType.NOT_CO };
    }
    
    // 一人称がない場合は CO ではない可能性
    const hasFirstPerson = /俺|私|僕|あたし|わたし|わたくし|自分|この私|うち/.test(content);
    
    // 明示的な CO パターン（「占い師COします」「霊能者です」など）
    const explicitCOPatterns = [
      { regex: /(占い師|占い|占うのは)?(CO|カミングアウト)(します|します)/, role: Role.SEER },
      { regex: /占い師(です|だ|を名乗ります)/, role: Role.SEER },
      { regex: /本当の(占い師|占い)/, role: Role.SEER },
      { regex: /(霊能者|霊能)(CO|カミングアウト)(します|します)/, role: Role.MEDIUM },
      { regex: /霊能者(です|だ|を名乗ります)/, role: Role.MEDIUM },
      { regex: /本当の(霊能者|霊能)/, role: Role.MEDIUM },
      { regex: /狩人(CO|カミングアウト)(します|します)/, role: Role.KNIGHT },
      { regex: /狩人(です|だ|を名乗ります)/, role: Role.KNIGHT },
      { regex: /村人(です|だ|を名乗ります)/, role: Role.VILLAGER },
    ];
    
    // 明示的なCOパターンをチェック
    for (const pattern of explicitCOPatterns) {
      if (pattern.regex.test(content)) {
        // 一人称がある、または「本当の」などの明確なマーカーがある場合は TRUE_CO
        if (hasFirstPerson || /本当|正体/.test(content)) {
          return { role: pattern.role, type: COType.TRUE_CO };
        }
        // あいまいな場合でも TRUE_CO 扱いにして通知する（INVALID_CO を廃止）
        return { role: pattern.role, type: COType.TRUE_CO };
      }
    }
    
    // 曖昧なパターン（一人称 + 役職名のみ）
    const ambiguousPatterns = [
      { regex: /(僕|私|俺|あたし).*(占い師|占い)/, role: Role.SEER },
      { regex: /(僕|私|俺|あたし).*(霊能者|霊能)/, role: Role.MEDIUM },
      { regex: /(僕|私|俺|あたし).*(狩人)/, role: Role.KNIGHT },
    ];
    
    for (const pattern of ambiguousPatterns) {
      if (pattern.regex.test(content)) {
        // 一人称と役職名がある場合は TRUE_CO 扱いにする（曖昧でも通知）
        return { role: pattern.role, type: COType.TRUE_CO };
      }
    }
    
    // CO ではないと判定
    return { role: null, type: COType.NOT_CO };
  }
  
  /**
   * 役職名を日本語に変換
   */
  private getRoleNameJa(role: Role): string {
    const roleNames = {
      [Role.VILLAGER]: '村人',
      [Role.WEREWOLF]: '人狼',
      [Role.SEER]: '占い師',
      [Role.MEDIUM]: '霊能者',
      [Role.KNIGHT]: '狩人',
      [Role.HUNTER]: '狩人',
      [Role.MADMAN]: '狂人',
    };
    return roleNames[role] || '不明';
  }
  
  /**
   * ユーザー発言の重要度を判定
   */
  private getUserStatementPriority(content: string): number {
    // 役職COは最優先
    if (/占い師|霊能者|狩人|CO|村人です/.test(content)) {
      return 2;
    }
    
    // 矛盾指摘や非難
    if (/矛盾|おかしい|怪しい|疑わしい/.test(content)) {
      return 2;
    }
    
    // 擁護や否定
    if (/擁護|かばう|信じる|違うと思|人狼じゃない/.test(content)) {
      return 2;
    }
    
    // 対抗確認
    if (/対抗|他に.*いますか|ありますか/.test(content)) {
      return 2;
    }
    
    // 挨拶・自己紹介
    if (/よろしく|はじめまして|こんにちは|どうも/.test(content)) {
      return 1;
    }
    
    // 役職に関する質問
    if (/役職|占い|霊能|狩人/.test(content)) {
      return 1;
    }
    
    // 投票を示唆する発言
    if (/投票|吊る|処刑|指定/.test(content)) {
      return 1;
    }
    
    // 強い口調・圧のある発言
    if (/[！!]{2,}|絶対|確実|間違いない|明らか/.test(content)) {
      return 1;
    }
    
    // 議論を強制的に進めようとする発言
    if (/決めよう|決める|まとめ|結論|進めよう/.test(content)) {
      return 1;
    }
    
    // 質問形式（「なぜ」「どうして」など）
    if (/なぜ|どうして|なんで|理由は|答えて|教えて/.test(content)) {
      return 1;
    }
    
    // 反論・弁明
    if (/違う|ちがう|誤解|身に覚え|疑われる|疑うのは/.test(content)) {
      return 1;
    }
    
    // 同意・賛成・支持
    if (/同意|賛成|支持|そう思う/.test(content)) {
      return 1;
    }
    
    return 0;
  }
  
  /**
   * 複数AIに強制反応させる（重要発言時）
   */
  private async triggerMultipleAIResponse(priority: number): Promise<void> {
    const alivePlayers = this.getAlivePlayers().filter(p => !(p instanceof UserPlayer));
    
    // 最新のユーザー発言を取得
    const latestUserStatement = this.statements
      .filter(s => s.day === this.day && s.playerId === 0)
      .slice(-1)[0];
    
    if (!latestUserStatement) return;
    
    const content = latestUserStatement.content;
    
    // 指名された本人を検出
    let targetPlayer: Player | null = null;
    for (const p of alivePlayers) {
      if (content.includes(p.name)) {
        targetPlayer = p;
        break;
      }
    }
    
    // 優先度2（CO等）の場合は最低3名、優先度1の場合は最低2名が反応
    let minResponders = priority >= 2 ? 3 : 2;
    let maxResponders = priority >= 2 ? 5 : 3;
    
    // 指名された本人がいる場合は必ず反応させる
    let guaranteedResponders: Player[] = [];
    if (targetPlayer) {
      guaranteedResponders.push(targetPlayer);
      minResponders = Math.max(2, minResponders - 1); // 本人以外の最低反応数
    }
    
    // 残りのプレイヤーからランダムに選定
    const otherPlayers = alivePlayers.filter(p => p !== targetPlayer);
    const responderCount = Math.min(
      otherPlayers.length,
      Math.max(minResponders, Math.floor(Math.random() * (maxResponders - minResponders + 1)) + minResponders)
    );
    
    // ランダムにシャッフルして選定
    const shuffled = [...otherPlayers].sort(() => Math.random() - 0.5);
    const additionalResponders = shuffled.slice(0, responderCount);
    
    // 最終的な反応者リスト
    const responders = [...guaranteedResponders, ...additionalResponders];
    
    // 選定されたAIに強制反応フラグを設定
    responders.forEach(p => {
      p.setForceReaction(true);
    });
    
    // 少し遅延してからAI発言をトリガー
    await this.delay(500);
    
    // AI発言を順次実行（時間差で）
    for (const aiPlayer of responders) {
      if (aiPlayer.isAlive()) {
        const statement = aiPlayer.makeStatement(this.day, this.getAlivePlayers(), priority);
        if (statement && statement.trim() !== '') {
          this.statements.push({
            day: this.day,
            playerId: aiPlayer.id,
            playerName: aiPlayer.getDisplayName(),
            content: statement,
          });
          
          // 発言を共有
          this.players.forEach(p => p.updateStatements(this.statements));
          
          // 条件付きでフロントへ出力
          this.emitPlayerStatement(aiPlayer, statement, this.day);
          
          await this.delay(1500); // 発言間隔
        }
      }
    }
  }
  
  /**
   * ユーザー投票を処理
   */
  public handleUserVote(playerId: number, targetId: number): boolean {
    const player = this.getPlayerById(playerId);
    
    if (!player || !(player instanceof UserPlayer) || !player.isAlive()) {
      return false;
    }

    (player as UserPlayer).setPendingVote(targetId);
    return true;
  }

  /**
   * ユーザー夜行動を処理
   */
  public handleUserNightAction(playerId: number, targetId: number): boolean {
    const player = this.getPlayerById(playerId);
    
    if (!player || !(player instanceof UserPlayer) || !player.isAlive()) {
      return false;
    }

    // role constraints: seer cannot divine themselves
    try {
      if (player.role === Role.SEER && targetId === player.id) {
        return false;
      }
    } catch (e) {
      // ignore
    }

    (player as UserPlayer).setPendingNightAction(targetId);
    
    // 待機中の場合はresolveを呼ぶ
    if (this.nightActionResolve) {
      this.nightActionResolve();
      this.nightActionResolve = null;
    }
    
    return true;
  }

  private nightActionResolve: (() => void) | null = null;

  private async waitForUserNightAction(user: UserPlayer, timeout: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.nightActionResolve = resolve;
      
      // タイムアウト処理
      setTimeout(() => {
        if (this.nightActionResolve) {
          console.log('[Game] Night action timeout, selecting random target');
          // タイムアウトの場合はランダムに選択
          const alivePlayers = this.getAlivePlayers().filter(p => p.id !== user.id);
          if (alivePlayers.length > 0) {
            const randomTarget = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
            user.setPendingNightAction(randomTarget.id);
          }
          this.nightActionResolve();
          this.nightActionResolve = null;
        }
      }, timeout);
    });
  }

  /**
   * AI発言を停止してタイマーも止める（時間は保持）
   */
  public stopPhase(): void {
    this.aiStatementsStopped = true;
    // 議論時間中：タイマーをクリアするが時間は保持（resolve は呼ばない）
    if (this.dayPhaseTimer) {
      clearInterval(this.dayPhaseTimer);
      this.dayPhaseTimer = null;
      // dayPhaseResolve は呼ばないため、次のフェーズへ移行しない
    }
    // 投票時間中：タイマーをクリアするが時間は保持
    if (this.votingTimer) {
      clearInterval(this.votingTimer);
      this.votingTimer = null;
    }
    this.eventEmitter.emit('log', { message: '【AI発言を停止しました】', type: 'section' });
    // フロントのUI切替用に通知
    this.eventEmitter.emit('paused', {
      day: this.day,
      phase: this.phase,
      dayTimeRemaining: this.dayPhaseTimeRemaining,
      votingTimeRemaining: this.votingTimeRemaining,
    });
  }

  /**
   * 停止状態から再開（タイマーと会話を続行）
   */
  public resumePhase(): void {
    if (!this.aiStatementsStopped) return;
    this.aiStatementsStopped = false;

    // 昼タイマーが停止中なら再開
    if (this.phase === Phase.DAY && this.dayPhaseTimer === null && this.dayPhaseTimeRemaining > 0 && this.dayPhaseResolve) {
      const intervalId = setInterval(() => {
        // 途中で再度停止された場合はここで止める
        if (this.aiStatementsStopped) {
          clearInterval(intervalId);
          this.dayPhaseTimer = null;
          return;
        }
        this.dayPhaseTimeRemaining--;
        this.eventEmitter.emit('day_timer_update', { timeRemaining: this.dayPhaseTimeRemaining });
        if (this.dayPhaseTimeRemaining <= 0) {
          clearInterval(intervalId);
          this.dayPhaseTimer = null;
          if (this.dayPhaseResolve) {
            this.dayPhaseResolve();
            this.dayPhaseResolve = null;
          }
        }
      }, 1000);
      this.dayPhaseTimer = intervalId as any;
    }

    // 投票タイマーが停止中なら再開（待機 Promise は保持されている）
    if (this.votingResolve && this.votingTimer === null && this.votingTimeRemaining > 0) {
      this.votingTimer = setInterval(() => {
        if (this.aiStatementsStopped) {
          if (this.votingTimer) {
            clearInterval(this.votingTimer);
            this.votingTimer = null;
          }
          return;
        }
        this.votingTimeRemaining--;
        this.eventEmitter.emit('voting_timer_update', { timeRemaining: this.votingTimeRemaining });
        if (this.votingTimeRemaining <= 0 || this.votingSkipped) {
          if (this.votingTimer) {
            clearInterval(this.votingTimer);
            this.votingTimer = null;
          }
          if (this.votingResolve) {
            this.votingResolve();
            this.votingResolve = null;
          }
        }
      }, 1000);
    }

    // 会話を再開（初日は専用フロー、以降は通常AI）
    if (this.phase === Phase.DAY) {
      const alivePlayers = this.getAlivePlayers();
      if (this.day === 1 && this.day1State && this.day1State.stage !== 'done') {
        this.runDay1FlowAsync(alivePlayers);
      } else {
        this.runAIStatementsAsync(alivePlayers);
      }
    }

    this.eventEmitter.emit('log', { message: '【再開】', type: 'section' });
    this.eventEmitter.emit('resumed', { day: this.day, phase: this.phase });
  }

  /**
   * フェーズをスキップ（タイマーを0にする）
   */
  public skipPhase(): void {
    if (this.dayPhaseTimer) {
      this.dayPhaseTimeRemaining = 0;
      this.eventEmitter.emit('day_timer_update', { timeRemaining: 0 });
    }
    // 投票時間中の場合もスキップ
    if (this.votingTimer || this.votingResolve) {
      this.votingSkipped = true;
      if (this.votingTimer) {
        clearInterval(this.votingTimer);
        this.votingTimer = null;
      }
      // 待機を解除（次の処理へ進む）
      if (this.votingResolve) {
        this.votingResolve();
        this.votingResolve = null;
      }
      this.eventEmitter.emit('voting_timer_update', { timeRemaining: 0 });
    }
  }

  /**
   * ユーザー（村長）が「投票」を押したときに呼ぶ（またはサーバー側で呼ぶ）
   */
  public proceedToVoting(): void {
    if (this.votingResolve) {
      // emit a simple proceed notification and wait 5 seconds for visual effect,
      // then resolve the voting wait so server proceeds to tally (user does not vote)
      try {
        // サーバ側での冗長なログ出力を抑制: クライアント側で投票中表示を行う
        this.eventEmitter.emit('proceed_to_voting', { day: this.day });
        // let clients show any brief animation; send duration explicitly (1s)
        this.eventEmitter.emit('voting_animation', { day: this.day, duration: 1 });
      } catch (e) {
        console.error('proceedToVoting notify error', e);
      }

      // If a mayor-designate target was set earlier (for vote), apply it now
      try {
        if (this.day1State && typeof (this.day1State.designateTargetId) === 'number' && this.day1State.designateDay === this.day) {
          const targetId = Number((this.day1State as any).designateTargetId);
          const tgt = this.getPlayerById(targetId);
          const alive = this.getAlivePlayers().filter(p => p.isAlive());
          if (tgt && alive && alive.length > 0) {
            for (const voter of alive) {
              try {
                if (voter instanceof UserPlayer) continue;
                const voteRecord: any = { day: this.day, voterId: voter.id, targetId };
                this.voteHistory.push(voteRecord);
                try { voter.updateVoteHistory(this.voteHistory); } catch (e) {}
                // 投票集計時に一覧でログ／vote イベントを送るため、ここでは重複送信しない（history のみ保存）
                // this.eventEmitter.emit('log', { message: `${voter.getDisplayName()} → ${tgt.getDisplayName()}`, type: 'vote' });
                // this.eventEmitter.emit('vote', { voterId: voter.id, voterName: voter.getDisplayName(), targetId, targetName: tgt.getDisplayName(), day: this.day });
              } catch (e) { /* per-voter ignore */ }
            }
          }
        }
      } catch (e) { /* ignore */ }

      // delay 5 seconds then resolve so server-side continues to vote tally
      setTimeout(() => {
        try {
          if (this.votingResolve) {
            this.votingResolve();
            this.votingResolve = null;
          }
        } catch (e) {
          console.error('proceedToVoting resolve error', e);
        }
      }, 1000);
    }
  }

  /**
   * ゲームをクリーンアップ（タイマーを停止）
   */
  public cleanup(): void {
    console.log('[Game] Cleaning up game instance');
    // Important: detach server-side listeners so any late async callbacks
    // (setTimeout chains, pending promises) cannot continue broadcasting events
    // after a reset.
    try {
      this.eventEmitter.removeAllListeners();
    } catch (e) {
      // ignore
    }
    if (this.dayPhaseTimer) {
      clearInterval(this.dayPhaseTimer);
      this.dayPhaseTimer = null;
    }
    if (this.votingTimer) {
      clearInterval(this.votingTimer);
      this.votingTimer = null;
    }
    if (this.nightActionResolve) {
      this.nightActionResolve();
      this.nightActionResolve = null;
    }
    if (this.dayPhaseResolve) {
      this.dayPhaseResolve = null;
    }
    if (this.votingResolve) {
      this.votingResolve = null;
    }
    this.dayPhaseTimeRemaining = 0;
    this.dayPhasePromise = null;
    this.votingSkipped = false;
    this.aiStatementCooldowns.clear();
    this.aiStatementsStopped = false;
    this.day1State = null;
    this.players = [];
    this.statements = [];
    this.voteHistory = [];
    this.day = 0;
    this.phase = Phase.DAY;
  }

  /**
   * ゲームを初期化
   */
  public async initialize(): Promise<void> {
    // 既存のタイマーをすべてクリア
    if (this.dayPhaseTimer) {
      clearInterval(this.dayPhaseTimer);
      this.dayPhaseTimer = null;
    }
    if (this.votingTimer) {
      clearInterval(this.votingTimer);
      this.votingTimer = null;
    }
    this.dayPhaseTimeRemaining = 0;
    this.votingSkipped = false;
    
    this.eventEmitter.emit('log', { message: '人狼ゲーム開始', type: 'title' });
    // GM の導入メッセージ（ユーザー指定の最小フロー）
    await this.delay(800);
    this.eventEmitter.emit('gm_message', { message: '皆さん、ようこそ。私はGM（ゲームマスター）です。' });
    await this.delay(1200);
    this.eventEmitter.emit('gm_message', { message: 'どうやらこの村には人狼が紛れて村の人たちを襲っている様です。' });
    await this.delay(1400);
    this.eventEmitter.emit('gm_message', { message: 'あなたは村長となり、人狼を全滅させて村に平和をもたらしてください。' });
    await this.delay(1400);
    this.eventEmitter.emit('gm_message', { message: 'それではまもなく1日目が始まります。' });
    await this.delay(1200);
    
    // ゲーム開始時に陣形を決定して保存（2-1, 3-1, 2-2）
    if (!this.forcedFormation) {
      const r = Math.random();
      if (r < 0.40) this.forcedFormation = '2-1';
      else if (r < 0.70) this.forcedFormation = '3-1';
      else this.forcedFormation = '2-2';
    }

    // 役職の配列を作成（9人のAI）
    // AIの役職: 村人3 / 人狼2 / 占い師1 / 霊能者1 / 狩人1 / 狂人1
    const aiRoles: Role[] = [
      Role.VILLAGER, Role.VILLAGER, Role.VILLAGER,
      Role.WEREWOLF, Role.WEREWOLF,
      Role.SEER,
      Role.MEDIUM,
      Role.KNIGHT,
      Role.MADMAN,
    ];

    // AI役職をシャッフル
    for (let i = aiRoles.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [aiRoles[i], aiRoles[j]] = [aiRoles[j], aiRoles[i]];
    }

    // キャラクターをシャッフル
    const shuffledCharacters = [...CHARACTERS];
    for (let i = shuffledCharacters.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffledCharacters[i], shuffledCharacters[j]] = [shuffledCharacters[j], shuffledCharacters[i]];
    }

    // プレイヤー作成（全員AI）
    this.players = [];
    for (let i = 0; i < 9; i++) {
      const id = i + 1;
      let role = aiRoles[i];
      // コンストラクタ経由のデバッグ割当があれば優先して適用
      if (this.debugRoleMap && this.debugRoleMap[id]) {
        try {
          role = (this.debugRoleMap[id] as unknown) as Role;
        } catch (e) {
          // ignore
        }
      }
      const character = shuffledCharacters[i % shuffledCharacters.length];
      const name = character.name;
      switch (role) {
        case Role.VILLAGER:
          this.players.push(new Villager(id, name, character));
          break;
        case Role.WEREWOLF:
          this.players.push(new Werewolf(id, name, character));
          break;
        case Role.SEER:
          this.players.push(new Seer(id, name, character));
          break;
        case Role.MEDIUM:
          this.players.push(new Medium(id, name, character));
          break;
        case Role.KNIGHT:
          this.players.push(new Knight(id, name, character));
          break;
        case Role.MADMAN:
          this.players.push(new Madman(id, name, character));
          break;
      }
    }

    // === 追加: 配役をコンソールに出力 ===
    console.log('【配役一覧】');
    this.players.forEach(p => {
      // 役職名を日本語で取得
      const roleName = this.getRoleNameJa(p.role);
      const trust = (p as any).trust !== undefined ? `${(p as any).trust}%` : 'N/A';
      console.log(`${p.name}（ID:${p.id}）: ${roleName} - 信用度: ${trust}`);
    });
    // 進行役の概念は廃止済み（表示無し）
    // （台詞まとめ出力は不要のため省略）
    
    // 全プレイヤー情報を送信（アイコン表示用）
    this.eventEmitter.emit('role_assignment', {
      players: this.players.map(p => ({
        id: p.id,
        name: p.getDisplayName(),
        icon: p.icon,
        role: p.role,
        team: p.team,
        isAlive: p.isAlive
      }))
    });

    await this.delay(800);

    this.eventEmitter.emit('log', { message: '', type: 'blank' });
    // 初期化完了イベントを通知（サーバが pending デバッグ割当を適用できるようにする）
    try {
      this.eventEmitter.emit('initialized', { players: this.players.map(p => ({ id: p.id, role: p.role })) });
    } catch (e) {
      // ignore
    }
  }

  /**
   * ゲームを実行
   */
  public async run(): Promise<void> {
    // 最初に役職を割り当てる
    await this.initialize();
    // 役職説明と「まもなく1日目」告知の後、少し間を置いてから昼フェーズへ
    await this.delay(1500);
    
    this.day = 1;

    while (true) {
      // Day has advanced: reset all designations (vote/guard/divination) to "unset".
      try { this.resetDesignationsForNewDay(); } catch (e) { /* ignore */ }
      this.eventEmitter.emit('log', { message: `【${this.day}日目】`, type: 'day' });
      this.eventEmitter.emit('day_start', { day: this.day });
      // reset mayor action counters at the start of a new day
      try { this.resetMayorCountersIfNeeded(); } catch (e) { /* ignore */ }
      // 2日目以降、GMが昨晩の襲撃結果を発表
      if (this.day >= 2) {
        await this.delay(1500);
        // Emit day-phase header before GM messages (keep parity with Day1)
        this.eventEmitter.emit('log', { message: '--- 昼フェーズ ---', type: 'phase' });
        // mark that header already emitted for this day so dayPhase() can avoid duplicate
        (this as any)._phaseHeaderEmittedDay = this.day;

        // Start the day-phase timer early so the client shows countdown during
        // morning GM messages and seer announcements (avoid client showing "集計中").
        try {
          if (!this.dayPhasePromise) this.startDayTimer();
        } catch (e) { /* ignore */ }

        const { attackTargetId, guardTargetId } = this.lastNightAttackResult;

        // 朝の発言フロー（2日目以降）
        // GM「おはようございます。昨晩の犠牲者は…」
        // ↓遅延
        // GM「〇〇さんでした。」または「いませんでした。」
        // ↓遅延
        // GM「それでは議論を開始してください。」
        this.eventEmitter.emit('gm_message', { message: 'おはようございます。昨晩の犠牲者は…' });
        await this.delay(1500);
        
        let victimMessage = 'いませんでした。';

        if (attackTargetId !== null) {
          const target = this.players.find(p => p.id === attackTargetId);

          if (guardTargetId === attackTargetId) {
            // 護衛成功
            victimMessage = 'いませんでした。';
          } else if (target) {
            // 襲撃成功
            target.kill();
            const targetName = target.name === 'あなた' ? 'あなた' : `${target.name}さん`;
            victimMessage = `${targetName}でした。`;
            this.eventEmitter.emit('attack_success', { playerId: attackTargetId, playerName: target.getDisplayName(), day: this.day });

            // ユーザーが死亡した場合、観戦モードに
            if (target instanceof UserPlayer) {
              (target as UserPlayer).setSpectatorMode();
              this.eventEmitter.emit('user_death', { reason: 'attack' });
            }

            // Post-process: If any player's fakeDivinationResults for THIS day targeted
            // the attacked player and recorded WEREWOLF, convert it to HUMAN (white).
            try {
              for (const pl of this.players) {
                try {
                  const farr: Array<any> = (pl as any).fakeDivinationResults || [];
                  let changed = false;
                  for (const rec of farr) {
                    if (rec && rec.day === this.day && rec.targetId === attackTargetId && rec.result === DivinationResult.WEREWOLF) {
                      rec.result = DivinationResult.HUMAN;
                      changed = true;
                    }
                  }
                  if (changed) {
                    try { this.eventEmitter.emit('player_memo_update', { playerId: (pl as any).id }); } catch (e) {}
                  }
                } catch (e) { /* per-player ignore */ }
              }
            } catch (e) { /* ignore overall */ }
          }
        }

        this.eventEmitter.emit('gm_message', { message: victimMessage });
        await this.delay(1500);
        if (!this.aiStatementsStopped) this.eventEmitter.emit('gm_message', { message: 'それでは議論を開始してください。' });
      }
      // 昼フェーズ
      this.phase = Phase.DAY;
      await this.dayPhase();

      // 勝利判定
      const result = this.checkWinCondition();
      if (result) {
        await this.announceResult(result);
        break;
      }

      // 夜フェーズ
      this.phase = Phase.NIGHT;
      await this.nightPhase();

      // 勝利判定
      const nightResult = this.checkWinCondition();
      if (nightResult) {
        await this.announceResult(nightResult);
        break;
      }

      this.day++;
    }
  }

  private resetDesignationsForNewDay(): void {
    // vote designate
    try {
      if (this.day1State) {
        (this.day1State as any).designateTargetId = null;
        (this.day1State as any).designateDay = undefined;
      }
    } catch (e) { /* ignore */ }

    // per-player designate intents
    try {
      for (const p of this.players) {
        try { (p as any).nextDesignateDivination = null; } catch (e) {}
        try { (p as any).nextDesignateGuard = null; } catch (e) {}
      }
    } catch (e) { /* ignore */ }
  }

  // Reset mayor counters when day increments
  private resetMayorCountersIfNeeded(): void {
    if (this.mayorCounterDay !== this.day) {
      this.mayorIndividualQuestionCount = 0;
      this.mayorAskSuspiciousCount = 0;
      this.mayorCounterDay = this.day;
    }
  }

  /**
   * 昼フェーズ（タイマー駆動型）
   */
  private async dayPhase(): Promise<void> {
    if (!((this as any)._phaseHeaderEmittedDay === this.day)) {
      this.eventEmitter.emit('log', { message: '--- 昼フェーズ ---', type: 'phase' });
    }
    this.eventEmitter.emit('phase_change', { phase: 'day', day: this.day });

    // コンソールに配役一覧を表示（デバッグ用）
    try {
      console.log('【配役一覧】');
      this.players.forEach(p => {
        const mt = (p as any).trust !== undefined ? `${(p as any).trust}%` : 'N/A';
        console.log(`${p.name}（ID:${p.id}）: ${this.getRoleNameJa(p.role)} - 信用度: ${mt}`);
      });
    } catch (e) {
      // ログ出力失敗は無視
    }

    const alivePlayers = this.getAlivePlayers();

    // その日の夜に誰が襲撃されるか(予定)を先に決めて保持しておく
    // - thinking_attack の参照元
    // - 夜フェーズで AI 人狼の実襲撃先にも使う
    try {
      this.plannedNextAttackTargetId = this.computePlannedNextAttackTargetId(this.day, alivePlayers);
    } catch (e) {
      this.plannedNextAttackTargetId = null;
    }

    this.aiStatementCooldowns.clear();
    this.aiStatementsStopped = false;
    
    // 新しい日の開始時に使用済み発言をクリア
    Player.clearUsedStatements();
    
    // 各プレイヤーの日次フラグをリセット
    this.players.forEach(p => p.resetDailyFlags());
    
    // 議論テーマをリセット
    this.currentDiscussionTheme = 'normal';
    this.lastCOPlayerName = '';

    // AI発言タスク（非同期で並行実行）
    // 初日は専用フローを実行してからAI発言開始
    if (this.day === 1) {
      this.runDay1FlowAsync(alivePlayers);
    } else {
      // Day2以降はまず朝の挨拶とcallを昼フェーズ中に確実に発行し、その後通常のAI発言を並行実行する
      try {
        await this.delay(800);
        const aliveAi = alivePlayers.filter(p => !(p instanceof UserPlayer) && p.isAlive());
        for (let i = 0; i < aliveAi.length; i++) {
          if (this.aiStatementsStopped) break;
          const ai = aliveAi[i];
          const dlg = (DIALOGUES[ai.name] || {}) as any;
          const greeting = dlg.greeting || ['おはよう！','おはようございます！','よろしくお願いします！'][Math.floor(Math.random()*3)];
          this.statements.push({ day: this.day, playerId: ai.id, playerName: ai.getDisplayName(), content: greeting });
          this.emitPlayerStatement(ai, greeting, this.day);
          await this.delay(700);
        }
        if (!this.aiStatementsStopped) await this.delay(700);
        // call emission is deferred until after seer/medium result announcements
      } catch (e) { /* ignore morning intro errors */ }

      // 挨拶とcallを投げた後、初日の占いCOがいる場合は占い結果を発言させる (Day2 向け)
      try {
        // emitDay2SeerResultsFromDay1 will internally check day1State and alive seer COs
        await this.emitDay2SeerResultsFromDay1();
      } catch (e) {
        console.log('[dayPhase] emitDay2SeerResultsFromDay1 error', e);
      }

      // After seer/medium result announcements, emit a call to start discussion
      try {
        if (!this.aiStatementsStopped) await this.delay(700);
        const callers = alivePlayers.filter(p => !(p instanceof UserPlayer) && p.isAlive());
        if (callers.length > 0) {
          const caller = callers[Math.floor(Math.random() * callers.length)];
          const dlg = (DIALOGUES[caller.name] || {}) as any;
          const callMsg = dlg.call || dlg.co_call || '議論どうしますか？';
          this.statements.push({ day: this.day, playerId: caller.id, playerName: caller.getDisplayName(), content: callMsg });
          this.emitPlayerStatement(caller, callMsg, this.day);
        }
      } catch (e) { /* ignore caller error */ }

      // 挨拶とcallを投げた後、通常のAI発言を並行実行で続ける
      this.runAIStatementsAsync(alivePlayers);
    }

    // 議論は時間制限を設けず、後続のプレイヤー操作（村長の指示）で進行します。

    // No auto-stop here; allow the game to continue past Day 2

    // 全プレイヤーに情報を共有
    this.updatePlayerInformation();

    // プレイヤー操作フェーズ（村長による指示／質問を待ちます）
    this.eventEmitter.emit('player_operation_phase', {
      day: this.day,
      alivePlayers: alivePlayers.map(p => ({ id: p.id, name: p.getDisplayName(), icon: p.icon }))
    });

    // UI側で村長が「投票」ボタンを押したら Game.proceedToVoting() を呼んでください。
    this.votingSkipped = false;
    this.aiStatementsStopped = false;
    await new Promise<void>((resolve) => {
      this.votingResolve = resolve;
    });

    // 投票集計（セクションログを抑制）
    const votes = new Map<number, number>();
    for (const player of alivePlayers) {
      await this.delay(800);
      // 投票指定があれば当日の投票を強制
      let targetId: number;
      const designateId = this.day1State?.designateTargetId;
      const designateDay = this.day1State?.designateDay;

      // designte が有効になるのは 2-1, 3-1, そして 2-2 のうち進行役がいる場合のみ
      const atDesignatePhase = designateId && designateDay === this.day;

      if (atDesignatePhase) {
        if (player instanceof UserPlayer) {
          // ユーザーは通常通り（UIでの投票）
          targetId = player.vote(this.day, alivePlayers);
        } else if (player.id === designateId) {
          // 指名された人は、自分自身を除き、可能なら確定白を避けたランダム相手に投票
          let picks = alivePlayers.filter(p => p.id !== designateId && !((p as any).confirmedWhite));
          if (picks.length === 0) picks = alivePlayers.filter(p => p.id !== designateId);
          if (picks.length === 0) targetId = -1;
          else targetId = picks[Math.floor(Math.random() * picks.length)].id;
        } else {
          // ユーザーと指名対象以外は全員指名対象に投票
          targetId = designateId as number;
        }
      } else {
        targetId = player.vote(this.day, alivePlayers);
      }
      
      // 無投票（-1）の場合はスキップ
      if (targetId === -1) {
        this.eventEmitter.emit('log', { 
          message: `${player.getDisplayName()}は投票しませんでした`, 
          type: 'vote' 
        });
        continue;
      }
      
      const target = this.players.find(p => p.id === targetId);
      
      if (target) {
        votes.set(targetId, (votes.get(targetId) || 0) + 1);
        this.voteHistory.push({
          day: this.day,
          voterId: player.id,
          targetId: targetId,
        });
        const message = `${player.getDisplayName()} → ${target.getDisplayName()}`;
        this.eventEmitter.emit('log', { message, type: 'vote' });
        this.eventEmitter.emit('vote', { voterId: player.id, voterName: player.getDisplayName(), targetId, targetName: target.getDisplayName(), day: this.day });
      }
    }
    this.eventEmitter.emit('log', { message: '', type: 'blank' });

    // 最多得票者を処刑（同数の場合はランダムに選択）
    let maxVotes = 0;
    const maxVotedPlayerIds: number[] = [];
    votes.forEach((count, playerId) => {
      if (count > maxVotes) {
        maxVotes = count;
        maxVotedPlayerIds.length = 0;
        maxVotedPlayerIds.push(playerId);
      } else if (count === maxVotes && count > 0) {
        maxVotedPlayerIds.push(playerId);
      }
    });

    const executedId = maxVotedPlayerIds.length > 0 
      ? maxVotedPlayerIds[Math.floor(Math.random() * maxVotedPlayerIds.length)]
      : -1;

    if (executedId !== -1) {
      const executed = this.players.find(p => p.id === executedId);
      if (executed) {
        executed.kill();
        this.executedPlayerIds.push(executedId);
        const message = `【処刑】${executed.getDisplayName()}が処刑されました。`;
        this.eventEmitter.emit('log', { message, type: 'execution' });
        this.eventEmitter.emit('execution', { playerId: executedId, playerName: executed.getDisplayName(), role: executed.role, day: this.day });
        // Immediately record medium results for all medium players so memos exist
        // even if night-phase processing is skipped or delayed (ensures day3+ availability).
        try {
          const wasWerewolfNow = executed.role === Role.WEREWOLF;
          const immediateMediumResult: MediumResult = wasWerewolfNow ? MediumResult.WEREWOLF : MediumResult.HUMAN;
          const mediumPlayersAll = this.players.filter(p => p.role === Role.MEDIUM) || [];
          for (const mp of mediumPlayersAll) {
            try {
              if (typeof (mp as any).addMediumResult === 'function') {
                (mp as any).addMediumResult({ day: this.day, targetId: executedId, result: immediateMediumResult });
                try { this.eventEmitter.emit('player_memo_update', { playerId: mp.id }); } catch (e) {}
              }
            } catch (e) { /* ignore per-medium errors */ }
          }
        } catch (e) { /* ignore immediate medium recording errors */ }
        
        // ユーザーが死亡した場合、観戦モードに
        if (executed instanceof UserPlayer) {
          (executed as UserPlayer).setSpectatorMode();
          this.eventEmitter.emit('user_death', { reason: 'execution' });
        }
        
        // 霊能者への結果通知は夜フェーズで行う（重複を避けるため）
      }
    }
  }

  /**
   * 初日専用の進行フロー（非同期実行）
   */
  private async runDay1FlowAsync(alivePlayers: Player[]): Promise<void> {
    try {
      await this.runDay1Flow(alivePlayers);
      // 初日フロー完了後、通常のAI発言を開始
      if (!this.aiStatementsStopped) {
        this.runAIStatementsAsync(alivePlayers);
      }
    } catch (error) {
      console.error('Day 1 flow error:', error);
    }
  }

  /**
   * クールダウンの残り時間を取得
   */
  private getRemainingCooldown(playerId: number): number {
    const lastTime = this.aiStatementCooldowns.get(playerId) || 0;
    const elapsed = Date.now() - lastTime;
    return Math.max(0, this.aiStatementCooldownTime - elapsed);
  }

  /**
   * AI発言を並行実行
   */
  private async runAIStatementsAsync(alivePlayers: Player[]): Promise<void> {
    if (this.aiStatementsStopped) {
      return;
    }
    const aiPlayers = alivePlayers.filter(p => !(p instanceof UserPlayer));
    
    // 各AIプレイヤーに対して発言させる
    const statementPromises = aiPlayers.map(async (player) => {
      while (this.phase === Phase.DAY && this.dayPhaseTimeRemaining > 0) {
        if (this.aiStatementsStopped) {
          break;
        }
        
        const cooldownRemaining = this.getRemainingCooldown(player.id);
        if (cooldownRemaining > 0) {
          await this.delay(1000);
          continue;
        }

        // 時間切れチェック
        if (this.dayPhaseTimeRemaining <= 0) {
          break;
        }

        // 一時停止フラグが立っている間は短時間待機してループ継続（外部で resume されるのを待つ）
        while (this.suspendAIStatements) {
          if (this.aiStatementsStopped) break;
          await this.delay(200);
        }

        // 最新のユーザー発言の優先度を判定
        const latestUserStatement = this.statements
          .filter(s => s.day === this.day && s.playerId === 0)
          .slice(-1)[0];
        
        let userPriority = 0;
        if (latestUserStatement) {
          userPriority = this.getUserStatementPriority(latestUserStatement.content);
        }

        // 発言生成
        const statement = player.makeStatement(this.day, alivePlayers, userPriority);
        
        // 空文字列の場合はスキップ
        if (!statement || statement.trim() === '') {
          await this.delay(5000);
          continue;
        }
        
        this.statements.push({
          day: this.day,
          playerId: player.id,
          playerName: player.getDisplayName(),
          content: statement,
        });
        
        // 中央のフィルタ経由で発言を送出（昼フェーズの許可リスト等が適用される）
        this.emitPlayerStatement(player, statement, this.day);

        // クールダウン更新
        this.aiStatementCooldowns.set(player.id, Date.now());

        // ランダム待機（2-5秒）
        await this.delay(2000 + Math.random() * 3000);
      }
    });

    // 全AI発言が完了するまで待つ（ただしタイマーに制限される）
    await Promise.allSettled(statementPromises);
  }

  /**
   * 夜フェーズ
   */
  private async nightPhase(): Promise<void> {
    await this.delay(2000);
    this.eventEmitter.emit('log', { message: '--- 夜フェーズ ---', type: 'phase' });
    this.eventEmitter.emit('phase_change', { phase: 'night', day: this.day });

    const alivePlayers = this.getAlivePlayers();
    const userPlayer = this.players.find(p => p instanceof UserPlayer) as UserPlayer;
    let attackTargetId: number | null = null;
    let guardTargetId: number | null = null;
    let divinationTargetId: number | null = null;

    // GMによる各役職への質問（占師→霊能者→狩人→人狼）
    
    // 占い師フェーズ
    const seer = alivePlayers.find(p => p.role === Role.SEER);
    if (seer) {
      // Mayor designate support: if the seer has a designated target, ensure the candidate list contains it.
      let preDesignatedSeerTarget: number | null = null;
      try {
        const d = (seer as any).nextDesignateDivination;
        if (typeof d === 'number') {
          if (d === seer.id) {
            // seer cannot divine themselves; clear invalid designation
            try { (seer as any).nextDesignateDivination = null; } catch (e) { /* ignore */ }
            preDesignatedSeerTarget = null;
          } else {
            preDesignatedSeerTarget = d;
          }
        }
      } catch (e) { /* ignore */ }

      if (userPlayer?.role === Role.SEER && userPlayer.isAlive()) {
        await this.delay(1500);
        this.eventEmitter.emit('gm_message', { message: '占い師さん、今夜誰を占いますか？' });
        
        // ユーザーに選択UIを表示
        this.eventEmitter.emit('night_action_request', {
          role: 'seer',
          alivePlayers: alivePlayers
            .filter(p => p.id !== userPlayer.id)
            .map(p => ({
              id: p.id,
              name: p.getDisplayName(),
              icon: p.icon
            }))
        });
        
        // ユーザーの選択を待つ（最大30秒）
        await this.waitForUserNightAction(userPlayer, 30000);
      }
      
      // For AI seer on day>=2, exclude already-divined players and role-CO players from candidates
      let seerAliveForAction = alivePlayers;
      try {
        if (!(seer instanceof UserPlayer) && this.day >= 2) {
          const divs = (seer as any).divinationResults || [];
          const divIds = new Set<number>(divs.map((d: any) => d.targetId));
          // also include any fake divination targets so AI seer avoids them
          try {
            const fdivs: Array<any> = (seer as any).fakeDivinationResults || [];
            fdivs.forEach((d: any) => { if (d && typeof d.targetId === 'number') divIds.add(d.targetId); });
          } catch (e) { /* ignore */ }
          const coIds = new Set<number>();
          (this.day1State?.coPlayers || []).forEach((c: any) => coIds.add(c.playerId));
          (this.coHistory || []).forEach((c: any) => coIds.add(c.playerId));
          seerAliveForAction = alivePlayers.filter(p => p.id !== seer.id && !divIds.has(p.id) && !coIds.has(p.id));
          if (seerAliveForAction.length === 0) seerAliveForAction = alivePlayers.filter(p => p.id !== seer.id);
        }
      } catch (e) { seerAliveForAction = alivePlayers; }

      // If designated, override filtering so the designated target is selectable.
      try {
        if (!(seer instanceof UserPlayer) && typeof preDesignatedSeerTarget === 'number') {
          seerAliveForAction = alivePlayers.filter(p => p.id !== seer.id);
          const designatedPlayer = alivePlayers.find(p => p.id === preDesignatedSeerTarget);
          if (designatedPlayer && designatedPlayer.id !== seer.id && !seerAliveForAction.some(p => p.id === designatedPlayer.id)) {
            seerAliveForAction = seerAliveForAction.concat([designatedPlayer]);
          }
        }
      } catch (e) { /* ignore */ }

      // attach formation to the array for seer to reference
      (seerAliveForAction as any).formation = this.day1State?.formation;

      // If mayor designated a target and it is valid, always honor it.
      let targetId: number | null = null;
      let lockedByDesignation = false;
      try {
        if (typeof preDesignatedSeerTarget === 'number') {
          const tgt = alivePlayers.find(p => p.id === preDesignatedSeerTarget);
          if (tgt && tgt.isAlive() && preDesignatedSeerTarget !== seer.id) {
            targetId = preDesignatedSeerTarget;
            lockedByDesignation = true;
            try { (seer as any).nextDesignateDivination = null; } catch (e) {}
            try {
              const nh: Array<any> = (seer as any).nightActionHistory || [];
              nh.push({ day: this.day, variable: 'designate', targetId: preDesignatedSeerTarget });
              (seer as any).nightActionHistory = nh;
            } catch (e) {}
          }
        }
      } catch (e) { /* ignore */ }

      // Try calling seer.nightAction multiple times if it returns null or an invalid target
      try {
        const maxAttempts = 8;
        let attempts = 0;
        const divIds = new Set<number>(((seer as any).divinationResults || []).map((d: any) => d.targetId));
        const fakeIds = new Set<number>(((seer as any).fakeDivinationResults || []).map((d: any) => d.targetId));
        const coIds = new Set<number>();
        (this.day1State?.coPlayers || []).forEach((c: any) => coIds.add(c.playerId));
        (this.coHistory || []).forEach((c: any) => coIds.add(c.playerId));
        try { console.log(`[TRACE seer pre] seer=${(seer as any).id} divIds=${Array.from(divIds)} coIds=${Array.from(coIds)} fakeIds=${Array.from(fakeIds)} seerAliveForAction=${(seerAliveForAction||[]).map((p:any)=>p.id)}`); } catch(e) {}

        while (!lockedByDesignation && attempts < maxAttempts) {
          attempts++;
          try {
            const picked = seer.nightAction(this.day, seerAliveForAction);
            if (picked === null) {
              continue;
            }

            // If this pick came from a mayor designation, accept it as long as it's alive and not self.
            if (typeof preDesignatedSeerTarget === 'number' && picked === preDesignatedSeerTarget) {
              const tgt = alivePlayers.find(p => p.id === picked);
              if (tgt && tgt.isAlive() && picked !== seer.id) {
                targetId = picked;
                lockedByDesignation = true;
                try { (seer as any).nextDesignateDivination = null; } catch (e) {}
                try {
                  const nh: Array<any> = (seer as any).nightActionHistory || [];
                  nh.push({ day: this.day, variable: 'designate', targetId: picked });
                  (seer as any).nightActionHistory = nh;
                } catch (e) {}
                break;
              }
            }

            // if invalid, retry
            const tgt = alivePlayers.find(p => p.id === picked);
            if (!tgt || !tgt.isAlive() || picked === seer.id) {
              continue;
            }
            // if already-divined or CO, treat as invalid and retry
            if (divIds.has(picked) || fakeIds.has(picked) || coIds.has(picked)) {
              continue;
            }

            targetId = picked;
            break;
          } catch (e) {
            continue;
          }
        }

        // Final fallback: pick any alive non-self if still null
        if (!lockedByDesignation && targetId === null) {
          const poolAll = (seerAliveForAction || []).filter((p: any) => p.id !== seer.id && p.isAlive && p.isAlive());
          const poolFiltered = poolAll.filter((p: any) => {
            try { return !divIds.has(p.id) && !fakeIds.has(p.id) && !coIds.has(p.id); } catch (e) { return true; }
          });
          try { console.log(`[TRACE seer fallback] seer=${(seer as any).id} poolAll=${poolAll.map((p:any)=>p.id)} poolFiltered=${poolFiltered.map((p:any)=>p.id)}`); } catch(e) {}
          if (poolFiltered && poolFiltered.length > 0) {
            targetId = poolFiltered[Math.floor(Math.random() * poolFiltered.length)].id;
          } else {
            targetId = null;
          }
        }
      } catch (e) {
        if (!lockedByDesignation) targetId = null;
      }

      if (targetId !== null) {
        // Ensure the chosen target isn't one this seer already divined / fake-divined / noted
        try {
          if (lockedByDesignation) {
            // 指定は常に優先（重複回避で上書きしない）
          } else {
          const prevIds = new Set<number>();
          try { ((seer as any).divinationResults || []).forEach((d: any) => { if (d && typeof d.targetId === 'number') prevIds.add(d.targetId); }); } catch(e){}
          try { ((seer as any).fakeDivinationResults || []).forEach((d: any) => { if (d && typeof d.targetId === 'number') prevIds.add(d.targetId); }); } catch(e){}
          try { ((seer as any).nightActionHistory || []).forEach((d: any) => { if (d && typeof d.targetId === 'number') prevIds.add(d.targetId); }); } catch(e){}
          // also include announced memo if exists
          try { const la = (seer as any).lastAnnouncedDivination; if (la && typeof la.targetId === 'number') prevIds.add(la.targetId); } catch(e){}
          if (prevIds.has(targetId)) {
            // pick alternative from alivePlayers excluding prevIds and coIds and self
            const coIds = new Set<number>();
            try { (this.day1State?.coPlayers || []).forEach((c: any) => coIds.add(c.playerId)); } catch(e){}
            try { (this.coHistory || []).forEach((c: any) => coIds.add(c.playerId)); } catch(e){}
            const altCandidates = alivePlayers.filter(p => p.id !== seer.id && p.isAlive() && !prevIds.has(p.id) && !coIds.has(p.id));
            if (altCandidates.length > 0) {
              targetId = altCandidates[Math.floor(Math.random() * altCandidates.length)].id;
            } else {
              // no alternative: keep original (fallback)
            }
          }
          }
        } catch (e) {
          // ignore selection-guard errors
        }
        divinationTargetId = targetId;
        const target = this.players.find(p => p.id === targetId);
        const result: DivinationResult = 
          target?.role === Role.WEREWOLF ? DivinationResult.WEREWOLF : DivinationResult.HUMAN;
        
        if (userPlayer?.role === Role.SEER && userPlayer.isAlive()) {
          await this.delay(1000);
          const resultText = result === DivinationResult.WEREWOLF ? '人狼' : '人狼ではありません';
          const targetName = target?.name === 'あなた' ? 'あなた' : `${target?.name}さん`;
          this.eventEmitter.emit('gm_message', { message: `${targetName}は${resultText}。` });
        }
        
        // 占い師に結果を通知
        if (seer.role === Role.SEER && seer instanceof Seer) {
          try { console.log(`[TRACE game:addDivinationResult] seer=${seer.id} day=${this.day} target=${divinationTargetId} result=${result}`); } catch(e) {}
          // record divination for the following day (morning when announced)
          seer.addDivinationResult(this.day + 1, divinationTargetId, result);
          try { this.eventEmitter.emit('player_memo_update', { playerId: seer.id }); } catch (e) {}
          // do not add artificial nightActionHistory entries for default (non-designate) seer actions
        }

        // 確定情報を全AIに共有（再計算用）
        if (typeof divinationTargetId === 'number') {
          this.players.forEach(p => {
            if (p.isAlive()) {
              try { p.onDivinationInfo(this.day, divinationTargetId as number, result); } catch (e) {}
            }
          });
        }
      }
    }

    // --- 偽占い師向け: 夜にメモを作る（偽占い師は実際には占えないため、結果はランダム）
    try {
      const state = this.day1State;
      if (state && state.coPlayers && state.coPlayers.length > 0) {
        const fakeSeerCos = state.coPlayers.filter(c => c.claimedRole === Role.SEER && c.isFake);
        for (const c of fakeSeerCos) {
          const fakePlayer = this.players.find(p => p.id === c.playerId);
          if (!fakePlayer || !fakePlayer.isAlive()) continue;

          // 対象選定: デフォルトは自分とユーザーを除く生存者
          // また、偽占いの夜行動に役職COや実際の占い師が含まれないよう除外する
          let candidates = alivePlayers.filter(p => p.id !== fakePlayer.id && p.id !== 1);
          try {
            const stateCoIds = new Set<number>((state?.coPlayers || []).map((c: any) => c.playerId));
            candidates = candidates.filter(p => p.role !== Role.SEER && !stateCoIds.has(p.id));
          } catch (e) { /* ignore */ }
          // 2日目以降は白確や役職COのプレイヤーを除外して選出
          if (this.day >= 2) {
            const excludeIds = new Set<number>((state.whitelistIds || []).slice());
            state.coPlayers.forEach(cp => excludeIds.add(cp.playerId));
            // Also exclude any players who later CO'd (recorded in coHistory)
            (this.coHistory || []).forEach((c: any) => excludeIds.add(c.playerId));
            // 除外: 偽占い師自身が既にメモしている対象
            try {
              const existing1 = (fakePlayer as any).divinationResults || [];
              const existing2 = (fakePlayer as any).fakeDivinationResults || [];
              for (const d of existing1) { if (d && typeof d.targetId === 'number') excludeIds.add(d.targetId); }
              for (const d of existing2) { if (d && typeof d.targetId === 'number') excludeIds.add(d.targetId); }
            } catch (e) {}
            candidates = candidates.filter(p => !excludeIds.has(p.id));
          }
          if (candidates.length === 0) {
            candidates = alivePlayers.filter(p => p.id !== fakePlayer.id && p.id !== 1);
            if (candidates.length === 0) continue;
          }

          // If mayor designated this (fake) seer, prioritize that target.
          let target = candidates[Math.floor(Math.random() * candidates.length)];
          try {
            const designated = (fakePlayer as any).nextDesignateDivination;
            if (typeof designated === 'number') {
              try { (fakePlayer as any).nextDesignateDivination = null; } catch (e) {}
              const designatedPlayer = alivePlayers.find(p => p.id === designated && p.isAlive() && p.id !== fakePlayer.id && p.id !== 1);
              if (designatedPlayer) {
                target = designatedPlayer;
                try {
                  const nh = (fakePlayer as any).nightActionHistory || [];
                  nh.push({ day: this.day, variable: 'designate', targetId: designatedPlayer.id });
                  (fakePlayer as any).nightActionHistory = nh;
                } catch (e) { /* ignore */ }
              }
            }
          } catch (e) { /* ignore */ }

          let divRes = Math.random() < 0.5 ? DivinationResult.HUMAN : DivinationResult.WEREWOLF;
          // If the fake seer is a werewolf and the chosen target is also a werewolf,
          // force the fake result to be HUMAN (white) to avoid exposing werewolves.
          try {
            if ((fakePlayer as any).role === Role.WEREWOLF && target.role === Role.WEREWOLF) {
              divRes = DivinationResult.HUMAN;
            }
          } catch (e) { /* ignore */ }

          // Select a variable for fake seer nightAction and record it in nightActionHistory
          try {
            // If designate was used above, it already recorded 'designate'. Otherwise record a random variable.
            const nhExisting = (fakePlayer as any).nightActionHistory || [];
            const alreadyRecorded = nhExisting.some((d: any) => d && d.day === this.day && d.targetId === target.id && d.variable === 'designate');
            if (!alreadyRecorded) {
              const vars = ['low_talk','line','not_looking','shaken','scary_if_wolf','intuition'];
              const variable = vars[Math.floor(Math.random() * vars.length)];
              nhExisting.push({ day: this.day, variable, targetId: target.id });
              (fakePlayer as any).nightActionHistory = nhExisting;
            }
          } catch (e) { /* ignore */ }

          // メモを保存: Seer インスタンスなら addDivinationResult を使い、そうでなければ fakeDivinationResults 配列に格納
          if ((fakePlayer as any).addDivinationResult) {
            try { console.log(`[TRACE game:fake addDivinationResult] fake=${fakePlayer.id} day=${this.day} target=${target.id} result=${divRes}`); } catch(e) {}
            try { (fakePlayer as any).addDivinationResult(this.day + 1, target.id, divRes); } catch (e) { /* ignore */ }
            } else {
            const arr = (fakePlayer as any).fakeDivinationResults || [];
            arr.push({ day: this.day + 1, targetId: target.id, result: divRes });
            // コピーして別インスタンス化することで他プレイヤーと同一参照にならないようにする
            (fakePlayer as any).fakeDivinationResults = arr.map((d: any) => ({ day: d.day, targetId: d.targetId, result: d.result }));
          try { this.eventEmitter.emit('player_memo_update', { playerId: fakePlayer.id }); } catch (e) {}
          }

          // 偽占いの結果も全AIに共有（疑いスコア再計算のため） - record for the following day
          this.players.forEach(p => {
            if (p.isAlive()) p.onDivinationInfo(this.day + 1, target.id, divRes);
          });
        }
      }
    } catch (e) {
      // ignore
    }

    // 霊能者フェーズ（処刑者がいる場合、初日以降）
    // 注: 初日昼に処刑がある場合（稀だが）、初日夜に霊能結果が出る
    if (this.day >= 1) {
      const medium = alivePlayers.find(p => p.role === Role.MEDIUM);
      if (medium && this.executedPlayerIds.length > 0) {
        // 今日の処刑者が未処理の場合のみ処理（重複を避ける）
        const lastExecuted = this.executedPlayerIds[this.executedPlayerIds.length - 1];
        if (lastExecuted !== undefined) {
          const executed = this.players.find(p => p.id === lastExecuted);
          const wasWerewolf = executed?.role === Role.WEREWOLF;
          const resultText = wasWerewolf ? '人狼でした' : '人狼ではありませんでした';
          const executedName = executed?.name === 'あなた' ? 'あなた' : `${executed?.name}さん`;
          
          // 全霊能者（ユーザー＆AI）に結果を通知
          const mediumPlayers = alivePlayers.filter(p => p.role === Role.MEDIUM);

          // ユーザー霊能者にGMメッセージを表示
          if (userPlayer?.role === Role.MEDIUM && userPlayer.isAlive()) {
            await this.delay(1500);
            const gmMessage = `霊能者の方、本日処刑された${executedName}は${resultText}。`;
            this.eventEmitter.emit('gm_message', { message: gmMessage });
          }

          // AI霊能者に結果を記録
          for (const mediumPlayer of mediumPlayers) {
            if (mediumPlayer instanceof Medium) {
              const mediumResult: MediumResult = wasWerewolf ? MediumResult.WEREWOLF : MediumResult.HUMAN;
              mediumPlayer.addMediumResult({
                day: this.day,
                targetId: lastExecuted,
                result: mediumResult
              });
              try { this.eventEmitter.emit('player_memo_update', { playerId: mediumPlayer.id }); } catch (e) {}
            }
          }

          // 確定情報を全AIに共有（再計算用）
          const mediumResultForAll: MediumResult = wasWerewolf ? MediumResult.WEREWOLF : MediumResult.HUMAN;
          this.players.forEach(p => {
            if (p.isAlive()) {
              p.onMediumInfo(this.day, lastExecuted, mediumResultForAll);
            }
          });

          // --- 追加: 偽霊能者向けメモを作成し共有 ---
          try {
            const fakeMediumCOs = ((this.day1State && (this.day1State as any).coPlayers) || []).filter((c: any) => c.claimedRole === Role.MEDIUM && c.isFake).map((c: any) => this.getPlayerById(c.playerId)).filter((p: Player | null): p is Player => !!p && p.isAlive());
            for (const fakeMed of fakeMediumCOs) {
              try {
                // target is same as real medium (last executed)
                const fakeRes = Math.random() < 0.5 ? MediumResult.WEREWOLF : MediumResult.HUMAN;
                const arr = (fakeMed as any).fakeMediumResults || [];
                arr.push({ day: this.day, targetId: lastExecuted, result: fakeRes });
                (fakeMed as any).fakeMediumResults = arr;
                try { this.eventEmitter.emit('player_memo_update', { playerId: fakeMed.id }); } catch (e) {}

                // Share fake medium info to all AI (to affect suspicion similar to fake seer)
                this.players.forEach(p => { if (p.isAlive()) p.onMediumInfo(this.day, lastExecuted, fakeRes); });
              } catch (e) { /* per-fake-medium ignore */ }
            }
          } catch (e) { /* ignore fake medium generation errors */ }
        }
      }
    }

    // 狩人フェーズ
    const knight = alivePlayers.find(p => p.role === Role.KNIGHT);
    if (knight) {
      if (userPlayer?.role === Role.KNIGHT && userPlayer.isAlive()) {
        await this.delay(1500);
        this.eventEmitter.emit('gm_message', { message: '狩人さん、今夜誰を守りますか？' });
      }
      const targetId = knight.nightAction(this.day, alivePlayers);
      if (targetId !== null) {
        guardTargetId = targetId;
      }
    }

    // 人狼フェーズ
    const werewolves = alivePlayers.filter(p => p.role === Role.WEREWOLF);
    if (werewolves.length > 0) {
      if (userPlayer?.role === Role.WEREWOLF && userPlayer.isAlive()) {
        await this.delay(1500);
        this.eventEmitter.emit('gm_message', { message: '人狼さん、今夜誰を襲撃しますか？' });
      }
      // テストモード: ユーザーを襲撃対象から除外
      const targetsExcludingUser = alivePlayers.filter(p => p.id !== 1);
      // 陣形情報を狼に渡す（狼の nightAction で参照するための便宜的な付与）
      (targetsExcludingUser as any).formation = this.day1State?.formation;

      // 最優先: 公開狩人CO者（ただしユーザー人狼がいる場合はユーザー選択を尊重）
      const hasUserWerewolf = werewolves.some(w => w instanceof UserPlayer);
      const knightCOCandidates = this.getAliveKnightCOCandidates(targetsExcludingUser);
      if (!hasUserWerewolf && knightCOCandidates.length > 0) {
        // 「狩人COが出た時点で襲撃対象がそのCO者になる」ように、planned が候補にいるならそれを最優先。
        let chosen = knightCOCandidates[Math.floor(Math.random() * knightCOCandidates.length)];
        try {
          const planned = this.plannedNextAttackTargetId;
          if (typeof planned === 'number') {
            const plannedCandidate = knightCOCandidates.find(p => p.id === planned);
            if (plannedCandidate) chosen = plannedCandidate;
          }
        } catch (e) {}
        attackTargetId = chosen.id;
        // 人狼の内部履歴(attackHistory/thoughtLog)を更新して、次回の夜行動ロジックが壊れないようにする
        for (const ww of werewolves) {
          try {
            const ah: Array<any> = (ww as any).attackHistory || [];
            ah.push({ day: this.day, targetId: attackTargetId });
            (ww as any).attackHistory = ah;
          } catch (e) {}
          try {
            const tgtName = this.getPlayerById(attackTargetId as number)?.getDisplayName() || String(attackTargetId);
            const tl: Array<any> = (ww as any).thoughtLog || [];
            tl.push({ day: this.day, thought: `${tgtName}を襲撃対象に選択（狩人CO優先）` });
            (ww as any).thoughtLog = tl;
          } catch (e) {}
        }
      } else {

      // 予定があり、かつ人狼が全員AIの場合は「予定」を実襲撃にも採用して整合性を取る
      const planned = this.plannedNextAttackTargetId;
      const plannedValid = typeof planned === 'number' && targetsExcludingUser.some(p => p.id === planned && p.isAlive() && p.team !== Team.WEREWOLF);

      if (!hasUserWerewolf && plannedValid) {
        attackTargetId = planned as number;
        // 人狼の内部履歴(attackHistory/thoughtLog)を更新して、次回の夜行動ロジックが壊れないようにする
        for (const ww of werewolves) {
          try {
            const ah: Array<any> = (ww as any).attackHistory || [];
            ah.push({ day: this.day, targetId: attackTargetId });
            (ww as any).attackHistory = ah;
          } catch (e) {}
          try {
            const tgtName = this.getPlayerById(attackTargetId as number)?.getDisplayName() || String(attackTargetId);
            const tl: Array<any> = (ww as any).thoughtLog || [];
            tl.push({ day: this.day, thought: `${tgtName}を襲撃対象に選択（予定優先）` });
            (ww as any).thoughtLog = tl;
          } catch (e) {}
        }
      } else {
        // 複数いる場合は最後の選択を採用
        for (const werewolf of werewolves) {
          const targetId = werewolf.nightAction(this.day, targetsExcludingUser);
          if (targetId !== null) {
            attackTargetId = targetId;
          }
        }
      }
      }
    }

    // 襲撃処理（結果は朝に発表）
    this.lastNightAttackResult = { attackTargetId, guardTargetId };

    // 次の昼に再計算するのでクリア
    this.plannedNextAttackTargetId = null;
  }

  private computePlannedNextAttackTargetId(day: number, alivePlayers: Player[]): number | null {
    const werewolves = alivePlayers.filter(p => p.role === Role.WEREWOLF && !(p instanceof UserPlayer));
    if (werewolves.length === 0) return null;

    const targetsExcludingUser = alivePlayers.filter(p => p.id !== 1);
    (targetsExcludingUser as any).formation = this.day1State?.formation;

    // 最優先: 公開CO(初日状態/CO履歴)に基づく生存狩人CO者
    const knightCOCandidates = this.getAliveKnightCOCandidates(targetsExcludingUser);
    if (knightCOCandidates.length > 0) {
      return knightCOCandidates[Math.floor(Math.random() * knightCOCandidates.length)].id;
    }

    let picked: number | null = null;
    for (const ww of werewolves) {
      const t = this.predictWerewolfAttackTarget(ww, day, targetsExcludingUser);
      if (t !== null) picked = t; // nightPhase と合わせて「最後の選択」を採用
    }
    return picked;
  }

  private getAliveKnightCOCandidates(alivePlayers: Player[]): Player[] {
    const coIds = new Set<number>();

    // 初日進行の状態に残っているCO（isFakeでも「COした事実」として扱う）
    const day1CoPlayers: any[] = ((this.day1State as any)?.coPlayers) || [];
    try {
      for (const c of day1CoPlayers) {
        if (c && c.claimedRole === Role.KNIGHT && typeof c.playerId === 'number') coIds.add(c.playerId);
      }
    } catch (e) {}

    // CO履歴（TRUE_CO / CONTRADICTORY_CO を採用）
    try {
      for (const c of (this.coHistory || [])) {
        if (!c) continue;
        if (c.claimedRole !== Role.KNIGHT) continue;
        if (c.coType !== COType.TRUE_CO && c.coType !== COType.CONTRADICTORY_CO) continue;
        coIds.add(c.playerId);
      }
    } catch (e) {}

    if (coIds.size === 0) return [];

    return alivePlayers.filter(p => p.isAlive() && p.team !== Team.WEREWOLF && coIds.has(p.id));
  }

  // Werewolf.nightAction を「副作用なし」で近似（attackHistory/thoughtLog を更新しない）
  private predictWerewolfAttackTarget(werewolf: Player, day: number, alivePlayers: Player[]): number | null {
    const nonWere = alivePlayers.filter(p => p.id !== (werewolf as any).id && p.team !== Team.WEREWOLF);
    if (nonWere.length === 0) return null;

    const coInfoList: Array<any> = (werewolf as any).coInfoList || [];
    const attackHistory: Array<any> = (werewolf as any).attackHistory || [];

    const selectRandom = (arr: Player[]) => arr[Math.floor(Math.random() * arr.length)];

    // 最優先: 公開CO(初日状態/CO履歴)に基づく生存狩人CO者
    const knightCOCandidates = this.getAliveKnightCOCandidates(alivePlayers).filter(p => nonWere.some(nw => nw.id === p.id));
    if (knightCOCandidates.length > 0) return selectRandom(knightCOCandidates).id;

    const attackIndex = (attackHistory?.length || 0) + 1;
    const formation = (alivePlayers as any).formation as ('2-1'|'2-2'|'3-1') | undefined;

    const isRoleCO = (p: Player) => {
      try {
        return coInfoList.some(ci => ci && ci.playerId === p.id && ci.claimedRole !== undefined && ci.claimedRole !== Role.KNIGHT);
      } catch (e) {
        return false;
      }
    };

    if (attackIndex === 1) {
      let candidatePool: Player[] = [];
      if (formation === '2-1') candidatePool = nonWere.slice();
      else candidatePool = nonWere.filter(p => !isRoleCO(p));
      if (candidatePool.length === 0) candidatePool = nonWere.slice();
      return selectRandom(candidatePool).id;
    }

    // 2回目以降: 進行優先 -> 白確優先 -> 1回目と同じ条件
    const progressCandidates = nonWere.filter(p => {
      const count = (p as any).statementCountToday?.get?.(day) || 0;
      return count > 0 || (p as any).hasSpokenToday === true;
    });
    if (progressCandidates.length > 0) {
      progressCandidates.sort((a: any, b: any) => {
        const ca = a?.statementCountToday?.get?.(day) || 0;
        const cb = b?.statementCountToday?.get?.(day) || 0;
        return cb - ca;
      });
      return progressCandidates[0].id;
    }

    const confirmedHumans: any = (werewolf as any).confirmedHumans;
    const whiteCandidates = nonWere.filter(p => {
      try {
        const bySet = confirmedHumans && typeof confirmedHumans.has === 'function' && confirmedHumans.has(p.id);
        const byFlag = (p as any).confirmedWhite === true;
        return !!(bySet || byFlag);
      } catch (e) {
        return (p as any).confirmedWhite === true;
      }
    });
    if (whiteCandidates.length > 0) return selectRandom(whiteCandidates).id;

    let candidatePool: Player[] = [];
    if (formation === '2-1') candidatePool = nonWere.slice();
    else candidatePool = nonWere.filter(p => !isRoleCO(p));
    if (candidatePool.length === 0) candidatePool = nonWere.slice();
    return selectRandom(candidatePool).id;
  }

  /**
   * プレイヤー情報を更新
   */
  private updatePlayerInformation(): void {
    this.players.forEach(player => {
      player.updateStatements(this.statements);
      player.updateVoteHistory(this.voteHistory);
    });
  }

  /**
   * COを検出してブロードキャスト
   */
  /**
   * 勝利条件をチェック
   */
  private checkWinCondition(): GameResult | null {
    const alivePlayers = this.getAlivePlayers();
    const aliveWerewolves = alivePlayers.filter(p => p.role === Role.WEREWOLF);
    const aliveVillagerTeam = alivePlayers.filter(p => p.team === Team.VILLAGER);

    // 人狼が全滅
    if (aliveWerewolves.length === 0) {
      return {
        winner: Team.VILLAGER,
        day: this.day,
        reason: '人狼を全て処刑しました',
      };
    }

    // 人狼の数が村人陣営と同数以上
    if (aliveWerewolves.length >= aliveVillagerTeam.length) {
      return {
        winner: Team.WEREWOLF,
        day: this.day,
        reason: '人狼の数が村人陣営と同数以上になりました',
      };
    }

    return null;
  }

  /**
   * 結果を発表
   */
  private async announceResult(result: GameResult): Promise<void> {
    // Stop any further auto-speaking as we enter endgame.
    this.aiStatementsStopped = true;
    this.suspendAIStatements = false;

    this.eventEmitter.emit('log', { message: '【ゲーム終了】', type: 'title' });

    this.eventEmitter.emit('log', { message: `${result.day}日目で終了`, type: 'result' });

    // 追加: 勝敗演出（GM文 → GM文 → 派手演出 → 結果発表）
    await this.delay(1200);
    this.eventEmitter.emit('gm_message', { message: '今、勝敗がつきました。' });

    await this.delay(1200);
    this.eventEmitter.emit('gm_message', { message: '村人たちの運命は果たして…' });

    const END_EFFECT_DURATION_MS = 4400;
    const END_EFFECT_FADE_MS = 260;

    await this.delay(1200);
    this.eventEmitter.emit('end_effect', {
      winner: result.winner,
      effect: result.winner === Team.VILLAGER ? 'victory' : 'defeat',
      day: result.day,
      durationMs: END_EFFECT_DURATION_MS,
    });

    // Do not send any conversation while the client is showing the overlay.
    // Resume the existing GM/scripted messages after it ends.
    await this.delay(END_EFFECT_DURATION_MS + END_EFFECT_FADE_MS);
    await this.delay(700);
    if (result.winner === Team.VILLAGER) {
      this.eventEmitter.emit('gm_message', { message: 'おめでとうございます！村人陣営の勝ちです！' });
    } else {
      this.eventEmitter.emit('gm_message', { message: '人狼により村が滅ぼされてしまいました…村人陣営の負けです。' });
    }

    await this.delay(900);

    // 勝利陣営の生存者が victory を発言
    const victoryTeam = result.winner === Team.VILLAGER ? Team.VILLAGER : Team.WEREWOLF;
    const victorySpeakers = this.players.filter(p => p.isAlive() && p.team === victoryTeam);
    for (const sp of victorySpeakers) {
      try {
        const tpl = ((DIALOGUES[sp.name] as any) || {})['victory'] as string | undefined;
        const txt = tpl || (victoryTeam === Team.VILLAGER ? '勝ちました！' : '俺たちの勝ちだ！');
        this.statements.push({ day: result.day, playerId: sp.id, playerName: sp.getDisplayName(), content: txt });
        this.emitPlayerStatement(sp, txt, result.day, 'victory');
        await this.delay(700);
      } catch (e) {
        // ignore per-speaker
      }
    }

    await this.delay(800);

    // 役職内訳の公開（GM発言→同時にログ＋UIで再スタートボタン表示）
    this.eventEmitter.emit('gm_message', { message: '役職の内訳は下記のとおりです。' });
    this.eventEmitter.emit('show_play_again', { day: result.day, winner: result.winner });

    this.eventEmitter.emit('log', { message: '', type: 'blank' });
    for (const p of this.players) {
      const message = `${p.getDisplayName()}:${this.getRoleNameJa(p.role)}`;
      this.eventEmitter.emit('log', { message, type: 'final_role' });
    }

    // Notify UI that the game is finished (after all endgame messages)
    this.eventEmitter.emit('game_end', { winner: result.winner, day: result.day, reason: result.reason, players: this.players });
  }

  /**
   * 生存プレイヤーを取得
   */
  private getAlivePlayers(): Player[] {
    return this.players.filter(p => p.isAlive());
  }

  /**
   * Ensure Day1 state is initialized.
   *
   * This is required for operations like "force CO" (seer/medium) that rely on
   * Day1 CO candidates (including fake COs). If Day1 state isn't initialized yet,
   * the UI would only trigger a single CO fallback.
   */
  private ensureDay1StateInitialized(alivePlayers: Player[]): void {
    if (this.day1State) return;

    // 陣形抽選（テスト用に強制設定があればそれを使用）
    let formation: '2-1' | '2-2' | '3-1';
    if (this.forcedFormation) {
      formation = this.forcedFormation;
    } else {
      const rand = Math.random();
      // 2-1: 40%, 3-1: 30%, 2-2: 30%
      if (rand < 0.40) formation = '2-1';
      else if (rand < 0.70) formation = '3-1';
      else formation = '2-2';
    }

    // 真役職と偽役職候補
    const trueSeer = alivePlayers.find(p => p.role === Role.SEER) || null;
    const trueMedium = alivePlayers.find(p => p.role === Role.MEDIUM) || null;
    const werewolves = alivePlayers.filter(p => p.role === Role.WEREWOLF);
    const madman = alivePlayers.find(p => p.role === Role.MADMAN) || null;

    const coPlayers: Array<{ playerId: number; claimedRole: Role; isFake: boolean }> = [];
    if (formation === '2-1') {
      const fakeOccupant = Math.random() < 0.8 ? madman : (werewolves.length ? werewolves[Math.floor(Math.random() * werewolves.length)] : null);
      if (trueSeer) coPlayers.push({ playerId: trueSeer.id, claimedRole: Role.SEER, isFake: false });
      if (fakeOccupant) coPlayers.push({ playerId: fakeOccupant.id, claimedRole: Role.SEER, isFake: true });
      if (trueMedium) coPlayers.push({ playerId: trueMedium.id, claimedRole: Role.MEDIUM, isFake: false });
    } else if (formation === '2-2') {
      const pattern = Math.random() < 0.5;
      if (pattern) {
        if (trueSeer) coPlayers.push({ playerId: trueSeer.id, claimedRole: Role.SEER, isFake: false });
        if (madman) coPlayers.push({ playerId: madman.id, claimedRole: Role.SEER, isFake: true });
        if (trueMedium) coPlayers.push({ playerId: trueMedium.id, claimedRole: Role.MEDIUM, isFake: false });
        if (werewolves[0]) coPlayers.push({ playerId: werewolves[0].id, claimedRole: Role.MEDIUM, isFake: true });
      } else {
        if (trueSeer) coPlayers.push({ playerId: trueSeer.id, claimedRole: Role.SEER, isFake: false });
        if (werewolves[0]) coPlayers.push({ playerId: werewolves[0].id, claimedRole: Role.SEER, isFake: true });
        if (trueMedium) coPlayers.push({ playerId: trueMedium.id, claimedRole: Role.MEDIUM, isFake: false });
        if (madman) coPlayers.push({ playerId: madman.id, claimedRole: Role.MEDIUM, isFake: true });
      }
    } else {
      if (trueSeer) coPlayers.push({ playerId: trueSeer.id, claimedRole: Role.SEER, isFake: false });
      if (madman) coPlayers.push({ playerId: madman.id, claimedRole: Role.SEER, isFake: true });
      if (werewolves[0]) coPlayers.push({ playerId: werewolves[0].id, claimedRole: Role.SEER, isFake: true });
      if (trueMedium) coPlayers.push({ playerId: trueMedium.id, claimedRole: Role.MEDIUM, isFake: false });
    }

    const coOrder = coPlayers.map((_, i) => i).sort(() => Math.random() - 0.5);
    this.day1State = {
      stage: 'greetings',
      aiPlayerIds: this.players.filter(p => !(p instanceof UserPlayer)).map(p => p.id),
      greetingsIndex: 0,
      greetingsIntroDone: false,
      formation,
      coPlayers,
      coOrder,
      coIndex: 0,
      whitelistIds: [],
      seerIndex: 0,
    };

    // デバッグ: CO候補の一覧を出力
    try {
      console.log('[Day1 CO Players]', this.day1State.coPlayers.map(c => {
        const p = this.getPlayerById(c.playerId);
        return p ? `${p.name}(id:${p.id}) claimed:${c.claimedRole} fake:${c.isFake}` : `id:${c.playerId}`;
      }));
    } catch (e) {}

    // 初日: 真占い師/偽占い師向けに初日占いメモを記録する
    // ここで割り当てたターゲットが偽占い同士で重複しないよう追跡する
    const assignedDay1DivTargets = new Set<number>();

    // 初日: 真占い師がいる場合、初日占いメモとしてランダムな白を記録する
    try {
      if (trueSeer && trueSeer.isAlive && trueSeer.isAlive()) {
        // 真占いは本人以外のランダムな白（人狼でない生存者）を選ぶ
        let candidates = alivePlayers.filter(p => p.id !== trueSeer.id && p.id !== 1 && p.role !== Role.WEREWOLF);
        if (candidates.length === 0) candidates = alivePlayers.filter(p => p.id !== trueSeer.id && p.id !== 1);
        if (candidates.length > 0) {
          const target = candidates[Math.floor(Math.random() * candidates.length)];
          // 記録: Seer インスタンスなら addDivinationResult を使い、そうでなければ fakeDivinationResults に格納
          try {
            if ((trueSeer as any).addDivinationResult) {
              (trueSeer as any).addDivinationResult(1, target.id, DivinationResult.HUMAN);
            } else {
              const arr = (trueSeer as any).fakeDivinationResults || [];
              arr.push({ day: 1, targetId: target.id, result: DivinationResult.HUMAN });
              // 配列と要素をコピーして共有参照を避ける
              (trueSeer as any).fakeDivinationResults = arr.map((d: any) => ({ day: d.day, targetId: d.targetId, result: d.result }));
            }
            try { this.eventEmitter.emit('player_memo_update', { playerId: trueSeer.id }); } catch (e) {}
          } catch (e) { /* ignore */ }
          // whitelist にも追加（以降の挙動で白扱いにするため）
          try { if (!this.day1State!.whitelistIds.includes(target.id)) this.day1State!.whitelistIds.push(target.id); } catch (e) {}
          // 既に割り当て済みターゲットとして記録
          try { assignedDay1DivTargets.add(target.id); } catch (e) {}
          // 全 AI に占い情報として共有（疑い再計算用）
          try { this.players.forEach(p => { if (p.isAlive()) p.onDivinationInfo(1, target.id, DivinationResult.HUMAN); }); } catch (e) {}
        }
      }
    } catch (e) { /* ignore */ }

    // 初日: 偽占いCOがいる場合、それぞれランダムな白メモを作成する
    try {
      const fakeSeerCos = coPlayers.filter(c => c.claimedRole === Role.SEER && c.isFake);
      for (const c of fakeSeerCos) {
        const fakePlayer = this.getPlayerById(c.playerId);
        if (!fakePlayer || !fakePlayer.isAlive()) continue;
        // 候補: 自分とユーザーを除く生存者（人狼を避ける優先）
        let candidates = alivePlayers.filter(p => p.id !== fakePlayer.id && p.id !== 1 && p.role !== Role.WEREWOLF);
        if (candidates.length === 0) candidates = alivePlayers.filter(p => p.id !== fakePlayer.id && p.id !== 1);
        if (candidates.length === 0) continue;
        // 未割り当てターゲットを優先して選ぶ（初日偽占い同士の重複回避）
        const unassigned = candidates.filter(p => !assignedDay1DivTargets.has(p.id));
        if (unassigned.length > 0) candidates = unassigned;
        const target = candidates[Math.floor(Math.random() * candidates.length)];
        try {
          if ((fakePlayer as any).addDivinationResult) {
            (fakePlayer as any).addDivinationResult(1, target.id, DivinationResult.HUMAN);
          } else {
            const arr = (fakePlayer as any).fakeDivinationResults || [];
            arr.push({ day: 1, targetId: target.id, result: DivinationResult.HUMAN });
            // コピーして別インスタンス化することで他プレイヤーと同一参照にならないようにする
            (fakePlayer as any).fakeDivinationResults = arr.map((d: any) => ({ day: d.day, targetId: d.targetId, result: d.result }));
          }
          // 他の偽占い師が同じ初日ターゲットを選ばないよう記録
          try { assignedDay1DivTargets.add(target.id); } catch (e) {}
          try { this.eventEmitter.emit('player_memo_update', { playerId: fakePlayer.id }); } catch (e) {}
        } catch (e) { /* ignore */ }
        try { if (!this.day1State!.whitelistIds.includes(target.id)) this.day1State!.whitelistIds.push(target.id); } catch (e) {}
        try { this.players.forEach(p => { if (p.isAlive()) p.onDivinationInfo(1, target.id, DivinationResult.HUMAN); }); } catch (e) {}
      }
    } catch (e) { /* ignore */ }
  }

  /**
   * 初日専用の進行フロー
   */
  private async runDay1Flow(alivePlayers: Player[]): Promise<void> {
    // 初期化（未開始の場合のみ）
    this.ensureDay1StateInitialized(alivePlayers);

    // 進行（ステージごとに保存しながら実行）
    const state = this.day1State!;
    // 陣形はランダムまたは外部オプションで決定される（固定はしない）
    const aiPlayers = state.aiPlayerIds
      .map(id => this.getPlayerById(id))
      .filter((p): p is Player => p !== null && p !== undefined);

    // 1. 挨拶
    if (state.stage === 'greetings') {
      // GMが議論開始を促す（初回のみ）
      if (!state.greetingsIntroDone) {
        try { console.log(`[DEBUG aiStatementsStopped check] day=${this.day} loc=1869 aiStatementsStopped=${this.aiStatementsStopped}`); } catch (e) { console.log('[DEBUG aiStatementsStopped check]'); }
        if (this.aiStatementsStopped) return;
        this.eventEmitter.emit('gm_message', { message: 'おはようございます！議論スタートしてください。' });
        await this.delay(1200);
        try { console.log(`[DEBUG aiStatementsStopped check] day=${this.day} loc=1872 aiStatementsStopped=${this.aiStatementsStopped}`); } catch (e) { console.log('[DEBUG aiStatementsStopped check]'); }
        if (this.aiStatementsStopped) return;
        state.greetingsIntroDone = true;
      }
      for (let i = state.greetingsIndex; i < aiPlayers.length; i++) {
        if (this.aiStatementsStopped) { state.greetingsIndex = i; return; }
        await this.delay(800);
        if (this.aiStatementsStopped) { state.greetingsIndex = i; return; }
        const ai = aiPlayers[i];
        const dlg = DIALOGUES[ai.name] || {} as any;
        const greeting = dlg.greeting || ['おはよう！','おはようございます！','よろしくお願いします！'][Math.floor(Math.random()*3)];
        this.statements.push({ day: this.day, playerId: ai.id, playerName: ai.getDisplayName(), content: greeting });
        this.emitPlayerStatement(ai, greeting, this.day);
      }
      try { console.log(`[DEBUG aiStatementsStopped check] day=${this.day} loc=1885 aiStatementsStopped=${this.aiStatementsStopped}`); } catch (e) { console.log('[DEBUG aiStatementsStopped check]'); }
      if (this.aiStatementsStopped) return;
      await this.delay(1500);
      try { console.log(`[DEBUG aiStatementsStopped check] day=${this.day} loc=1887 aiStatementsStopped=${this.aiStatementsStopped}`); } catch (e) { console.log('[DEBUG aiStatementsStopped check]'); }
      if (this.aiStatementsStopped) return;
      // ユーザー要求: 挨拶の後はランダムな生存者が `call` を発言して議論を促す
      try {
        const aliveAi = aiPlayers.filter(p => p.isAlive() && !(p instanceof UserPlayer));
        if (aliveAi.length > 0) {
          const caller = aliveAi[Math.floor(Math.random() * aliveAi.length)];
          const dlg = DIALOGUES[caller.name] || {} as any;
          const callMsg = dlg.call || '議論どうしますか？';
          this.statements.push({ day: this.day, playerId: caller.id, playerName: caller.getDisplayName(), content: callMsg });
          this.emitPlayerStatement(caller, callMsg, this.day);
        }
      } catch (e) { /* ignore */ }
      // 初日はこの時点で挨拶+call が終われば村長操作フェーズへ遷移する（以降のCO等は出力しない）
      state.stage = 'done';
      return;
    }

    // 2. CO依頼
    if (state.stage === 'co_request') {
      // choose a requester who is not Seer or Medium if possible
      const nonSeerMedium = aiPlayers.filter(p => p.isAlive() && p.role !== Role.SEER && p.role !== Role.MEDIUM);
      const requester = nonSeerMedium.length > 0 ? nonSeerMedium[Math.floor(Math.random() * nonSeerMedium.length)] : aiPlayers[Math.floor(Math.random() * aiPlayers.length)];
      const coRequestMsg = (DIALOGUES[requester.name] && DIALOGUES[requester.name].co_call) || 'COありませんか？';
      this.statements.push({ day: this.day, playerId: requester.id, playerName: requester.getDisplayName(), content: coRequestMsg });
      this.emitPlayerStatement(requester, coRequestMsg, this.day);
      try { console.log(`[DEBUG aiStatementsStopped check] day=${this.day} loc=1899 aiStatementsStopped=${this.aiStatementsStopped}`); } catch (e) { console.log('[DEBUG aiStatementsStopped check]'); }
      if (this.aiStatementsStopped) return;
      await this.delay(1500);
      try { console.log(`[DEBUG aiStatementsStopped check] day=${this.day} loc=1901 aiStatementsStopped=${this.aiStatementsStopped}`); } catch (e) { console.log('[DEBUG aiStatementsStopped check]'); }
      if (this.aiStatementsStopped) return;
      state.stage = 'co_sequence';
    }

    // 3. CO順を実行
    if (state.stage === 'co_sequence') {
      for (let idx = state.coIndex; idx < state.coOrder.length; idx++) {
        if (this.aiStatementsStopped) { state.coIndex = idx; return; }
        await this.delay(1200);
        if (this.aiStatementsStopped) { state.coIndex = idx; return; }
        const coIdx = state.coOrder[idx];
        const co = state.coPlayers[coIdx];
        const player = this.getPlayerById(co.playerId);
        if (!player) continue;
        const roleNameJa = this.getRoleNameJa(co.claimedRole);
        let coMsg = `${roleNameJa}COします。`;
        if (co.claimedRole === Role.SEER) {
          coMsg = (DIALOGUES[player.name] && DIALOGUES[player.name].seer_co) || coMsg;
        } else if (co.claimedRole === Role.MEDIUM) {
          coMsg = (DIALOGUES[player.name] && DIALOGUES[player.name].medium_co) || coMsg;
        }
          this.statements.push({ day: this.day, playerId: player.id, playerName: player.getDisplayName(), content: coMsg });
          try {
            this.emitPlayerStatement(player, coMsg, this.day);
          } catch (e) {
            // ignore emit errors for CO
          }

        const coInfo: COInfo = {
          playerId: player.id,
          playerName: player.getDisplayName(),
          claimedRole: co.claimedRole,
          day: this.day,
          coType: COType.TRUE_CO,
        };
        this.coHistory.push(coInfo);
        this.players.forEach(p => { if (p.id !== player.id) p.receiveCOInfo(coInfo); });
        this.eventEmitter.emit('player_co', { playerId: player.id, playerName: player.getDisplayName(), claimedRole: co.claimedRole });
        // If this CO is a Seer or Medium, emit a player_result event so clients show their latest stored result immediately
        try {
          if (co.claimedRole === Role.SEER) {
            // Emit all stored divination results so CO on later days reveals past results as well
            try {
              const lastAnn: any = (player as any).lastAnnouncedDivination;
              const divs: Array<any> = (player as any).divinationResults || [];
              const fdivs: Array<any> = (player as any).fakeDivinationResults || [];
              const byDay: Map<number, any> = new Map();
              divs.forEach(r => { if (r && typeof r.day === 'number') byDay.set(r.day, r); });
              fdivs.forEach(r => { if (r && typeof r.day === 'number' && !byDay.has(r.day)) byDay.set(r.day, r); });
              if (lastAnn && typeof lastAnn.day === 'number') byDay.set(lastAnn.day, { day: lastAnn.day, targetId: lastAnn.targetId, result: lastAnn.result });
              const days = Array.from(byDay.keys()).sort((a,b) => a - b);
              for (const d of days) {
                const rec = byDay.get(d);
                if (!rec || typeof rec.targetId !== 'number') continue;
                const targetPlayer = this.getPlayerById(rec.targetId);
                const targetName = targetPlayer ? targetPlayer.getDisplayName() : '（不明）';
                const resultLabel = rec.result === DivinationResult.WEREWOLF ? 'black' : 'white';
                try { this.emitPlayerResult({ speakerId: player.id, day: rec.day || this.day, targetId: rec.targetId, result: resultLabel, targetName, type: 'seer' }, 'co_day1'); } catch (e) {}
              }
            } catch (e) {}
          } else if (co.claimedRole === Role.MEDIUM) {
            try {
              const mres: Array<any> = (player as any).mediumResults || [];
              const byDay: Map<number, any> = new Map();
              mres.forEach(r => { if (r && typeof r.day === 'number') byDay.set(r.day, r); });
              const days = Array.from(byDay.keys()).sort((a,b) => a - b);
              for (const d of days) {
                const rec = byDay.get(d);
                if (!rec || typeof rec.targetId !== 'number') continue;
                const targetPlayer = this.getPlayerById(rec.targetId);
                const targetName = targetPlayer ? targetPlayer.getDisplayName() : '（不明）';
                const resultLabel = rec.result === MediumResult.WEREWOLF ? 'black' : 'white';
                try { this.emitPlayerResult({ speakerId: player.id, day: rec.day || this.day, targetId: rec.targetId, result: resultLabel, targetName, type: 'medium' }, 'co_day1_medium'); } catch (e) {}
              }
            } catch (e) {}
          }
        } catch (e) { /* ignore player_result emission errors */ }
        // CO 集計（簡略ルール）:
        // 初日かつ「全員生存」の状態で、ある役職のCOが1人だけ（被りなし）なら、そのCO者を確白扱いにする。
        // ※このプロトタイプ上の“客観的に狼可能性が極小”扱い（人間確定に寄せる）
        try {
          if (this.day === 1) {
            const aliveCount = this.getAlivePlayers().length;
            const totalCount = this.players.length;
            if (aliveCount === totalCount) {
              const markUniqueCOAsConfirmedWhite = (role: Role) => {
                const cos = (state.coPlayers || []).filter((c: any) => c && c.claimedRole === role);
                if (cos.length !== 1) return;
                const pid = cos[0].playerId;
                const pl = this.players.find(pp => pp.id === pid);
                if (!pl) return;
                (pl as any).confirmedWhite = true;
                (pl as any).confirmedBlack = false;
                try { this.eventEmitter.emit('player_memo_update', { playerId: pl.id }); } catch (e) {}
              };

              markUniqueCOAsConfirmedWhite(Role.SEER);
              markUniqueCOAsConfirmedWhite(Role.MEDIUM);
              // 狩人（KNIGHT）も同様に扱う
              markUniqueCOAsConfirmedWhite(Role.KNIGHT);
            }
          }
        } catch (e) {
          // ignore
        }
      }
      try { console.log(`[DEBUG aiStatementsStopped check] day=${this.day} loc=1959 aiStatementsStopped=${this.aiStatementsStopped}`); } catch (e) { console.log('[DEBUG aiStatementsStopped check]'); }
      if (this.aiStatementsStopped) return;
      await this.delay(1500);
      try { console.log(`[DEBUG aiStatementsStopped check] day=${this.day} loc=1961 aiStatementsStopped=${this.aiStatementsStopped}`); } catch (e) { console.log('[DEBUG aiStatementsStopped check]'); }
      if (this.aiStatementsStopped) return;

      // (formation dialogues removed from here; will run after seer_results)

      state.stage = 'seer_results';
    }

    // 4. 占い結果発表
    if (state.stage === 'seer_results') {
      let skipSeerResults = false;
      try {
        if (this.day >= 2) {
          const seerCOsForCheck = (state.coPlayers || []).filter((c: any) => c.claimedRole === Role.SEER);
          const day1SeerCOs = ((this.day1State as any)?.coPlayers || []).filter((c: any) => c.claimedRole === Role.SEER);
          if ((seerCOsForCheck || []).length === 0 && (day1SeerCOs || []).length === 0) {
            try { console.log(`[INFO skip seer_results] day=${this.day} no seer COs present`); } catch(e) {}
            skipSeerResults = true;
          }
        }
      } catch(e) {}
      if (skipSeerResults) {
        state.stage = 'debate_start';
      } else {
      const seerCOs = state.coPlayers.filter(c => c.claimedRole === Role.SEER);
      const seerTargets: number[] = [];
      for (let i = state.seerIndex; i < seerCOs.length; i++) {
        if (this.aiStatementsStopped) { state.seerIndex = i; return; }
        // 少しゆっくりめに：占い発表間隔を拡張
        await this.delay(1800);
        if (this.aiStatementsStopped) { state.seerIndex = i; return; }
        const seerCO = seerCOs[i];
        const seerPlayer = this.getPlayerById(seerCO.playerId);
        if (!seerPlayer) continue;
        let targetId: number; let resultText: string;
        if (!seerCO.isFake && seerPlayer.role === Role.SEER) {
          // 初日真占いは人狼を対象にしない（候補が尽きた場合のみ全体から）
          let candidates = alivePlayers.filter(p => p.id !== seerPlayer.id && p.id !== 1 && p.role !== Role.WEREWOLF);
          if (candidates.length === 0) {
            candidates = alivePlayers.filter(p => p.id !== seerPlayer.id && p.id !== 1);
          }
          if (candidates.length === 0) {
            continue;
          }
          // 真占いは本人以外のランダムな白（人狼でない生存者）を選ぶ
          const target = candidates[Math.floor(Math.random() * candidates.length)];
          targetId = target.id;
          const isWolf = target.role === Role.WEREWOLF;
          resultText = isWolf ? '人狼' : '人狼ではありません';
          if (!isWolf && !state.whitelistIds.includes(targetId)) {
            state.whitelistIds.push(targetId);
          }
        } else {
          // Fake seer: in 2-2 prefer to pick a random white (non-werewolf) other than self
          let candidates = [] as Player[];
          if ((state as any).formation === '2-2') {
            candidates = alivePlayers.filter(p => p.id !== seerPlayer.id && p.id !== 1 && p.role !== Role.WEREWOLF);
          }
          // fallback to general candidate pool if none found or not 2-2
          if (!candidates || candidates.length === 0) {
            candidates = alivePlayers.filter(p => p.id !== seerPlayer.id && p.id !== 1);
          }
          if (candidates.length === 0) {
            continue;
          }
          // 偽占いは各自ランダムで白を選ぶ（2-2では白優先候補から、ただし本人は除外）
          const target = candidates[Math.floor(Math.random() * candidates.length)];
          targetId = target.id;
          // 偽占いの結果は常に白扱い
          resultText = '人狼ではありません';
          if (!state.whitelistIds.includes(targetId)) {
            state.whitelistIds.push(targetId);
          }
        }
        const targetPlayerObj = alivePlayers.find(p => p.id === targetId) || null;
        const targetDisplay = targetPlayerObj ? targetPlayerObj.getDisplayName() : '不明';
        const dlgTemplate = DIALOGUES[seerPlayer.name] && DIALOGUES[seerPlayer.name].seer_result;
        let msg: string;
        if (dlgTemplate && dlgTemplate.includes('〇〇')) {
          msg = dlgTemplate.replace('〇〇', targetDisplay);
        } else if (dlgTemplate) {
          msg = dlgTemplate + ` (${targetDisplay}は${resultText})`;
        } else {
          msg = `${targetDisplay}を占いました。結果は${resultText}。`;
        }
        this.statements.push({ day: this.day, playerId: seerPlayer.id, playerName: seerPlayer.getDisplayName(), content: msg });
        try {
          const k = (typeof resultText === 'string' && resultText.includes('人狼')) ? 'seer_result_black' : 'seer_result_white';
          this.emitPlayerStatement(seerPlayer, msg, this.day, k);
        } catch (e) { this.emitPlayerStatement(seerPlayer, msg, this.day); }
        // record which player each seer inspected this round
        seerTargets.push(targetId);
      }
      try { console.log(`[DEBUG aiStatementsStopped check] day=${this.day} loc=2026 aiStatementsStopped=${this.aiStatementsStopped}`); } catch (e) { console.log('[DEBUG aiStatementsStopped check]'); }
      if (this.aiStatementsStopped) return;
      // 占い結果発表後の会話テンポを遅めに（ディベート開始まで待機）
      await this.delay(3000);
      try { console.log(`[DEBUG aiStatementsStopped check] day=${this.day} loc=2029 aiStatementsStopped=${this.aiStatementsStopped}`); } catch (e) { console.log('[DEBUG aiStatementsStopped check]'); }
      if (this.aiStatementsStopped) return;

      // --- 追加: 占い結果発表直後に、生存している占い師（真偽問わず）が自分の選んだ変数に基づく理由を発言 ---
      try {
        // collect seer CO players (true+fake) in order
        const seerCOsAll = state.coPlayers.filter(c => c.claimedRole === Role.SEER).map(c => this.getPlayerById(c.playerId)).filter((p): p is Player => !!p);
        if (seerCOsAll.length > 0) {
          await this.delay(600);
          for (const sp of seerCOsAll) {
            if (this.aiStatementsStopped) break;
            if (!sp.isAlive()) continue;
            // attempt to read nightActionHistory entry for this day
            try {
              const hist: Array<any> = (sp as any).nightActionHistory || [];
              const rec = hist.slice().reverse().find((r: any) => r && r.day === this.day);
              const variable = rec ? rec.variable : null;
              const targetId = rec ? rec.targetId : null;
              if (variable) {
                const key = `seer_reason_${variable}`;
                const tpl = ((DIALOGUES[sp.name] as any) || {})[key] as string | undefined;
                let txt: string = '';
                if (tpl) {
                  if (tpl.includes('〇〇') && targetId != null) {
                    const tp = this.getPlayerById(targetId);
                    const disp = tp ? tp.getDisplayName() : '';
                    txt = tpl.replace(/〇〇/g, disp);
                  } else {
                    txt = tpl;
                  }
                }
                // fallback: use a generic ask if no template
                if (!txt) txt = ((DIALOGUES[sp.name] as any)?.seer_reason_intuition) || '理由は直感です。';
                this.statements.push({ day: this.day, playerId: sp.id, playerName: sp.getDisplayName(), content: txt });
                this.emitPlayerStatement(sp, txt, this.day);
                await this.delay(700);
              }
            } catch (e) {
              // ignore per-player errors
            }
          }
        }
      } catch (e) {
        // ignore overall errors
      }

      // --- 追加: seer_reason 系が一通り出た後、遅延して占い結果を個別に発言 ---
      try {
        await this.delay(800);
        const seerCOsAll2 = state.coPlayers.filter(c => c.claimedRole === Role.SEER).map(c => this.getPlayerById(c.playerId)).filter((p): p is Player => !!p);
        for (const sp of seerCOsAll2) {
          if (this.aiStatementsStopped) break;
          if (!sp.isAlive()) continue;
          try {
            // check real seer divinationResults first
            const divs: Array<any> = (sp as any).divinationResults || [];
            let rec = divs.find((r: any) => r && r.day === this.day);
            // fallback to fakeDivinationResults if present
            if (!rec) {
              const farr: Array<any> = (sp as any).fakeDivinationResults || [];
              rec = farr.find((r: any) => r && r.day === this.day);
            }
            if (!rec) continue;
            const res = rec.result as DivinationResult | undefined;
            const targetId = typeof rec.targetId === 'number' ? rec.targetId : null;
            const key = res === DivinationResult.WEREWOLF ? 'seer_result_black' : 'seer_result_white';
            const tpl = ((DIALOGUES[sp.name] as any) || {})[key] as string | undefined;
            let txt = '';
            if (tpl) {
              if (tpl.includes('〇〇') && targetId != null) {
                const tp = this.getPlayerById(targetId);
                const disp = tp ? tp.getDisplayName() : '';
                txt = tpl.replace(/〇〇/g, disp);
              } else {
                txt = tpl;
              }
            } else {
              txt = res === DivinationResult.WEREWOLF ? '結果は黒です！' : '結果は白です。';
            }
            this.statements.push({ day: this.day, playerId: sp.id, playerName: sp.getDisplayName(), content: txt });
            try { this.emitPlayerStatement(sp, txt, this.day, key); } catch (e) { this.emitPlayerStatement(sp, txt, this.day); }
            await this.delay(700);
          } catch (e) {
            // per-seer ignore
          }
        }
      } catch (e) {
        // ignore
      }

      // --- 追加処理: 占い師CO全員が同じ対象を占っていたら、全員白なら確白・全員黒なら確黒として扱い、発言を順に発生させる ---
      try {
        const uniqueTargets = Array.from(new Set(seerTargets));
        if (uniqueTargets.length === 1 && uniqueTargets[0] != null) {
          const tid = uniqueTargets[0];
          const targetPlayer = this.getPlayerById(tid);
          if (targetPlayer) {
            // Determine whether all seer CO players gave WHITE or BLACK for this day.
            let allWhite = true;
            let allBlack = true;
            try {
              const seerPlayersAll = (state.coPlayers || [])
                .filter((c: any) => c && c.claimedRole === Role.SEER)
                .map((c: any) => this.getPlayerById(c.playerId))
                .filter((p): p is Player => !!p);
              if (seerPlayersAll.length === 0) {
                allWhite = false;
                allBlack = false;
              }
              for (const sp of seerPlayersAll) {
                const divs: Array<any> = (sp as any).divinationResults || [];
                let rec = divs.find((r: any) => r && r.day === this.day);
                if (!rec) {
                  const farr: Array<any> = (sp as any).fakeDivinationResults || [];
                  rec = farr.find((r: any) => r && r.day === this.day);
                }
                if (!rec) {
                  allWhite = false;
                  allBlack = false;
                  break;
                }
                const isBlack = (rec.result === DivinationResult.WEREWOLF);
                if (isBlack) allWhite = false;
                if (!isBlack) allBlack = false;
              }
            } catch (e) {
              allWhite = false;
              allBlack = false;
            }

            if (allWhite) {
              try {
                (targetPlayer as any).confirmedWhite = true;
                (targetPlayer as any).confirmedBlack = false;
                try { this.eventEmitter.emit('player_memo_update', { playerId: targetPlayer.id }); } catch (e) {}
              } catch (e) {}
            } else if (allBlack) {
              try {
                (targetPlayer as any).confirmedBlack = true;
                (targetPlayer as any).confirmedWhite = false;
                try { this.eventEmitter.emit('player_memo_update', { playerId: targetPlayer.id }); } catch (e) {}
              } catch (e) {}
            }

            // 1) 少し待ってから: ユーザーと確定白本人(X)は除外して、ランダムな別の生存者2名が found_confirmed_white を発言
            await this.delay(1500);
            try {
              const speakerCandidates = this.getAlivePlayers().filter(p => p.isAlive() && !(p instanceof UserPlayer) && p.id !== targetPlayer.id);
              if (speakerCandidates.length > 0) {
                const shuffled = speakerCandidates.slice().sort(() => Math.random() - 0.5);
                const count = Math.min(2, shuffled.length);
                for (let si = 0; si < count; si++) {
                  const spk = shuffled[si];
                  const fTpl = (DIALOGUES[spk.name] as any)?.found_confirmed_white || '〇〇白確！';
                  const fTxt = fTpl.replace(/〇〇/g, targetPlayer.getDisplayName());
                  this.statements.push({ day: this.day, playerId: spk.id, playerName: spk.getDisplayName(), content: fTxt });
                  this.emitPlayerStatement(spk, fTxt, this.day);
                  await this.delay(700);
                }
              }
            } catch (e) { /* ignore */ }

            // 2) 少し待ってから: （白確になった場合のみ）本人が happy_confirmed_white を発言
            await this.delay(1400);
            if (targetPlayer.isAlive() && (targetPlayer as any).confirmedWhite) {
              const hTpl = (DIALOGUES[targetPlayer.name] as any)?.happy_confirmed_white || 'やったー、白確だ！';
              const hTxt = hTpl.replace(/〇〇/g, targetPlayer.getDisplayName());
              this.statements.push({ day: this.day, playerId: targetPlayer.id, playerName: targetPlayer.getDisplayName(), content: hTxt });
              this.emitPlayerStatement(targetPlayer, hTxt, this.day);
            }
            // formation===2-2 の場合、白確発言後にユーザー以外のランダムな誰か2人が delegate_confirmed_white を順に発言し、白確本人が進行宣言、続けて request 群を出す
            try {
              if ((state as any).formation === '2-2' && state.whitelistIds && state.whitelistIds.length > 0) {
                const confirmedId = state.whitelistIds[0];
                const confirmedPlayer = this.getPlayerById(confirmedId);
                // delegates: random non-user alive players excluding confirmed
                const delegates = this.getAlivePlayers()
                  .filter(p => !(p instanceof UserPlayer) && p.isAlive() && p.id !== confirmedId)
                  .sort(() => Math.random() - 0.5)
                  .slice(0, 2);
                for (const d of delegates) {
                  await this.delay(1200);
                  if (!d.isAlive()) continue;
                  const tpl = (DIALOGUES[d.name] as any)?.delegate_confirmed_white || 'じゃあ白確の〇〇に進行お任せしていいですか？';
                  const txt = tpl.replace(/〇〇/g, confirmedPlayer ? confirmedPlayer.getDisplayName() : '〇〇');
                  this.statements.push({ day: this.day, playerId: d.id, playerName: d.getDisplayName(), content: txt });
                  this.emitPlayerStatement(d, txt, this.day);
                }

                // confirmed本人が進行宣言
                await this.delay(1600);
                if (confirmedPlayer && confirmedPlayer.isAlive()) {
                  const modTpl = (DIALOGUES[confirmedPlayer.name] as any)?.moderator_declare || 'では私が進行します。';
                  const modTxt = modTpl.replace(/〇〇/g, confirmedPlayer.getDisplayName());
                  this.statements.push({ day: this.day, playerId: confirmedPlayer.id, playerName: confirmedPlayer.getDisplayName(), content: modTxt });
                  this.emitPlayerStatement(confirmedPlayer, modTxt, this.day);
                }

                // request 発言群（ユーザー含む白確以外からランダム3人）
                await this.delay(1400);
                const reqCandidates = this.getAlivePlayers()
                  .filter(p => p.isAlive() && p.id !== confirmedId && !(p instanceof UserPlayer))
                  .sort(() => Math.random() - 0.5)
                  .slice(0, 3);
                for (const r of reqCandidates) {
                  await this.delay(900);
                  const reqTpl = (DIALOGUES[r.name] as any)?.request || 'お願いします';
                  const reqTxt = reqTpl.replace(/〇〇/g, r.getDisplayName());
                  this.statements.push({ day: this.day, playerId: r.id, playerName: r.getDisplayName(), content: reqTxt });
                  this.emitPlayerStatement(r, reqTxt, this.day);
                }
              }
            } catch (e) {
              console.error('formation 2-2 delegate sequence error:', e);
            }
          }
        }
        // --- 追加: 任意の時点で、占い師CO全員が同一人物に「白」を出しており、かつ誰も「黒」を出していない場合、その人物を確白にする ---
        try {
          const seerCOPlayers = state.coPlayers.filter(c => c.claimedRole === Role.SEER).map(c => this.getPlayerById(c.playerId)).filter((p): p is Player => !!p);
          if (seerCOPlayers.length > 0) {
            // For every candidate player, check whether every seer CO player has at some point given a white result for them
            const allPlayers = this.players.slice();
            for (const cand of allPlayers) {
              if (!cand) continue;
              if ((cand as any).confirmedWhite) continue; // already marked
              let everyoneSaidWhite = true;
              for (const sp of seerCOPlayers) {
                try {
                  const divs: Array<any> = (sp as any).divinationResults || [];
                  const fdivs: Array<any> = (sp as any).fakeDivinationResults || [];
                  const gaveWhite = divs.some((r: any) => r && r.targetId === cand.id && r.result !== DivinationResult.WEREWOLF)
                    || fdivs.some((r: any) => r && r.targetId === cand.id && (r.result == null || r.result !== DivinationResult.WEREWOLF));
                  const gaveBlack = divs.some((r: any) => r && r.targetId === cand.id && r.result === DivinationResult.WEREWOLF)
                    || fdivs.some((r: any) => r && r.targetId === cand.id && r.result === DivinationResult.WEREWOLF);

                  // 全員が「白」を出していて、かつ誰も「黒」を出していないこと
                  if (!gaveWhite || gaveBlack) { everyoneSaidWhite = false; break; }
                } catch (e) { everyoneSaidWhite = false; break; }
              }
              if (everyoneSaidWhite) {
                try {
                  (cand as any).confirmedWhite = true;
                  (cand as any).confirmedBlack = false;
                  try { this.eventEmitter.emit('player_memo_update', { playerId: cand.id }); } catch (e) {}
                } catch (e) {}
              }
            }
          }
        } catch (e) {
          // ignore
        }

        if (uniqueTargets.length > 0) {
          // 複数の対象が居る場合、それぞれについて（ユーザー/占い師/霊能者以外の）対象が順に thanks_half_white を発言
          for (const tid of uniqueTargets) {
            const tp = this.getPlayerById(tid);
            if (!tp) continue;
            if (tp instanceof UserPlayer) continue;
            if (tp.role === Role.SEER || tp.role === Role.MEDIUM) continue;
            // If the seers (including fake) inspected a CO seer and it was white,
            // do not emit thanks_half_white from that CO.
            try {
              const isCOSeer = Array.isArray(state.coPlayers) && state.coPlayers.some(c => c.playerId === tp.id && c.claimedRole === Role.SEER);
              const isWhitelisted = Array.isArray(state.whitelistIds) && state.whitelistIds.includes(tp.id);
              if (isCOSeer && isWhitelisted) {
                continue;
              }
            } catch (e) {
              // ignore and proceed to emit
            }
            await this.delay(1200);
            if (!tp.isAlive()) continue;
            const tTpl = (DIALOGUES[tp.name] as any)?.thanks_half_white || '片白ありがとう';
            const tTxt = tTpl.replace(/〇〇/g, tp.getDisplayName());
            this.statements.push({ day: this.day, playerId: tp.id, playerName: tp.getDisplayName(), content: tTxt });
            this.emitPlayerStatement(tp, tTxt, this.day);
          }
        }
      } catch (e) {
        // ignore errors in this diagnostic/aux flow
      }

      // If no black results were produced by seer COs this day and no confirmed-white
      // was assigned as a result of the seer COs, have two random non-user, non-seer
      // players say `seer_result_ack_piece_white` to acknowledge the mostly-white results.
      try {
        const seerCOsForCheck = state.coPlayers.filter((c: any) => c.claimedRole === Role.SEER).map((c: any) => this.getPlayerById(c.playerId)).filter((p): p is Player => !!p);
        if (seerCOsForCheck.length > 0) {
          const recs: Array<{ targetId?: number; result?: DivinationResult }> = [];
          for (const sp of seerCOsForCheck) {
            try {
              const divs: Array<any> = (sp as any).divinationResults || [];
              let rec = divs.find((r: any) => r && r.day === this.day);
              if (!rec) {
                const farr: Array<any> = (sp as any).fakeDivinationResults || [];
                rec = farr.find((r: any) => r && r.day === this.day);
              }
              if (rec && typeof rec.targetId === 'number') {
                recs.push({ targetId: rec.targetId, result: rec.result });
              }
            } catch (e) { /* per seer ignore */ }
          }
          const anyBlack = recs.some(r => r.result === DivinationResult.WEREWOLF);
          const targetIds = new Set(recs.filter(r => typeof r.targetId === 'number').map(r => r.targetId as number));
          const confirmedWhiteAssigned = (!anyBlack && targetIds.size === 1 && targetIds.size > 0);
          if (!anyBlack && !confirmedWhiteAssigned) {
            // Do not emit ack on Day 1
            if (this.day === 1) {
              // skip
            } else {
            const seerIds = new Set(seerCOsForCheck.map(s => s.id));
            const candidates = this.getAlivePlayers().filter(p => !(p instanceof UserPlayer) && !seerIds.has(p.id));
            if (candidates.length > 0) {
              const shuffled = candidates.slice().sort(() => Math.random() - 0.5);
              const count = Math.min(2, shuffled.length);
              for (let i = 0; i < count; i++) {
                if (this.aiStatementsStopped) break;
                const speaker = shuffled[i];
                const tpl = ((DIALOGUES[speaker.name] as any) || {})['seer_result_ack_piece_white'] as string | undefined;
                const txt = tpl || '把握しました。';
                this.statements.push({ day: this.day, playerId: speaker.id, playerName: speaker.getDisplayName(), content: txt });
                this.emitPlayerStatement(speaker, txt, this.day);
                await this.delay(700);
              }
            }
            }
          }
        }
      } catch (e) { /* ignore */ }

      }
      // --- 陣形に応じた発言（占い結果発表完了の3秒後に実行） ---
      // After seer-related emissions on Day2 (deny_wolf / found_black_confirm / happy_confirmed_white / seer_result_ack_piece_white),
      // have surviving medium COs announce their medium results for the player executed on the previous day.
      try {
        if (this.day >= 2) {
          let lastExecutedId: number | null = this.executedPlayerIds.length > 0 ? this.executedPlayerIds[this.executedPlayerIds.length - 1] : null;
          // If no executedPlayerIds recorded (some flows skip recording), fall back to mediumResults
          if (lastExecutedId == null) {
            try {
              const mediumCOsDay1 = ((this.day1State as any)?.coPlayers || []).filter((c: any) => c.claimedRole === Role.MEDIUM).map((c: any) => this.getPlayerById(c.playerId)).filter((p: any): p is Player => !!p && p.isAlive());
              for (const med of mediumCOsDay1) {
                try {
                  const mres: Array<any> = (med as any).mediumResults || [];
                  // look for previous day's medium result (day-1)
                  const rec = mres.find(r => r && r.day === (this.day - 1));
                  if (rec && typeof rec.targetId === 'number') {
                    lastExecutedId = rec.targetId;
                    break;
                  }
                } catch (e) { /* ignore per-medium errors */ }
              }
              // If still not found, scan all players' mediumResults/fakeMediumResults for a day-1 entry
              if (lastExecutedId == null) {
                try {
                  for (const p of this.players) {
                    try {
                      const pres: Array<any> = (p as any).mediumResults || (p as any).fakeMediumResults || [];
                      const recAll = pres.find((r: any) => r && r.day === (this.day - 1));
                      if (recAll && typeof recAll.targetId === 'number') { lastExecutedId = recAll.targetId; break; }
                    } catch (e) { /* ignore per-player errors */ }
                  }
                } catch (e) { /* ignore */ }
              }
            } catch (e) { /* ignore */ }
          }
          try { console.log(`[TRACE medium_info] executedPlayerIds=[${this.executedPlayerIds.join(',')}] lastExecutedId=${lastExecutedId}`); } catch(e) {}
          try { console.log(`[TRACE day1_coPlayers] ${JSON.stringify(((this.day1State as any)?.coPlayers || []).map((c:any)=>({playerId:c.playerId,claimedRole:c.claimedRole,isFake:c.isFake})))}`); } catch(e) {}
          const executedPlayer = lastExecutedId != null ? this.getPlayerById(lastExecutedId) : null;

          // --- 新規: seer_result 後に、各生存中の霊能COが自身の霊能メモを参照して即時発言する ---
          try {
            const coPlayersForMedium = (this.day1State && Array.isArray((this.day1State as any).coPlayers)) ? (this.day1State as any).coPlayers : (state.coPlayers || []);
            // detect whether any medium CO existed (today or Day1)
            const currentMediumCOsRaw = (state.coPlayers || []).filter((c: any) => c.claimedRole === Role.MEDIUM);
            const day1MediumCOsRaw = ((this.day1State as any)?.coPlayers || []).filter((c: any) => c.claimedRole === Role.MEDIUM);
            const hadMediumCOs = ((currentMediumCOsRaw || []).length > 0) || ((day1MediumCOsRaw || []).length > 0);
            let mediumCOs = (coPlayersForMedium || [])
              .filter((c: any) => c.claimedRole === Role.MEDIUM)
              .map((c: any) => this.getPlayerById(c.playerId))
              .filter((p: any): p is Player => !!p && p.isAlive());
            // Fallback: if no COed mediums, include any alive player who actually has a medium memo for previous day
            if ((!mediumCOs || mediumCOs.length === 0)) {
              try {
                const memoHolders = this.players
                  .filter(p => p && p.isAlive())
                  .filter(p => {
                    try {
                      const mres: any[] = (p as any).mediumResults || [];
                      const fmres: any[] = (p as any).fakeMediumResults || [];
                      return mres.some(r => r && r.day === (this.day - 1)) || fmres.some(r => r && r.day === (this.day - 1));
                    } catch (e) { return false; }
                  });
                if (memoHolders.length > 0) {
                  try { console.log(`[TRACE medium_memo_emit] fallback memoHolders=${memoHolders.map(m=>m.id).join(',')}`); } catch(e) {}
                  mediumCOs = memoHolders;
                }
              } catch (e) { /* ignore fallback errors */ }
            }
            // If Day2+ and there were no actual medium COs (neither today nor Day1), do not emit even fallback memos
            if (this.day >= 2 && !hadMediumCOs) {
              try { console.log(`[INFO skip medium_memo_emit] day=${this.day} no medium COs present (suppress fallback memos)`); } catch(e) {}
              mediumCOs = [];
            }
            if (mediumCOs.length > 0) {
              try { console.log(`[TRACE medium_memo_emit] day=${this.day} mediumCOs=${mediumCOs.map((m:any)=>m.id).join(',')}`); } catch(e) {}
              for (const med of mediumCOs) {
                try {
                  if ((med as any)._mediumAnnounced) continue;
                  // prefer the latest explicit medium memo (real or fake)
                  const mres: Array<any> = (med as any).mediumResults || [];
                  const fmres: Array<any> = (med as any).fakeMediumResults || [];
                  const latest = mres.slice().reverse()[0] || fmres.slice().reverse()[0] || null;
                  if (!latest || typeof latest.targetId !== 'number') continue;
                  const wasWerewolf = latest.result === MediumResult.WEREWOLF;
                  const key = wasWerewolf ? 'medium_result_black' : 'medium_result_white';
                  const tpl = ((DIALOGUES[med.name] as any) || {})[key] as string | undefined;
                  const targetDisp = this.getPlayerById(latest.targetId)?.getDisplayName() || '';
                  let txt = '';
                  if (tpl) {
                    if (tpl.includes('〇〇')) txt = tpl.replace(/〇〇/g, targetDisp);
                    else txt = tpl;
                  } else {
                    txt = wasWerewolf ? `${targetDisp}は人狼でした。` : `${targetDisp}は人狼ではありませんでした。`;
                  }
                  this.statements.push({ day: this.day, playerId: med.id, playerName: med.getDisplayName(), content: txt });
                  try { this.emitPlayerStatement(med, txt, this.day, key); } catch (e) { this.emitPlayerStatement(med, txt, this.day); }
                  // 同時に結果パネル更新用の player_result を emit
                  try {
                    const resultLabel = wasWerewolf ? 'black' : 'white';
                    this.emitPlayerResult({ speakerId: med.id, day: latest.day || this.day, targetId: latest.targetId, result: resultLabel, targetName: targetDisp, type: 'medium' }, 'medium_memo_emit');
                  } catch (e) {}
                  // mark announced to avoid duplicate announcements later
                  try { (med as any)._mediumAnnounced = true; } catch (e) {}
                  await this.delay(700);
                } catch (e) { /* per-medium ignore */ }
              }
            }
          } catch (e) { /* ignore memo-emission errors */ }

          if (executedPlayer) {
            // collect medium CO players (true+fake) who are alive
            const coPlayersForMedium = (this.day1State && Array.isArray((this.day1State as any).coPlayers)) ? (this.day1State as any).coPlayers : (state.coPlayers || []);
            const mediumCOs = (coPlayersForMedium || [])
              .filter((c: any) => c.claimedRole === Role.MEDIUM)
              .map((c: any) => this.getPlayerById(c.playerId))
              .filter((p: any): p is Player => !!p && p.isAlive());
            if (mediumCOs.length > 0) {
              try { console.log(`[TRACE medium_sequence] day=${this.day} mediumCOs=${mediumCOs.map((m: any) => m.id).join(',')}`); } catch(e) {}
              await this.delay(900);
              const executedDisplay = executedPlayer.getDisplayName();
              for (const med of mediumCOs) {
                if (this.aiStatementsStopped) break;
                try {
                  await this.delay(700);
                  // Prefer each medium's recorded mediumResults/fakeMediumResults for the previous day
                  let rec: any = null;
                  try {
                    const mres: Array<any> = (med as any).mediumResults || [];
                    const fmres: Array<any> = (med as any).fakeMediumResults || [];
                    // Prefer explicit record for previous day
                    rec = mres.find((r: any) => r && r.day === (this.day - 1)) || fmres.find((r: any) => r && r.day === (this.day - 1)) || null;
                    // If no day-matching record, try to find a record that targets the executed player
                    if (!rec && lastExecutedId != null) {
                      rec = mres.find((r: any) => r && r.targetId === lastExecutedId) || fmres.find((r: any) => r && r.targetId === lastExecutedId) || null;
                    }
                  } catch (e) { rec = null; }

                  let wasWerewolf: boolean | null = null;
                  let targetIdForEmit: number | null = lastExecutedId;
                  if (rec && typeof rec.result !== 'undefined') {
                    wasWerewolf = rec.result === MediumResult.WEREWOLF;
                    if (typeof rec.targetId === 'number') targetIdForEmit = rec.targetId;
                  } else {
                    // fallback to executedPlayer.role when no personal record
                    wasWerewolf = executedPlayer.role === Role.WEREWOLF;
                  }

                  const key = wasWerewolf ? 'medium_result_black' : 'medium_result_white';
                  const tpl = ((DIALOGUES[med.name] as any) || {})[key] as string | undefined;
                  let txt = '';
                  const executedDispForTxt = targetIdForEmit != null ? (this.getPlayerById(targetIdForEmit)?.getDisplayName() || executedDisplay) : executedDisplay;
                  if (tpl) {
                    if (tpl.includes('〇〇')) txt = tpl.replace(/〇〇/g, executedDispForTxt);
                    else txt = tpl;
                  } else {
                    txt = wasWerewolf ? `${executedDispForTxt}は人狼でした。` : `${executedDispForTxt}は人狼ではありませんでした。`;
                  }
                  this.statements.push({ day: this.day, playerId: med.id, playerName: med.getDisplayName(), content: txt });
                  try { console.log(`[TRACE medium_speaking] mediumId=${med.id} target=${targetIdForEmit} wasWerewolf=${wasWerewolf}`); } catch(e) {}
                  try {
                    // emit spoken statement (pass key so Day フェーズの発言制限に引っかからない)
                    this.emitPlayerStatement(med, txt, this.day, key);
                  } catch (e) { /* ignore per-medium emit errors */ }

                  // Emit player_result so client result screens update accordingly
                  try {
                    if (typeof targetIdForEmit === 'number') {
                      const targetName = this.getPlayerById(targetIdForEmit)?.getDisplayName() || '（不明）';
                      const resultLabel = wasWerewolf ? 'black' : 'white';
                      try { this.emitPlayerResult({ speakerId: med.id, day: this.day - 1, targetId: targetIdForEmit, result: resultLabel, targetName, type: 'medium' }, 'medium_sequence'); } catch (e) {}
                    }
                  } catch (e) { /* ignore emit errors */ }
                } catch (e) { /* per-medium ignore */ }
              }
              // After all medium results, wait and have two random players (excluding User and medium COs)
              // say `accept_understood` to acknowledge the medium announcements.
              try {
                await this.delay(900);
                const mediumIds = new Set(mediumCOs.map((m: Player) => m.id));
                const candidates = this.getAlivePlayers().filter(p => !(p instanceof UserPlayer) && !mediumIds.has(p.id));
                if (candidates.length > 0) {
                  const shuffled = candidates.slice().sort(() => Math.random() - 0.5);
                  const count = Math.min(2, shuffled.length);
                  for (let si = 0; si < count; si++) {
                    if (this.aiStatementsStopped) break;
                    const spk = shuffled[si];
                    const tplAcc = (DIALOGUES[spk.name] as any)?.accept_understood || 'なるほど、わかりました。';
                    const accTxt = tplAcc.replace(/〇〇/g, spk.getDisplayName());
                    this.statements.push({ day: this.day, playerId: spk.id, playerName: spk.getDisplayName(), content: accTxt });
                    this.emitPlayerStatement(spk, accTxt, this.day);
                    await this.delay(700);
                  }
                }
              } catch (e) { /* ignore */ }
              // After accept_understood, if the night victim was NOT a seer CO,
              // then either the moderator calms down or a random non-user/non-seer
              // emits ask_seer_black_candidates.
              try {
                const attackTargetId = this.lastNightAttackResult?.attackTargetId ?? null;
                const wasSeerCO = attackTargetId !== null && Array.isArray(state.coPlayers) && state.coPlayers.some((c: any) => c.playerId === attackTargetId && c.claimedRole === Role.SEER);
                if (!wasSeerCO) {
                  await this.delay(700);
                  // moderator を参照せず、ランダムな非ユーザー（かつ占いCOでない）を話者に選ぶ
                  const seerCOIds = new Set(((state as any).coPlayers || []).filter((c: any) => c.claimedRole === Role.SEER).map((c: any) => c.playerId));
                  const candidates = this.getAlivePlayers().filter(p => !(p instanceof UserPlayer) && !seerCOIds.has(p.id));
                  if (candidates.length > 0) {
                    const speakerForAsk = candidates[Math.floor(Math.random() * candidates.length)];
                    if (speakerForAsk) {
                      const tpl = (DIALOGUES[speakerForAsk.name] as any)?.ask_seer_black_candidates as string | undefined;
                      const txt = tpl || '占いの黒候補を教えてください。';
                      this.statements.push({ day: this.day, playerId: speakerForAsk.id, playerName: speakerForAsk.getDisplayName(), content: txt });
                      this.emitPlayerStatement(speakerForAsk, txt, this.day);
                    }
                  }
                }
              } catch (e) { /* ignore */ }
            }
            // If the night attack victim this morning was a seer CO, then after accept_understood
            // have user, moderator, surviving seer COs, and one random other (not among those
            // seers' day1 divination targets) speak `seer_killed_suspect`.
            try {
              const userPlayer = this.players.find(p => p instanceof UserPlayer) as UserPlayer | undefined;
              await this.delay(600);
              const attackTargetId = this.lastNightAttackResult?.attackTargetId ?? null;
              if (attackTargetId !== null) {
                const wasSeerCO = Array.isArray(state.coPlayers) && state.coPlayers.some((c: any) => c.playerId === attackTargetId && c.claimedRole === Role.SEER);
                if (wasSeerCO) {
                  const speakers: Player[] = [];
                  // user
                  if (userPlayer && userPlayer.isAlive()) speakers.push(userPlayer);
                  // surviving seer COs
                  const survivingSeers = (state.coPlayers || []).filter((c: any) => c.claimedRole === Role.SEER).map((c: any) => this.getPlayerById(c.playerId)).filter((p): p is Player => !!p && p.isAlive());
                  for (const s of survivingSeers) if (!speakers.some(x => x.id === s.id)) speakers.push(s);

                  // Determine day1 divination targets by those seer COs
                  const day1Divined = new Set<number>();
                  for (const s of survivingSeers) {
                    try {
                      const divs: Array<any> = (s as any).divinationResults || [];
                      const rec = divs.find((r: any) => r && r.day === 1 && typeof r.targetId === 'number');
                      if (rec) day1Divined.add(rec.targetId);
                    } catch (e) {}
                  }

                  // pick one random additional speaker excluding those day1 targets and existing speakers
                  const extraCandidates = this.getAlivePlayers().filter(p => p.isAlive() && !speakers.some(s => s.id === p.id) && !day1Divined.has(p.id));
                  let extra: Player | undefined = undefined;
                  if (extraCandidates.length > 0) extra = extraCandidates[Math.floor(Math.random() * extraCandidates.length)];
                  else {
                    const fallback = this.getAlivePlayers().filter(p => p.isAlive() && !speakers.some(s => s.id === p.id));
                    if (fallback.length > 0) extra = fallback[Math.floor(Math.random() * fallback.length)];
                  }
                  if (extra) speakers.push(extra);

                  // Emit seer_killed_suspect from each speaker in order
                  for (const sp of speakers) {
                    if (this.aiStatementsStopped) break;
                    try {
                      await this.delay(700);
                      const tpl = ((DIALOGUES[sp.name] as any) || {})['seer_killed_suspect'] as string | undefined;
                      const txt = tpl ? tpl.replace(/〇〇/g, this.getPlayerById(attackTargetId)?.getDisplayName() || '') : '占い師が噛まれたので今いる占い師や片白が怪しいです。';
                      this.statements.push({ day: this.day, playerId: sp.id, playerName: sp.getDisplayName(), content: txt });
                      this.emitPlayerStatement(sp, txt, this.day);
                    } catch (e) { /* per-speaker ignore */ }
                  }

                  // After seer_killed_suspect, wait then have surviving seer COs or their day1 divination targets
                  // (if alive) speak `deny_accusation` to protest the suspicion.
                  try {
                    await this.delay(700);
                    const denySpeakers: Player[] = [];
                    // surviving seer COs (already computed)
                    for (const s of survivingSeers) {
                      if (s.isAlive() && !denySpeakers.some(ds => ds.id === s.id)) denySpeakers.push(s);
                    }
                    // day1 divined targets by those seer COs
                    for (const tid of Array.from(day1Divined)) {
                      const tp = this.getPlayerById(tid);
                      if (tp && tp.isAlive() && !denySpeakers.some(ds => ds.id === tp.id)) denySpeakers.push(tp);
                    }
                    for (const ds of denySpeakers) {
                      if (this.aiStatementsStopped) break;
                      try {
                        await this.delay(600);
                        const tpl2 = ((DIALOGUES[ds.name] as any) || {})['deny_accusation'] as string | undefined;
                        const txt2 = tpl2 || '違います！私は人狼ではありません！';
                        this.statements.push({ day: this.day, playerId: ds.id, playerName: ds.getDisplayName(), content: txt2 });
                        this.emitPlayerStatement(ds, txt2, this.day);
                      } catch (e) { /* ignore per speaker */ }
                    }
                  } catch (e) { /* ignore */ }
                  // After deny_accusation sequence for killed seer CO, wait then moderator calms down
                  // or a random non-user/non-seer asks seer black candidates.
                  try {
                    await this.delay(700);
                    // 進行役不在のため、ランダムな非ユーザー（かつ占い師でない）を選んで
                    // 落ち着いた一言と占いの黒候補の質問を行わせる
                    const candidates = this.getAlivePlayers().filter(p => !(p instanceof UserPlayer) && p.role !== Role.SEER);
                    if (candidates.length > 0) {
                      const sp = candidates[Math.floor(Math.random() * candidates.length)];
                      const calmTpl = (DIALOGUES[sp.name] as any)?.calm_down as string | undefined;
                      const calmTxt = calmTpl || '落ち着いてください。';
                      this.statements.push({ day: this.day, playerId: sp.id, playerName: sp.getDisplayName(), content: calmTxt });
                      this.emitPlayerStatement(sp, calmTxt, this.day);
                      try { await this.delay(600); } catch (e) {}
                      const tpl = (DIALOGUES[sp.name] as any)?.ask_seer_black_candidates as string | undefined;
                      const txt = tpl || '占いの黒候補を教えてください。';
                      this.statements.push({ day: this.day, playerId: sp.id, playerName: sp.getDisplayName(), content: txt });
                      this.emitPlayerStatement(sp, txt, this.day);
                    }
                  } catch (e) { /* ignore */ }
                }
              }
            } catch (e) { /* ignore */ }
          }
        }
      } catch (e) { /* ignore overall */ }

      const formationKey = state.formation === '2-1' ? 'formation_2_1' : ((state.formation as any) === '2-2' ? 'formation_2_2' : (state.formation === '3-1' ? 'formation_3_1' : null));
      if (formationKey) {
        // pick up to two distinct speakers who are NOT Seer/Medium
        const shuffledAll = [...aiPlayers].filter(p => p.isAlive()).sort(() => Math.random() - 0.5);
        const speakers: typeof aiPlayers = [] as any;
        for (const candidate of shuffledAll) {
          if (speakers.length >= 2) break;
          if (candidate.role === Role.SEER || candidate.role === Role.MEDIUM) continue;
          speakers.push(candidate);
        }

        if (speakers.length > 0) {
          for (const sp of speakers) {
            try { console.log(`[DEBUG aiStatementsStopped check] day=${this.day} loc=2153 aiStatementsStopped=${this.aiStatementsStopped}`); } catch (e) { console.log('[DEBUG aiStatementsStopped check]'); }
            if (this.aiStatementsStopped) return;
            const dlg = DIALOGUES[sp.name] && (DIALOGUES[sp.name] as any)[formationKey];
            const text = dlg && dlg !== '---' ? dlg : `（${sp.getDisplayName()}）: 陣形に合わせた見解を述べます。`;
            this.statements.push({ day: this.day, playerId: sp.id, playerName: sp.getDisplayName(), content: text });
            this.emitPlayerStatement(sp, text, this.day);
            await this.delay(800);
          }

          // For 2-2 formation (no single moderator), have a random non-seer/non-medium AI ask the seer/medium breakdown
          if ((state.formation as any) === '2-2') {
            try {
              const coIds = new Set<number>(((state as any).coPlayers || []).map((c: any) => c.playerId));
              const askCandidates = aiPlayers.filter(p =>
                p.isAlive() &&
                !(p instanceof UserPlayer) &&
                p.role !== Role.SEER &&
                p.role !== Role.MEDIUM &&
                !coIds.has(p.id)
              );
              if (askCandidates.length > 0) {
                // If formation is 2-2 and there's a confirmed white, prefer them as asker
                let asker: Player | undefined = undefined;
                if ((state as any).formation === '2-2') {
                  const confirmed = askCandidates.find(p => (p as any).confirmedWhite && p.isAlive());
                  if (confirmed) asker = confirmed;
                }
                if (!asker) asker = askCandidates[Math.floor(Math.random() * askCandidates.length)];
                if (asker) {
                  try { console.log(`[DEBUG aiStatementsStopped check] day=${this.day} loc=2168 aiStatementsStopped=${this.aiStatementsStopped}`); } catch (e) { console.log('[DEBUG aiStatementsStopped check]'); }
                  if (this.aiStatementsStopped) return;
                  await this.delay(600);
                  const askTxt = (DIALOGUES[asker.name] && (DIALOGUES[asker.name] as any).ask_seer_counter_breakdown_2_2) || '占い師、霊能者の方々の対抗の内訳はどんな感じですか？';
                  this.statements.push({ day: this.day, playerId: asker.id, playerName: asker.getDisplayName(), content: askTxt });
                  this.emitPlayerStatement(asker, askTxt, this.day);
                  try { console.log(`[Day1 2-2 Ask] ${asker.name}: ${askTxt}`); } catch (e) {}
                  await this.delay(3600);
                  // After ask in 2-2, have seer COs (including fake) speak using seer template,
                  // and medium COs speak using medium template.
                  try {
                    const seerCOs = state.coPlayers.filter(c => c.claimedRole === Role.SEER).map(c => this.getPlayerById(c.playerId)).filter((x): x is Player => !!x);
                    const mediumCOs = state.coPlayers.filter(c => c.claimedRole === Role.MEDIUM).map(c => this.getPlayerById(c.playerId)).filter((x): x is Player => !!x);
                    const dayForCheck2 = Math.max(1, this.day || 1);
                    const opposedTargetIds2 = new Set<number>();
                    for (const s of seerCOs) {
                      try {
                        const divs: Array<any> = (s as any).divinationResults || [];
                        const rec = divs.find((r: any) => r.day === dayForCheck2 && r.result === DivinationResult.HUMAN);
                        if (rec) {
                          const tid = rec.targetId;
                          const targetIsSeerCO = state.coPlayers.some(c => c.playerId === tid && c.claimedRole === Role.SEER);
                          if (targetIsSeerCO) opposedTargetIds2.add(tid);
                        }
                      } catch (e) { /* ignore */ }
                    }

                    // seer COs speak (use counter_breakdown_seer template, reference medium COs for 〇〇)
                    for (const seer of seerCOs) {
                      // DEBUG: check if aiStatementsStopped prevents further statements
                      try { console.log(`[DEBUG ask_who pre-check] day=${this.day} aiStatementsStopped=${this.aiStatementsStopped}`); } catch (e) { console.log('[DEBUG ask_who pre-check]'); }
                      try { console.log(`[DEBUG aiStatementsStopped check] day=${this.day} loc=2198 aiStatementsStopped=${this.aiStatementsStopped}`); } catch (e) { console.log('[DEBUG aiStatementsStopped check]'); }
                      if (this.aiStatementsStopped) return;
                      if (seer instanceof UserPlayer) continue;
                      // pick nameA from mediumCOs if available, else from seerCOs excluding self
                      let nameA = '';
                      let nameB = '';
                      let roleLabel: string | undefined = undefined;
                      const othersForA = mediumCOs.filter(p => p.id !== seer.id);
                      const poolA = othersForA.length > 0 ? othersForA : seerCOs.filter(p => p.id !== seer.id);
                      if (poolA.length > 0) nameA = poolA[Math.floor(Math.random() * poolA.length)].getDisplayName();
                      const remaining = [...seerCOs, ...mediumCOs].filter(p => p.id !== seer.id && p.getDisplayName() !== nameA);
                      if (remaining.length >= 1) nameB = remaining[Math.floor(Math.random() * remaining.length)].getDisplayName();
                      // choose a third name for '××' from remaining COs excluding speaker, nameA and nameB
                      const remainingForC = [...seerCOs, ...mediumCOs].filter(p => p.id !== seer.id && p.getDisplayName() !== nameA && p.getDisplayName() !== nameB);
                      let nameC = '';
                      if (remainingForC.length > 0) nameC = remainingForC[Math.floor(Math.random() * remainingForC.length)].getDisplayName();
                      const key = 'counter_breakdown_seer';
                      const dlg = (DIALOGUES[seer.name] && (DIALOGUES[seer.name] as any)[key]) || `${nameA}は${nameB}で、${nameB}は怪しいかな。`;
                      const txt = dlg.replace(/〇〇/g, nameA).replace(/△△/g, (roleLabel || nameB)).replace(/××/g, (nameC || nameB));
                      this.statements.push({ day: this.day, playerId: seer.id, playerName: seer.getDisplayName(), content: txt });
                      this.emitPlayerStatement(seer, txt, this.day);
                      await this.delay(4800);
                    }

                    // medium COs speak (use counter_breakdown_medium template, reference seer COs for 〇〇)
                    for (const med of mediumCOs) {
                      try { console.log(`[DEBUG aiStatementsStopped check] day=${this.day} loc=2223 aiStatementsStopped=${this.aiStatementsStopped}`); } catch (e) { console.log('[DEBUG aiStatementsStopped check]'); }
                      if (this.aiStatementsStopped) return;
                      if (med instanceof UserPlayer) continue;
                      let nameA = '';
                      let nameB = '';
                      const poolA = seerCOs.filter(p => p.id !== med.id);
                      if (poolA.length > 0) nameA = poolA[Math.floor(Math.random() * poolA.length)].getDisplayName();
                      const remaining = [...seerCOs, ...mediumCOs].filter(p => p.id !== med.id && p.getDisplayName() !== nameA);
                      if (remaining.length > 0) nameB = remaining[Math.floor(Math.random() * remaining.length)].getDisplayName();
                      // pick third name for '××' excluding self, nameA and nameB
                      const remainingForC_med_early = [...seerCOs, ...mediumCOs].filter(p => p.id !== med.id && p.getDisplayName() !== nameA && p.getDisplayName() !== nameB);
                      let nameC_med_early = '';
                      if (remainingForC_med_early.length > 0) nameC_med_early = remainingForC_med_early[Math.floor(Math.random() * remainingForC_med_early.length)].getDisplayName();
                      const keyMed = 'counter_breakdown_medium';
                      const dlgMed = (DIALOGUES[med.name] && (DIALOGUES[med.name] as any)[keyMed]) || `${nameA}は${nameB}で、${nameB}は怪しいかな。`;
                      const txtMed = dlgMed.replace(/〇〇/g, nameA).replace(/△△/g, nameB).replace(/××/g, (nameC_med_early || nameB));
                      this.statements.push({ day: this.day, playerId: med.id, playerName: med.getDisplayName(), content: txtMed });
                      this.emitPlayerStatement(med, txtMed, this.day);
                      await this.delay(4800);
                    }
                    // after all counter_breakdowns, have the original asker acknowledge
                    try {
                      try { console.log(`[DEBUG aiStatementsStopped check] day=${this.day} loc=2244 aiStatementsStopped=${this.aiStatementsStopped}`); } catch (e) { console.log('[DEBUG aiStatementsStopped check]'); }
                      if (this.aiStatementsStopped) return;
                      await this.delay(600);
                      const accTxt = (DIALOGUES[asker.name] && (DIALOGUES[asker.name] as any).accept_understood) || 'なるほど、わかりました。';
                      this.statements.push({ day: this.day, playerId: asker.id, playerName: asker.getDisplayName(), content: accTxt });
                      this.emitPlayerStatement(asker, accTxt, this.day);
                      await this.delay(1200);

                      // then ask a silent player: in 2-2 prefer confirmed white, else pick a random non-user AI
                      let speakerForAskSilent: Player | undefined = undefined;
                      if ((state as any).formation === '2-2') {
                        const confirmed = this.getAlivePlayers().find(p => (p as any).confirmedWhite && p.isAlive() && !(p instanceof UserPlayer));
                        if (confirmed) {
                          speakerForAskSilent = confirmed;
                        }
                      }
                      if (!speakerForAskSilent) {
                        const candidates = aiPlayers.filter(p => p.isAlive() && !(p instanceof UserPlayer));
                        if (candidates.length > 0) speakerForAskSilent = candidates[Math.floor(Math.random() * candidates.length)];
                      }

                      // ask_who helper state and emitter (placed before poke sites so it can be scheduled immediately)
                      let askWhoEmitted = false;
                      let speakerForAskWho: Player | undefined = undefined;
                      (this as any).emitAskWho = async () => {
                        if (askWhoEmitted) return;
                        askWhoEmitted = true;
                        // immediately pause background AI auto-statements to avoid interleaving self-intros
                        try { (this as any).suspendAIStatements = true; } catch (e) {}
                        // safety: if something goes wrong, ensure resume after timeout
                        try { setTimeout(() => { try { if ((this as any).suspendAIStatements) (this as any).suspendAIStatements = false; } catch (e) {} }, 15000); } catch (e) {}
                        try { console.log(`[TRACE] reached pre-ask_who checkpoint day=${this.day} loc=~2590 aiStatementsStopped=${this.aiStatementsStopped}`); } catch (e) {}

                        let askWhoCandidates: Player[] = [];
                        if ((state as any).formation === '2-2') {
                          const confirmed = this.getAlivePlayers().find(p => (p as any).confirmedWhite && p.isAlive() && !(p instanceof UserPlayer));
                          if (confirmed) speakerForAskWho = confirmed;
                        }
                        try { console.log(`[TRACE ABOUT_TO_SELECT_ASK_WHO] day=${this.day}`); } catch (e) {}
                        if (!speakerForAskWho) {
                          askWhoCandidates = aiPlayers.filter(p => p.isAlive() && !(p instanceof UserPlayer));
                          if (askWhoCandidates.length > 0) speakerForAskWho = askWhoCandidates[Math.floor(Math.random() * askWhoCandidates.length)];
                        }

                        try { console.log(`[DEBUG ask_who] day=${this.day} aiStatementsStopped=${this.aiStatementsStopped} askWhoCandidates_ids=${askWhoCandidates.map(p=>p.id).join(',')} count=${askWhoCandidates.length}`); } catch (e) { console.log('[DEBUG ask_who] unable to stringify candidates'); }

                        if (!speakerForAskWho) {
                          try {
                            const fallback = this.getAlivePlayers().find(p => p.isAlive() && !(p instanceof UserPlayer));
                            if (fallback) {
                              speakerForAskWho = fallback;
                              console.log(`[DEBUG ask_who FALLBACK_TO_AI] using playerId=${fallback.id}`);
                            } else {
                              const gmAsk = 'みんなは今いるグレーの中で怪しいと思う方は誰ですか？';
                              try { this.eventEmitter.emit('gm_message', { message: gmAsk }); } catch (e) { console.log('[DEBUG ask_who GM_EMIT_ERROR]', e); }
                              try {
                                const gmPlayer = ({ id: -1, name: 'GM', getDisplayName: () => 'GM', isAlive: () => true } as unknown) as Player;
                                speakerForAskWho = gmPlayer;
                                this.statements.push({ day: this.day, playerId: gmPlayer.id, playerName: gmPlayer.getDisplayName(), content: gmAsk });
                                console.log('[DEBUG ask_who GM_FALLBACK] using GM-like speaker');
                              } catch (e) { console.log('[DEBUG ask_who GM_FALLBACK_PUSH_ERROR]', e); }
                            }
                          } catch (e) { console.log('[DEBUG ask_who FALLBACK_ERROR]', e); }
                        }

                          if (speakerForAskWho) {
                            try { (this as any)._lastAskWhoSpeakerId = speakerForAskWho.id; } catch (e) {}
                          try { console.log(`[TRACE ASK_WHO_EMIT] chosenId=${speakerForAskWho.id} chosenName=${speakerForAskWho.getDisplayName()}`); } catch (e) {}
                          try { console.log(`[DEBUG ask_who chosen] speakerId=${speakerForAskWho.id} speakerName=${speakerForAskWho.getDisplayName()}`); } catch (e) { console.log('[DEBUG ask_who chosen]'); }
                          const askWho = (DIALOGUES[speakerForAskWho.name] as any)?.ask_who_suspect || 'みんなは今いるグレーの中で怪しいと思う方は誰ですか？';
                          try { console.log(`[DEBUG ask_who before push] speakerId=${speakerForAskWho.id} content=${askWho}`); } catch (e) { console.log('[DEBUG ask_who before push]'); }
                          this.statements.push({ day: this.day, playerId: speakerForAskWho.id, playerName: speakerForAskWho.getDisplayName(), content: askWho });
                          try { console.log(`[DEBUG ask_who after push] statements_len=${this.statements.length} last_playerId=${this.statements.slice(-1)[0].playerId}`); } catch (e) {}
                          try { console.log(`[DEBUG ask_who before emit] speakerId=${speakerForAskWho.id}`); } catch (e) { console.log('[DEBUG ask_who before emit]'); }
                          try { this.emitPlayerStatement(speakerForAskWho, askWho, this.day); try { console.log(`[DEBUG ask_who after emit] speakerId=${speakerForAskWho.id}`); } catch (e) { console.log('[DEBUG ask_who after emit]'); } } catch (err) { console.log('[DEBUG ask_who emit ERROR]', err); }
                          try { console.log('[DEBUG ask_who before delay] awaiting 4800ms'); } catch (e) {}
                          await this.delay(4800);
                          // keep suspend until the controlled vague_suspect flow takes over; safety handler will resume if needed
                          try { console.log('[DEBUG ask_who after delay]'); } catch (e) {}
                          // record the last ask_who speaker id for later vague sequencing
                          try { (this as any)._vagueDone = false; } catch (e) {}
                          try { (this as any)._askWhoSpeakerId = speakerForAskWho ? speakerForAskWho.id : undefined; } catch (e) {}
                          try { await (this as any).runVagueSequence?.(aiPlayers, (this as any)._askWhoSpeakerId); } catch (e) { console.log('[DEBUG emitAskWho->runVagueSequence error]', e); }
                          try { console.log(`[TRACE ask_who recorded askWhoSpeaker=${(this as any)._askWhoSpeakerId || 'none'}]`); } catch (e) {}
                        }
                      };

                      // Helper to run vague_suspect / none_suspect sequence later (e.g., after conformity)
                      // dynamic runVagueSequence removed here; permanent method will be used instead

                      if (speakerForAskSilent) {
                        const askSilentTpl = (DIALOGUES[speakerForAskSilent.name] && (DIALOGUES[speakerForAskSilent.name] as any).ask_silent_player) || '〇〇はあまり話していませんが…';
                        // pick silent target similar to moderator flow: least-speaking alive non-mod, non-user
                        const counts: Record<number, number> = {};
                        for (const s of this.statements) counts[s.playerId] = (counts[s.playerId] || 0) + 1;
                        const aliveNonSpeaker = this.getAlivePlayers().filter(p => p.id !== (speakerForAskSilent ? speakerForAskSilent.id : -1) && !(p instanceof UserPlayer) && !( (p as any).confirmedWhite ));
                        let minCount = Infinity; let silentPlayer: Player | null = null;
                        for (const p of aliveNonSpeaker) {
                          const c = counts[p.id] || 0;
                          if (c < minCount) { minCount = c; silentPlayer = p; }
                        }

                        const askTxt2 = askSilentTpl.replace(/〇〇/g, silentPlayer ? silentPlayer.getDisplayName() : '');
                        this.statements.push({ day: this.day, playerId: speakerForAskSilent.id, playerName: speakerForAskSilent.getDisplayName(), content: askTxt2 });
                        this.emitPlayerStatement(speakerForAskSilent, askTxt2, this.day);
                        await this.delay(4200);

                        if (silentPlayer && !(silentPlayer instanceof UserPlayer)) {
                          const exKeys = ['excuse1','excuse2','excuse3'];
                          const chosenEx = exKeys[Math.floor(Math.random()*exKeys.length)];
                          const exDlg = (DIALOGUES[silentPlayer.name] && (DIALOGUES[silentPlayer.name] as any)[chosenEx]) || 'すみません、見てました。';
                          const exTxt = exDlg.replace(/〇〇/g, speakerForAskSilent.getDisplayName());
                          this.statements.push({ day: this.day, playerId: silentPlayer.id, playerName: silentPlayer.getDisplayName(), content: exTxt });
                          this.emitPlayerStatement(silentPlayer, exTxt, this.day);
                          await this.delay(4200);

                          try { console.log(`[DEBUG aiStatementsStopped check] day=${this.day} loc=2287 aiStatementsStopped=${this.aiStatementsStopped}`); } catch (e) { console.log('[DEBUG aiStatementsStopped check]'); }
                          if (this.aiStatementsStopped) return;
                          const others = aiPlayers.filter(p => p.isAlive() && p.id !== silentPlayer.id && p.id !== (speakerForAskSilent ? speakerForAskSilent.id : -1));
                          if (others.length > 0) {
                            const other = others[Math.floor(Math.random() * others.length)];
                            const pokeKey = chosenEx === 'excuse1' ? 'poke_excuse1' : (chosenEx === 'excuse2' ? 'poke_excuse2' : 'poke_excuse1');
                            const pokeDlg2 = (DIALOGUES[other.name] && (DIALOGUES[other.name] as any)[pokeKey]) || '〇〇も議論に参加してほしいです。';
                            const pokeTxt2 = pokeDlg2.replace(/〇〇/g, silentPlayer.getDisplayName());
                            this.statements.push({ day: this.day, playerId: other.id, playerName: other.getDisplayName(), content: pokeTxt2 });
                            this.emitPlayerStatement(other, pokeTxt2, this.day);
                            try { console.log(`[TRACE POKE_DONE] day=${this.day} silent=${silentPlayer ? silentPlayer.id : 'none'} speaker=${other.id} speakerName=${other.getDisplayName()}`); } catch (e) {}
                            await this.delay(3600);
                            // If formation is 2-2, schedule ask_who after a short additional delay
                              try {
                                // For formations 2-2, 2-1 and 3-1, schedule an immediate ask_who_suspect
                                // after poke/defend exchanges so the group is then asked who they suspect.
                                if ((state as any).formation === '2-2' || (state as any).formation === '2-1' || (state as any).formation === '3-1') {
                                  await this.delay(1200);
                                  try { await this.emitAskWho(); } catch(e) { console.log('[DEBUG emitAskWho call error]', e); }
                                }
                              } catch (e) { console.log('[DEBUG ask_who scheduled emit error]', e); }
                          }
                        }
                      }
                    } catch (e) { /* ignore */ }
                  } catch (e) { /* ignore */ }
                }
              }
            } catch (e) { /* ignore */ }
          }

          // 霊能者が生存していれば進行宣言を出す（ただし formation が '2-2' の場合はスキップ）
          try { console.log(`[DEBUG aiStatementsStopped check] day=${this.day} loc=2308 aiStatementsStopped=${this.aiStatementsStopped}`); } catch (e) { console.log('[DEBUG aiStatementsStopped check]'); }
          if (this.aiStatementsStopped) return;
          const mediumPlayer = this.players.find(p => p.role === Role.MEDIUM && p.isAlive());
          if (state.formation !== '2-2') {
            if (mediumPlayer && !(mediumPlayer instanceof UserPlayer)) {
              await this.delay(2000);
              const text = (DIALOGUES[mediumPlayer.name] && (DIALOGUES[mediumPlayer.name] as any).moderator_declare) || 'では霊能者として進行します。';
              this.statements.push({ day: this.day, playerId: mediumPlayer.id, playerName: mediumPlayer.getDisplayName(), content: text });
              this.emitPlayerStatement(mediumPlayer, text, this.day);

              // 初日の単独COで霊能者が確定している場合、霊能者宣言時点で信用度を100%にする（GM除く）
              try {
                if (this.day === 1) {
                    const mediumCOs = state.coPlayers.filter(c => c.claimedRole === Role.MEDIUM);
                  if (mediumCOs.length === 1 && mediumCOs[0].playerId === mediumPlayer.id && mediumPlayer.id !== 1) {
                    mediumPlayer.confirmedWhite = true;
                    try { this.eventEmitter.emit('player_memo_update', { playerId: mediumPlayer.id }); } catch (e) {}
                    console.log(`【信用度更新】${mediumPlayer.name}（ID:${mediumPlayer.id}）を白確に設定しました`);
                  }
                }
              } catch (e) {
                // ignore
              }
              // 進行役の設定: 2-1 または 3-1 の陣形で霊能者の進行が確定したら進行役に設定する
              // 進行役の概念は廃止したため、以前の moderatorId 設定は行わない

              // さらに2秒待ってから request 発言群を流す
              await this.delay(2000);
              const reqCandidates = aiPlayers.filter(p => p.isAlive() && p.id !== mediumPlayer.id);
              const rqShuffled = [...reqCandidates].sort(() => Math.random() - 0.5);
              const requesters = rqShuffled.slice(0, Math.min(3, rqShuffled.length));
              for (const r of requesters) {
                try { console.log(`[DEBUG aiStatementsStopped check] day=${this.day} loc=2345 aiStatementsStopped=${this.aiStatementsStopped}`); } catch (e) { console.log('[DEBUG aiStatementsStopped check]'); }
                if (this.aiStatementsStopped) return;
                const txt = (DIALOGUES[r.name] && DIALOGUES[r.name].request) || 'お願いします。';
                this.statements.push({ day: this.day, playerId: r.id, playerName: r.getDisplayName(), content: txt });
                this.emitPlayerStatement(r, txt, this.day);
                await this.delay(600);
              }
              // 進行役（霊能者）が設定されていて、2-1 または 3-1 陣形の場合は
              // 少し遅延して進行役が占い側の対抗内訳を尋ねる発言を出す
                if ((state.formation === '2-1' || state.formation === '3-1')) {
                  // formation が 2-1/3-1 の場合、霊能者宣言者を優先的に質問者にする。
                  let moderator: Player | undefined = undefined;
                  if (mediumPlayer && mediumPlayer.isAlive() && !(mediumPlayer instanceof UserPlayer)) moderator = mediumPlayer;
                  if (!moderator) moderator = aiPlayers.find(p => p.isAlive() && !(p instanceof UserPlayer));
                  if (moderator && (moderator as any).isAlive && (moderator as any).isAlive()) {
                    try { console.log(`[DEBUG aiStatementsStopped check] day=${this.day} loc=2356 aiStatementsStopped=${this.aiStatementsStopped}`); } catch (e) { console.log('[DEBUG aiStatementsStopped check]'); }
                    if (this.aiStatementsStopped) return;
                    await this.delay(800);
                    const askTxt = (DIALOGUES[moderator.name] && (DIALOGUES[moderator.name].ask_seer_counter_breakdown)) || '占い師の方々の対抗の内訳はどんな感じですか？';
                    this.statements.push({ day: this.day, playerId: moderator.id, playerName: moderator.getDisplayName(), content: askTxt });
                    this.emitPlayerStatement(moderator, askTxt, this.day);
                    try { console.log(`[Day1 Moderator Ask] ${moderator.name}: ${askTxt}`); } catch (e) {}
                    await this.delay(3600);

                    // 占い師の対抗内訳を返す
                    const seerCOs = state.coPlayers.filter(c => c.claimedRole === Role.SEER).map(c => this.getPlayerById(c.playerId)).filter((x): x is Player => !!x);
                    const mediumCOs = state.coPlayers.filter(c => c.claimedRole === Role.MEDIUM).map(c => this.getPlayerById(c.playerId)).filter((x): x is Player => !!x);
                      // Precompute which CO seers were divined as HUMAN by any seer today
                      const dayForCheck = Math.max(1, this.day || 1);
                      const opposedTargetIds = new Set<number>();
                      for (const s of seerCOs) {
                        try {
                          const divs: Array<any> = (s as any).divinationResults || [];
                          const rec = divs.find((r: any) => r.day === dayForCheck && r.result === DivinationResult.HUMAN);
                          if (rec) {
                            const tid = rec.targetId;
                            const targetIsSeerCO = state.coPlayers.some(c => c.playerId === tid && c.claimedRole === Role.SEER);
                            if (targetIsSeerCO) opposedTargetIds.add(tid);
                          }
                        } catch (e) { /* ignore */ }
                      }
                    if (seerCOs.length > 0) {
                      const isTwoOne = state.formation === '2-1';
                      const counterRecords: Array<{ targetName: string; secondName?: string; roleLabel?: string }> = [];

                      // In 2-2 formation, have both seer COs and medium COs give breakdowns using role-specific templates
                      for (const seer of seerCOs) {
                        try { console.log(`[DEBUG aiStatementsStopped check] day=${this.day} loc=2387 aiStatementsStopped=${this.aiStatementsStopped}`); } catch (e) { console.log('[DEBUG aiStatementsStopped check]'); }
                        if (this.aiStatementsStopped) return;
                        if (seer instanceof UserPlayer) continue;
                        const others = (state.formation as any) === '2-2' ? mediumCOs.filter(s => s.id !== seer.id) : seerCOs.filter(s => s.id !== seer.id);
                        let nameA = '';
                        let nameB = '';
                        let roleLabel: string | undefined = undefined;
                        if (isTwoOne) {
                          if (others.length > 0) nameA = others[Math.floor(Math.random() * others.length)].getDisplayName();
                          roleLabel = Math.random() < 0.5 ? '人狼' : '狂人';
                        } else {
                          if (others.length >= 2) {
                            const shuffled = [...others].sort(() => Math.random() - 0.5);
                            nameA = shuffled[0].getDisplayName();
                            nameB = shuffled[1].getDisplayName();
                          } else if (others.length === 1) {
                            nameA = others[0].getDisplayName();
                            const any = (state.formation as any) === '2-2'
                              ? [...seerCOs, ...mediumCOs].filter(p => p.id !== seer.id && p.id !== (others[0] ? others[0].id : -1))
                              : this.getAlivePlayers().filter(p => p.id !== seer.id && p.id !== (others[0] ? others[0].id : -1));
                            if (any.length > 0) nameB = any[Math.floor(Math.random() * any.length)].getDisplayName();
                          } else {
                            const any = (state.formation as any) === '2-2'
                              ? [...seerCOs, ...mediumCOs].filter(p => p.id !== seer.id)
                              : this.getAlivePlayers().filter(p => p.id !== seer.id);
                            if (any.length > 0) nameA = any[Math.floor(Math.random() * any.length)].getDisplayName();
                          }
                        }

                        // If this seer specifically divined a CO seer as HUMAN today, force substitution
                        try {
                          const divs: Array<any> = (seer as any).divinationResults || [];
                          const rec = divs.find((r: any) => r.day === dayForCheck && r.result === DivinationResult.HUMAN);
                          if (rec) {
                            const targetId = rec.targetId;
                            if (opposedTargetIds.has(targetId)) {
                              if (isTwoOne) {
                                roleLabel = '狂人';
                              } else {
                                const opposed = seerCOs.find(s => s && s.id === targetId);
                                const otherOpposed = seerCOs.find(s => s && s.id !== seer.id && s.id !== targetId);
                                if (opposed) nameA = opposed.getDisplayName();
                                if (otherOpposed) nameB = otherOpposed.getDisplayName();
                              }
                            }
                          }
                        } catch (e) { /* ignore safety */ }
                        // choose template key: prefer seer/medium-specific ones for 2-2
                        const key = (state.formation as any) === '2-2' ? 'counter_breakdown_seer' : (isTwoOne ? 'counter_breakdown_1' : 'counter_breakdown_2');
                        // pick third name for '××' from COs excluding speaker, nameA and nameB
                        const remainingForC2 = [...seerCOs, ...mediumCOs].filter(p => p.id !== seer.id && p.getDisplayName() !== nameA && p.getDisplayName() !== nameB);
                        let nameC2 = '';
                        if (remainingForC2.length > 0) nameC2 = remainingForC2[Math.floor(Math.random() * remainingForC2.length)].getDisplayName();
                        const dlg = (DIALOGUES[seer.name] && (DIALOGUES[seer.name] as any)[key]) || (isTwoOne ? `${nameA}は対抗の占い師、${roleLabel}が怪しいかな。` : `${nameA}は${nameB}で、${nameB}は怪しいかな。`);
                        const txt = dlg.replace(/〇〇/g, nameA).replace(/△△/g, (roleLabel || nameB)).replace(/××/g, (nameC2 || nameB));
                        this.statements.push({ day: this.day, playerId: seer.id, playerName: seer.getDisplayName(), content: txt });
                        this.emitPlayerStatement(seer, txt, this.day);
                        counterRecords.push({ targetName: nameA, secondName: nameB, roleLabel });
                        await this.delay(4800);
                      }

                      // For 2-2 formation, also have medium COs (including fake) speak using medium-specific template
                      if ((state.formation as any) === '2-2') {
                        for (const med of mediumCOs) {
                          try { console.log(`[DEBUG aiStatementsStopped check] day=${this.day} loc=2450 aiStatementsStopped=${this.aiStatementsStopped}`); } catch (e) { console.log('[DEBUG aiStatementsStopped check]'); }
                          if (this.aiStatementsStopped) return;
                          if (med instanceof UserPlayer) continue;
                          // pick targets among seerCOs/mediumCOs excluding self
                          const others = [...seerCOs, ...mediumCOs].filter(p => p.id !== med.id);
                          let nameA = '';
                          let nameB = '';
                          let roleLabel: string | undefined = undefined;
                          if (others.length > 0) {
                            // pick one candidate to reference as 〇〇 (prefer seer COs if available)
                            const seerPrefer = others.filter(p => state.coPlayers.some(c => c.playerId === p.id && c.claimedRole === Role.SEER));
                            const poolA = seerPrefer.length > 0 ? seerPrefer : others;
                            nameA = poolA[Math.floor(Math.random() * poolA.length)].getDisplayName();
                          }
                          // pick another random remaining for nameB
                          const remaining = [...seerCOs, ...mediumCOs].filter(p => p.id !== med.id && p.getDisplayName() !== nameA);
                          if (remaining.length > 0) {
                            nameB = remaining[Math.floor(Math.random() * remaining.length)].getDisplayName();
                          }
                          // pick a third name for '××' excluding self, nameA and nameB
                          const remainingForCMed = [...seerCOs, ...mediumCOs].filter(p => p.id !== med.id && p.getDisplayName() !== nameA && p.getDisplayName() !== nameB);
                          let nameCMed = '';
                          if (remainingForCMed.length > 0) nameCMed = remainingForCMed[Math.floor(Math.random() * remainingForCMed.length)].getDisplayName();
                          const keyMed = 'counter_breakdown_medium';
                          const dlgMed = (DIALOGUES[med.name] && (DIALOGUES[med.name] as any)[keyMed]) || `${nameA}は${nameB}で、${nameB}は怪しいかな。`;
                          const txtMed = dlgMed.replace(/〇〇/g, nameA).replace(/△△/g, (roleLabel || nameB)).replace(/××/g, (nameCMed || nameB));
                          this.statements.push({ day: this.day, playerId: med.id, playerName: med.getDisplayName(), content: txtMed });
                          this.emitPlayerStatement(med, txtMed, this.day);
                          counterRecords.push({ targetName: nameA, secondName: nameB, roleLabel });
                          await this.delay(4800);
                        }
                      }

                      if (this.aiStatementsStopped) return;
                        const seerCOIds = new Set((seerCOs || []).map(s => s.id));
                        const pokeCandidates = aiPlayers.filter(p => {
                          if (!p.isAlive()) return false;
                          if (moderator && p.id === moderator.id) return false;
                          if (p instanceof UserPlayer) return false;
                          if (p.role === Role.SEER) return false;
                          // In 2-1 formation, also exclude any player who claimed SEER (fake seers)
                          if ((state.formation as any) === '2-1' && seerCOIds.has(p.id)) return false;
                          return true;
                        });
                      if (pokeCandidates.length > 0) {
                        const poke = pokeCandidates[Math.floor(Math.random() * pokeCandidates.length)];
                        const pdlg = (DIALOGUES[poke.name] && (DIALOGUES[poke.name] as any).poke_breakdown) || '〇〇は△△の可能性もありますよ。';
                        // 優先: 当日、対抗(CO:SEER)を占った占い師がいればその占い師名を〇〇に使う
                        let specialSeer: Player | undefined = undefined;
                        try {
                          const dayForCheck = Math.max(1, this.day || 1);
                          for (const s of seerCOs) {
                            const divs: Array<any> = (s as any).divinationResults || [];
                            const rec = divs.find((r: any) => r.day === dayForCheck);
                            if (rec && rec.targetId) {
                              const targetIsSeerCO = state.coPlayers.some(c => c.playerId === rec.targetId && c.claimedRole === Role.SEER);
                              if (targetIsSeerCO) { specialSeer = s; break; }
                            }
                          }
                        } catch (e) { /* ignore */ }

                        let ref = counterRecords.length > 0 ? counterRecords[Math.floor(Math.random() * counterRecords.length)] : undefined;
                        if (!ref) ref = { targetName: seerCOs.length > 0 ? seerCOs[Math.floor(Math.random() * seerCOs.length)].getDisplayName() : '', roleLabel: undefined };
                        const fillA = specialSeer ? specialSeer.getDisplayName() : (ref.targetName || '');
                        let fillB = '';
                        if (ref && ref.roleLabel) {
                          fillB = ref.roleLabel === '人狼' ? '狂人' : '人狼';
                        } else {
                          // Always use a role label for △△ (do not insert a player name).
                          // If we don't have a recorded roleLabel, pick a plausible role (人狼 or 狂人).
                          fillB = Math.random() < 0.5 ? '人狼' : '狂人';
                        }
                        const ptxt = pdlg.replace(/〇〇/g, fillA).replace(/△△/g, fillB);
                        this.statements.push({ day: this.day, playerId: poke.id, playerName: poke.getDisplayName(), content: ptxt });
                        this.emitPlayerStatement(poke, ptxt, this.day);
                        await this.delay(4200);
                      }

                      if (this.aiStatementsStopped) return;
                      if (moderator && !(moderator instanceof UserPlayer)) {
                        const acc = (DIALOGUES[moderator.name] && (DIALOGUES[moderator.name] as any).accept_understood) || 'なるほど、わかりました。';
                        this.statements.push({ day: this.day, playerId: moderator.id, playerName: moderator.getDisplayName(), content: acc });
                        this.emitPlayerStatement(moderator, acc, this.day);
                        await this.delay(3600);
                      }

                      if (this.aiStatementsStopped) return;
                      if (moderator && !(moderator instanceof UserPlayer)) {
                        const counts: Record<number, number> = {};
                        for (const s of this.statements) counts[s.playerId] = (counts[s.playerId] || 0) + 1;
                        const aliveNonMod = this.getAlivePlayers().filter(p => moderator && p.id !== moderator.id && !(p instanceof UserPlayer) && !( (p as any).confirmedWhite ));
                        let minCount = Infinity; let silentPlayer: Player | null = null;
                        for (const p of aliveNonMod) {
                          const c = counts[p.id] || 0;
                          if (c < minCount) { minCount = c; silentPlayer = p; }
                        }
                        if (silentPlayer) {
                          const askSilent = (DIALOGUES[moderator.name] && (DIALOGUES[moderator.name] as any).ask_silent_player) || '〇〇はあまり話していませんが…';
                          const askTxt2 = askSilent.replace(/〇〇/g, silentPlayer.getDisplayName());
                          this.statements.push({ day: this.day, playerId: moderator.id, playerName: moderator.getDisplayName(), content: askTxt2 });
                          this.emitPlayerStatement(moderator, askTxt2, this.day);
                          await this.delay(4200);
                          if (!(silentPlayer instanceof UserPlayer)) {
                            const exKeys = ['excuse1','excuse2','excuse3'];
                            const chosenEx = exKeys[Math.floor(Math.random()*exKeys.length)];
                            const exDlg = (DIALOGUES[silentPlayer.name] && (DIALOGUES[silentPlayer.name] as any)[chosenEx]) || 'すみません、見てました。';
                            const exTxt = exDlg.replace(/〇〇/g, moderator.getDisplayName());
                            this.statements.push({ day: this.day, playerId: silentPlayer.id, playerName: silentPlayer.getDisplayName(), content: exTxt });
                            this.emitPlayerStatement(silentPlayer, exTxt, this.day);
                            await this.delay(4200);
                            if (this.aiStatementsStopped) return;
                            const others = aiPlayers.filter(p => p.isAlive() && p.id !== silentPlayer.id && p.id !== (moderator ? moderator.id : -1));
                            if (others.length > 0) {
                              const other = others[Math.floor(Math.random() * others.length)];
                              const pokeKey = chosenEx === 'excuse1' ? 'poke_excuse1' : (chosenEx === 'excuse2' ? 'poke_excuse2' : 'poke_excuse1');
                              const pokeDlg2 = (DIALOGUES[other.name] && (DIALOGUES[other.name] as any)[pokeKey]) || '〇〇も議論に参加してほしいです。';
                              const pokeTxt2 = pokeDlg2.replace(/〇〇/g, silentPlayer.getDisplayName());
                              this.statements.push({ day: this.day, playerId: other.id, playerName: other.getDisplayName(), content: pokeTxt2 });
                              this.emitPlayerStatement(other, pokeTxt2, this.day);
                                  await this.delay(3600);
                                  // If formation is 2-2, schedule an immediate ask_who_suspect after a short delay
                                  // This ensures that after poke/defend exchanges, the group is asked who they suspect.
                                  try {
                                    // Only schedule immediate ask_who from poke flow when formation is 2-2 AND there is no moderator.
                                    // For 2-1, 3-1 and 2-2-with-moderator we will trigger ask_who after the second accept_understood below.
                                    if ((state as any).formation === '2-2' && !moderator) {
                                      await this.delay(1200);
                                      try { await this.emitAskWho(); } catch (e) { console.log('[DEBUG emitAskWho call error]', e); }
                                    }
                                  } catch (e) { console.log('[DEBUG ask_who scheduled emit error]', e); }
                            }
                          }
                        }
                      }

                      if (this.aiStatementsStopped) return;
                      if (moderator && !(moderator instanceof UserPlayer)) {
                        const acc2 = (DIALOGUES[moderator.name] && (DIALOGUES[moderator.name] as any).accept_understood) || 'なるほど、わかりました。';
                        this.statements.push({ day: this.day, playerId: moderator.id, playerName: moderator.getDisplayName(), content: acc2 });
                        this.emitPlayerStatement(moderator, acc2, this.day);
                        await this.delay(4200);

                        // After the second accept_understood, trigger ask_who sequence for formations where
                        // we want ask_who to occur later: 3-1, 2-1, and 2-2 when a moderator exists.
                        try {
                          if ((state as any).formation === '3-1' || (state as any).formation === '2-1' || ((state as any).formation === '2-2' && moderator)) {
                            await this.delay(1200);
                            try { await this.emitAskWho(); } catch (e) { console.log('[DEBUG emitAskWho call error]', e); }
                          }
                        } catch (e) { /* ignore */ }
                      }

                      if (this.aiStatementsStopped) return;

                      this.suspendAIStatements = true;
                      try {
                        if ((this as any)._vagueDone) {
                          try { console.log('[TRACE vague_order skipped because emitAskWho already ran]'); } catch (e) {}
                        } else {
                          const lastAskWhoId = (this as any)._lastAskWhoSpeakerId as number | undefined;
                          const order = [...aiPlayers].filter(p => p.isAlive() && (!lastAskWhoId || p.id !== lastAskWhoId)).sort(() => Math.random() - 0.5);
                          try { console.log(`[TRACE vague_order] lastAskWhoId=${lastAskWhoId || 'none'} aiPlayers=${aiPlayers.map(p=>p.id).join(',')} order=${order.map(p=>p.id).join(',')}`); } catch (e) {}
                          const suspectPairs: { suspecter: Player; target: Player }[] = [];
                          for (const who of order) {
                            if (this.aiStatementsStopped) return;
                            try { console.log(`[TRACE vague_pre] who=${who.id} moderator=${moderator ? moderator.id : 'none'} confirmedWhites=${state.whitelistIds ? state.whitelistIds.join(',') : ''}`); } catch (e) {}
                            let targets: Player[] = [];
                            if ((state as any).formation === '2-2' && moderator) {
                              const coIds = new Set(((state as any).coPlayers || []).map((c: any) => c.playerId));
                              targets = this.getAlivePlayers().filter(p =>
                                p.id !== who.id &&
                                !(p instanceof UserPlayer) &&
                                p.id !== moderator.id &&
                                !coIds.has(p.id) &&
                                !((p as any).confirmedWhite) &&
                                p.id !== lastAskWhoId
                              );
                            } else {
                              targets = this.getAlivePlayers().filter(p =>
                                p.id !== who.id &&
                                !(p instanceof UserPlayer) &&
                                p.id !== (moderator ? moderator.id : -1) &&
                                p.role !== Role.SEER &&
                                p.role !== Role.MEDIUM &&
                                !((p as any).confirmedWhite) &&
                                p.id !== lastAskWhoId
                              );
                            }
                            try { console.log(`[TRACE vague_targets_before_fallback] who=${who.id} targets=${targets.map(p=>p.id).join(',')} len=${targets.length}`); } catch (e) {}
                            if (targets.length === 0) {
                              targets = this.getAlivePlayers().filter(p => p.id !== who.id && !(p instanceof UserPlayer));
                              try { console.log(`[TRACE vague_targets_after_fallback] who=${who.id} targets=${targets.map(p=>p.id).join(',')} len=${targets.length}`); } catch (e) {}
                            }
                            if (!targets.length) continue;
                            const target = targets[Math.floor(Math.random() * targets.length)];
                            const dlg = (DIALOGUES[who.name] as any)?.vague_suspect ?? 'なんとなく〇〇が怪しい気がする';
                            const txt = dlg.replace(/〇〇/g, target.getDisplayName());
                            this.statements.push({ day: this.day, playerId: who.id, playerName: who.getDisplayName(), content: txt });
                            this.emitPlayerStatement(who, txt, this.day);
                            suspectPairs.push({ suspecter: who, target });
                            await this.delay(2400);
                          }

                          const picked = suspectPairs.sort(() => Math.random() - 0.5).slice(0, 3);
                          for (const pair of picked) {
                            if (this.aiStatementsStopped) return;
                            const { suspecter, target } = pair;
                              // If the original target is the User, pick an alternative non-user to ask
                              let asker: Player | null = target;
                              if (target instanceof UserPlayer) {
                                const alt = this.getAlivePlayers().filter(p => p.isAlive() && !(p instanceof UserPlayer) && p.id !== suspecter.id);
                                if (alt.length > 0) asker = alt[Math.floor(Math.random() * alt.length)];
                                else asker = null;
                              }
                              if (asker && !(asker instanceof UserPlayer)) {
                                const ar = (DIALOGUES[asker.name] as any)?.ask_reason ?? '〇〇さん、なぜ私が怪しいと思ったのですか？';
                                const arTxt = ar.replace(/〇〇/g, suspecter.getDisplayName());
                                this.statements.push({ day: this.day, playerId: asker.id, playerName: asker.getDisplayName(), content: arTxt, key: 'ask_reason' });
                                this.emitPlayerStatement(asker, arTxt, this.day, 'ask_reason');
                                await this.delay(3000);

                                // After ask_reason, pick a random responder (not the User and not the original suspecter)
                                try {
                                  await this.delay(1200);
                                  const possibleResponders = this.getAlivePlayers().filter(p =>
                                    p.isAlive() &&
                                    !(p instanceof UserPlayer) &&
                                    p.id !== suspecter.id &&
                                    p.id !== (asker ? asker.id : -1) &&
                                    p.id !== (moderator ? moderator.id : -1)
                                  );
                                  if (possibleResponders.length > 0) {
                                    const responder = possibleResponders[Math.floor(Math.random() * possibleResponders.length)];
                                    const confTpl = (DIALOGUES[responder.name] as any)?.conformity;
                                    if (confTpl) {
                                      const confTxt = confTpl.replace(/〇〇/g, asker.getDisplayName());
                                      this.statements.push({ day: this.day, playerId: responder.id, playerName: responder.getDisplayName(), content: confTxt });
                                      this.emitPlayerStatement(responder, confTxt, this.day);
                                      await this.delay(2400);
                                      try { await this.runVagueSequence(aiPlayers, (this as any)._askWhoSpeakerId); } catch (e) { console.log('[DEBUG runVagueSequence call error]', e); }
                                    }
                                  }
                                } catch (e) { console.log('[DEBUG conformity emit error]', e); }
                              }
                            const reasonIdx = Math.floor(Math.random() * 3);
                            if (!(suspecter instanceof UserPlayer)) {
                              const vrKey = ['vague_reason1','vague_reason2','vague_reason3'][reasonIdx];
                              const vr = (DIALOGUES[suspecter.name] as any)?.[vrKey] ?? '正直、直感かな…';
                              const vrTxt = vr.replace(/〇〇/g, target.getDisplayName());
                              this.statements.push({ day: this.day, playerId: suspecter.id, playerName: suspecter.getDisplayName(), content: vrTxt });
                              this.emitPlayerStatement(suspecter, vrTxt, this.day);
                              await this.delay(3000);
                            }
                            if (!(target instanceof UserPlayer)) {
                              const rbKey = ['rebut_vague1','rebut_vague2','rebut_vague3'][reasonIdx];
                              const rb = (DIALOGUES[target.name] as any)?.[rbKey] ?? 'その理由は納得できないな。';
                              const rbTxt = rb.replace(/〇〇/g, suspecter.getDisplayName());
                              this.statements.push({ day: this.day, playerId: target.id, playerName: target.getDisplayName(), content: rbTxt });
                              this.emitPlayerStatement(target, rbTxt, this.day);
                              await this.delay(2400);
                            }
                          }

                          // Fallback: if no ask_reason was emitted in the picked set,
                          // ensure at least one ask_reason is emitted when there is at least
                          // one suspectPair collected.
                          try {
                            const anyAskReasonEmitted = suspectPairs.some(pair => {
                              // We consider an ask_reason "emittable" if the target is not the User,
                              // or if we can find an alternative non-user asker.
                              const { suspecter, target } = pair;
                              if (!(target instanceof UserPlayer)) return true;
                              const alt = this.getAlivePlayers().filter(p => p.isAlive() && !(p instanceof UserPlayer) && p.id !== suspecter.id);
                              return alt.length > 0;
                            });
                            if (!anyAskReasonEmitted && suspectPairs.length > 0) {
                              // pick the first pair that can produce an asker
                              let fallbackPair: { suspecter: Player; target: Player } | null = null;
                              for (const pair of suspectPairs) {
                                const { suspecter, target } = pair;
                                if (!(target instanceof UserPlayer)) { fallbackPair = pair; break; }
                                const alt = this.getAlivePlayers().filter(p => p.isAlive() && !(p instanceof UserPlayer) && p.id !== suspecter.id);
                                if (alt.length > 0) { fallbackPair = { suspecter, target: alt[Math.floor(Math.random() * alt.length)] }; break; }
                              }
                              if (fallbackPair) {
                                const { suspecter, target } = fallbackPair as any;
                                const asker = target instanceof UserPlayer ? null : target;
                                if (asker && !(asker instanceof UserPlayer)) {
                                  const ar = (DIALOGUES[asker.name] as any)?.ask_reason ?? '〇〇さん、なぜ私が怪しいと思ったのですか？';
                                  const arTxt = ar.replace(/〇〇/g, suspecter.getDisplayName());
                                  this.statements.push({ day: this.day, playerId: asker.id, playerName: asker.getDisplayName(), content: arTxt, key: 'ask_reason' });
                                  this.emitPlayerStatement(asker, arTxt, this.day, 'ask_reason');
                                  await this.delay(3000);
                                }
                              }
                            }
                          } catch (e) { /* ignore fallback errors */ }

                        }
                      } catch (e) {
                        console.log('[DEBUG vague_order error]', e);
                      }
                      this.suspendAIStatements = false;
                    }
                  }
                }
            }
          }
        }
      }

      // --- 追加: rebut_vague3 のやり取りが一通り出た後の追加入力 ---
      // 3-1 陣形の場合、進行役が投票先を指定し、その対象が反応→遺言→回答→謝罪の流れを実行
      try {
        await this.delay(2400);
        // 追加: 2-2 の場合、rebut_vague が一通り終わった後に誰かが指名発言する
        if (state.formation === '2-2') {
          // 指名発言者は確認白がいれば優先、いなければランダムな非ユーザーAI
          let moderator: Player | undefined = this.getAlivePlayers().find(p => (p as any).confirmedWhite && !(p instanceof UserPlayer));
          if (!moderator) moderator = this.getAlivePlayers().find(p => p.isAlive() && !(p instanceof UserPlayer));
          if (moderator && (moderator as any).isAlive && (moderator as any).isAlive()) {
            // 優先: CO申告の中から占い/霊能（偽含む）を選ぶ
            let candidates = state.coPlayers
              .filter(c => c.claimedRole === Role.SEER || c.claimedRole === Role.MEDIUM)
              .map(c => this.getPlayerById(c.playerId))
              .filter((p): p is Player => !!p && p.isAlive());
            if (candidates.length === 0) {
              // フォールバック: 実際の役職が占い/霊能の生存者
              candidates = this.getAlivePlayers().filter(p => p.role === Role.SEER || p.role === Role.MEDIUM);
            }
            if (candidates.length > 0) {
              // 2-2 かつ進行役の実役に応じた指定ルール:
              // - 進行役が真霊能者 (Role.MEDIUM) の場合: 偽霊能者 (coPlayers の isFake===true で claimedRole===MEDIUM) を優先して指定
              // - 進行役が狂人 (Role.MADMAN) の場合: 真霊能者 (actual role === Role.MEDIUM) を優先して指定
              const pick = candidates[Math.floor(Math.random() * candidates.length)];
              const designateTpl = (DIALOGUES[moderator.name] as any)?.designate_vote_target || 'では投票時間が迫ってきたので、今日は〇〇吊りにします。ごめんなさい。';
              const designateTxt = designateTpl.replace(/〇〇/g, pick.getDisplayName());
              this.statements.push({ day: this.day, playerId: moderator.id, playerName: moderator.getDisplayName(), content: designateTxt });
              this.emitPlayerStatement(moderator, designateTxt, this.day);
              try { state.designateTargetId = pick.id; state.designateDay = this.day; } catch (e) {}
                await this.delay(2400);
                // designate された対象が反応（reaction_to_being_target1/2 のどちらかを発言）
                try {
                  if (pick.isAlive()) {
                    await this.delay(600);
                    if (!(pick instanceof UserPlayer)) {
                      const reactKeys = ['reaction_to_being_target1','reaction_to_being_target2'];
                      const rk = reactKeys[Math.floor(Math.random() * reactKeys.length)];
                      const reactTpl = (DIALOGUES[pick.name] as any)?.[rk] || (rk === 'reaction_to_being_target1' ? 'えー、正直悲しいです。' : 'うーん、わかりました。');
                      const reactTxt = reactTpl.replace(/〇〇/g, moderator.getDisplayName());
                      this.statements.push({ day: this.day, playerId: pick.id, playerName: pick.getDisplayName(), content: reactTxt });
                      this.emitPlayerStatement(pick, reactTxt, this.day);
                      await this.delay(1800);
                    }
                  }
                } catch (e) { console.log('[DEBUG designate reaction error]', e); }
                // 進行役が ask_last_words を発言
                try {
                  const askLast = (DIALOGUES[moderator.name] as any)?.ask_last_words || '最後に遺言は何かありますか？';
                  this.statements.push({ day: this.day, playerId: moderator.id, playerName: moderator.getDisplayName(), content: askLast });
                  this.emitPlayerStatement(moderator, askLast, this.day);
                  await this.delay(2400);
                } catch (e) { console.log('[DEBUG ask_last_words error]', e); }
                // 指名された対象が生存していれば、遅延後に遺言（占い/霊能それぞれのテンプレ）を発言させる
                try {
                  if (pick.isAlive()) {
                    await this.delay(600);
                    const isSeerClaim = (state.coPlayers || []).some((c: any) => c.playerId === pick.id && c.claimedRole === Role.SEER);
                    const isMediumClaim = (state.coPlayers || []).some((c: any) => c.playerId === pick.id && c.claimedRole === Role.MEDIUM);
                    if (pick.role === Role.SEER || isSeerClaim) {
                      const lastWord = (DIALOGUES[pick.name] as any)?.last_word_seer_day1 || '私が真占い師なので必ずローラー完遂でお願いします！あとは村の皆さん頑張ってください！';
                      const lwTxt = lastWord.replace(/〇〇/g, moderator.getDisplayName());
                      this.statements.push({ day: this.day, playerId: pick.id, playerName: pick.getDisplayName(), content: lwTxt });
                      this.emitPlayerStatement(pick, lwTxt, this.day);
                      await this.delay(2400);
                    } else if (pick.role === Role.MEDIUM || isMediumClaim) {
                      const lastWord = (DIALOGUES[pick.name] as any)?.last_word_medium_day1 || '私が真霊能なので必ずローラー完遂でお願いします！あとは村の皆さん頑張ってください！';
                      const lwTxt = lastWord.replace(/〇〇/g, moderator.getDisplayName());
                      this.statements.push({ day: this.day, playerId: pick.id, playerName: pick.getDisplayName(), content: lwTxt });
                      this.emitPlayerStatement(pick, lwTxt, this.day);
                      await this.delay(2400);
                    }
                  }
                } catch (e) { console.log('[DEBUG designate last_word error]', e); }
                // 進行役が遺言に応答する（respond_to_last_word） — 2-2 用追加
                try {
                  if (moderator && (moderator as any).isAlive && (moderator as any).isAlive()) {
                    const respTpl = (DIALOGUES[moderator.name] as any)?.respond_to_last_word || 'わかりました。';
                    const respTxt = respTpl.replace(/〇〇/g, pick.getDisplayName());
                    this.statements.push({ day: this.day, playerId: moderator.id, playerName: moderator.getDisplayName(), content: respTxt });
                    this.emitPlayerStatement(moderator, respTxt, this.day);
                    await this.delay(2400);
                  }
                } catch (e) { console.log('[DEBUG moderator respond_to_last_word error]', e); }
                // 進行応答後に、ユーザー・進行役・指名対象以外のランダムな誰か最大3人が順に `apologize` を言う
                try {
                  const userPlayer = this.players.find(p => p instanceof UserPlayer) as UserPlayer | undefined;
                  const excluded = new Set<number>();
                  if (userPlayer) excluded.add(userPlayer.id);
                  if (moderator) excluded.add(moderator.id);
                  if (pick) excluded.add(pick.id);

                  let apologyCandidates = this.getAlivePlayers().filter(p => !excluded.has(p.id) && !(p instanceof UserPlayer));
                  // シャッフル
                  apologyCandidates = [...apologyCandidates].sort(() => Math.random() - 0.5);
                  const apologyCount = Math.min(3, apologyCandidates.length);
                  for (let i = 0; i < apologyCount; i++) {
                    const ap = apologyCandidates[i];
                    const tpl = (DIALOGUES[ap.name] as any)?.apologize || 'ごめんなさい';
                    const txt = tpl.replace(/〇〇/g, pick.getDisplayName());
                    this.statements.push({ day: this.day, playerId: ap.id, playerName: ap.getDisplayName(), content: txt });
                    this.emitPlayerStatement(ap, txt, this.day);
                    await this.delay(1800);
                  }
                } catch (e) { console.log('[DEBUG post-respond apologies error]', e); }
            }
          }
        } else if ((state as any).formation === '2-2') {
          // 2-2 の場合、rebut_vague 後にランダムな非ユーザーが confused_about_target を発言
          try {
            await this.delay(2400);
            let candidates = this.getAlivePlayers().filter(p => !(p instanceof UserPlayer));
            // 除外: もし state.coPlayers やその他で最後の発言者を除外したいなら追加可能
            candidates = candidates.filter(p => p.isAlive());
            if (candidates.length > 0) {
              const speaker = candidates[Math.floor(Math.random() * candidates.length)];
              const tpl = (DIALOGUES[speaker.name] as any)?.confused_about_target || 'ところで吊り先はどうしましょうか？';
              const txt = tpl.replace(/〇〇/g, '');
              this.statements.push({ day: this.day, playerId: speaker.id, playerName: speaker.getDisplayName(), content: txt });
              this.emitPlayerStatement(speaker, txt, this.day);
              await this.delay(1800);
              
                // confused 発言のあと、遅延してユーザーと発言者を除くランダムな誰かが propose_each_vote を言う
                try {
                  await this.delay(1200);
                  const userPlayer = this.players.find(p => p instanceof UserPlayer) as UserPlayer | undefined;
                  const excluded = new Set<number>();
                  if (userPlayer) excluded.add(userPlayer.id);
                  excluded.add(speaker.id);

                  let proposerCandidates = this.getAlivePlayers().filter(p => !excluded.has(p.id) && !(p instanceof UserPlayer));
                  proposerCandidates = [...proposerCandidates].sort(() => Math.random() - 0.5);
                  if (proposerCandidates.length > 0) {
                    const proposer = proposerCandidates[0];
                    const propTpl = (DIALOGUES[proposer.name] as any)?.propose_each_vote || '各自が占い師、霊能者の中で怪しい人を投票することにしますか？';
                    const propTxt = propTpl.replace(/〇〇/g, '');
                    this.statements.push({ day: this.day, playerId: proposer.id, playerName: proposer.getDisplayName(), content: propTxt });
                    this.emitPlayerStatement(proposer, propTxt, this.day);
                    await this.delay(1800);
                    
                    // propose_each_vote の後、遅延してユーザーと proposer を除くランダムな誰か最大3人が agree を発言
                    try {
                      await this.delay(1200);
                      const excludedAgree = new Set<number>();
                      if (userPlayer) excludedAgree.add(userPlayer.id);
                      excludedAgree.add(proposer.id);

                      let agreeCandidates = this.getAlivePlayers().filter(p => !excludedAgree.has(p.id) && !(p instanceof UserPlayer));
                      agreeCandidates = [...agreeCandidates].sort(() => Math.random() - 0.5);
                      const agreeCount = Math.min(3, agreeCandidates.length);
                      for (let ai = 0; ai < agreeCount; ai++) {
                        const ag = agreeCandidates[ai];
                        const agreeTpl = (DIALOGUES[ag.name] as any)?.agree || 'そうですね。';
                        const agreeTxt = agreeTpl.replace(/〇〇/g, '');
                        this.statements.push({ day: this.day, playerId: ag.id, playerName: ag.getDisplayName(), content: agreeTxt });
                        this.emitPlayerStatement(ag, agreeTxt, this.day);
                        await this.delay(1200);
                      }
                      // agree が一通り出た後、遅延してユーザー以外のランダムな誰かが decide_each_vote を発言
                      try {
                        await this.delay(1200);
                        const userPlayer = this.players.find(p => p instanceof UserPlayer) as UserPlayer | undefined;
                        const excludedDecide = new Set<number>();
                        if (userPlayer) excludedDecide.add(userPlayer.id);
                        excludedDecide.add(proposer.id);

                        let decideCandidates = this.getAlivePlayers().filter(p => !excludedDecide.has(p.id) && !(p instanceof UserPlayer));
                        decideCandidates = [...decideCandidates].sort(() => Math.random() - 0.5);
                        if (decideCandidates.length > 0) {
                          const decider = decideCandidates[0];
                          const decideTpl = (DIALOGUES[decider.name] as any)?.decide_each_vote || 'では各自で占い師、霊能者の中で怪しい人を各自投票しましょう！';
                          const decideTxt = decideTpl.replace(/〇〇/g, '');
                          this.statements.push({ day: this.day, playerId: decider.id, playerName: decider.getDisplayName(), content: decideTxt });
                          this.emitPlayerStatement(decider, decideTxt, this.day);
                          await this.delay(1200);
                        }
                      } catch (e) { console.log('[DEBUG decide_each_vote after agree error]', e); }
                    } catch (e) { console.log('[DEBUG agree after propose error]', e); }
                  }
                } catch (e) { console.log('[DEBUG propose after confused error]', e); }
            }
          } catch (e) { console.log('[DEBUG 2-2 no-moderator confused error]', e); }
        }
        if (state.formation === '3-1') {
          // 3-1 の場合、進行役がいないため、確認白を優先して話者を決める（なければランダムな非ユーザー）
          let moderator: Player | undefined = this.getAlivePlayers().find(p => (p as any).confirmedWhite && p.isAlive() && !(p instanceof UserPlayer));
          if (!moderator) moderator = this.getAlivePlayers().find(p => p.isAlive() && !(p instanceof UserPlayer));
          if (moderator && (moderator as any).isAlive && (moderator as any).isAlive()) {
            // ランダムな占い師を選択（CO申告者優先）
            let seerCandidates = state.coPlayers.filter(c => c.claimedRole === Role.SEER).map(c => this.getPlayerById(c.playerId)).filter((p): p is Player => !!p && p.isAlive() && !((p as any).confirmedWhite));
            if (seerCandidates.length === 0) {
              seerCandidates = this.getAlivePlayers().filter(p => p.role === Role.SEER && p.isAlive());
            }
            if (seerCandidates.length > 0) {
              const namedSeer = seerCandidates[Math.floor(Math.random() * seerCandidates.length)];
              // 進行役が designate_vote_target を発言（〇〇 を置換）
              const designateTpl = (DIALOGUES[moderator.name] as any)?.designate_vote_target || 'では投票時間が迫ってきたので、今日は〇〇吊りにします。ごめんなさい。';
              const designateTxt = designateTpl.replace(/〇〇/g, namedSeer.getDisplayName());
              this.statements.push({ day: this.day, playerId: moderator.id, playerName: moderator.getDisplayName(), content: designateTxt });
              this.emitPlayerStatement(moderator, designateTxt, this.day);
              // 設定: この日の投票指定を記録
              try { state.designateTargetId = namedSeer.id; state.designateDay = this.day; } catch (e) {}
              await this.delay(2400);

              // 指名された人が reaction_to_being_target1 or 2 をランダム発言
              if (namedSeer.isAlive()) {
                const reactKeys = ['reaction_to_being_target1', 'reaction_to_being_target2'];
                const rk = reactKeys[Math.floor(Math.random() * reactKeys.length)];
                const reactTpl = (DIALOGUES[namedSeer.name] as any)?.[rk] || (rk === 'reaction_to_being_target1' ? 'えー、正直悲しいです。' : 'うーん、わかりました。');
                const reactTxt = reactTpl.replace(/〇〇/g, moderator.getDisplayName());
                this.statements.push({ day: this.day, playerId: namedSeer.id, playerName: namedSeer.getDisplayName(), content: reactTxt });
                this.emitPlayerStatement(namedSeer, reactTxt, this.day);
                await this.delay(2400);
              }

              // 進行役が ask_last_words を発言
              const askLast = (DIALOGUES[moderator.name] as any)?.ask_last_words || '最後に遺言は何かありますか？';
              this.statements.push({ day: this.day, playerId: moderator.id, playerName: moderator.getDisplayName(), content: askLast });
              this.emitPlayerStatement(moderator, askLast, this.day);
              await this.delay(2400);

              // 指名された人が last_word_seer_day1 を発言（占い師の遺言）
              if (namedSeer.isAlive()) {
                const lastWord = (DIALOGUES[namedSeer.name] as any)?.last_word_seer_day1 || '私が真占い師なので必ずローラー完遂でお願いします！あとは村の皆さん頑張ってください！';
                const lwTxt = lastWord.replace(/〇〇/g, moderator.getDisplayName());
                this.statements.push({ day: this.day, playerId: namedSeer.id, playerName: namedSeer.getDisplayName(), content: lwTxt });
                this.emitPlayerStatement(namedSeer, lwTxt, this.day);
                await this.delay(2400);
              }

              // 進行役が respond_to_last_word を発言
              const resp = (DIALOGUES[moderator.name] as any)?.respond_to_last_word || 'わかりました。';
              this.statements.push({ day: this.day, playerId: moderator.id, playerName: moderator.getDisplayName(), content: resp });
              this.emitPlayerStatement(moderator, resp, this.day);
              await this.delay(2400);

              // 最後に apologize を発言するプレイヤーを選定（除外: ユーザー、進行役、占い師、last_word_seer_day1 の発言者）
              const userPlayer = this.players.find(p => p instanceof UserPlayer) as UserPlayer | undefined;
              const apologies: Player[] = [];
              const excluded = new Set<number>();
              if (userPlayer) excluded.add(userPlayer.id);
              excluded.add(moderator.id);
              if (namedSeer) excluded.add(namedSeer.id);

              // 候補: 生存しているプレイヤーのうち、ユーザー/進行役/占い師/last_word発言者 を除外
              let candidates = this.getAlivePlayers().filter(p => !excluded.has(p.id) && p.role !== Role.SEER && !(p instanceof UserPlayer));
              // シャッフルして最大3名選出
              candidates = [...candidates].sort(() => Math.random() - 0.5);
              const pickCount = Math.min(3, candidates.length);
              for (let i = 0; i < pickCount; i++) apologies.push(candidates[i]);

              for (const ap of apologies) {
                if (this.aiStatementsStopped) break;
                const apTxt = (DIALOGUES[ap.name] as any)?.apologize || 'ごめんなさい';
                this.statements.push({ day: this.day, playerId: ap.id, playerName: ap.getDisplayName(), content: apTxt });
                this.emitPlayerStatement(ap, apTxt, this.day);
                await this.delay(1800);
              }
            }
          }
        }
      } catch (e) {
        // 失敗してもフロー継続
        console.error('Post-rebut sequence error:', e);
      }

      // --- 追加: vague_reason が一通り出た後の 2-1 陣形フロー ---
      try {
        await this.delay(2400);
        if (state.formation === '2-1') {
          // 2-1 の場合、進行役は選ばないので、確認白優先で話者を決める（なければランダム非ユーザー）
          let moderator: Player | undefined = this.getAlivePlayers().find(p => (p as any).confirmedWhite && p.isAlive() && !(p instanceof UserPlayer));
          if (!moderator) moderator = this.getAlivePlayers().find(p => p.isAlive() && !(p instanceof UserPlayer));
          if (moderator && (moderator as any).isAlive && (moderator as any).isAlive()) {
            // nominate: ユーザー、進行役、占い師、霊能、そして偽占い師（占いCOをしている狂人/人狼）以外の誰か
            const fakeSeerIds = (state.coPlayers || []).filter(c => c.claimedRole === Role.SEER && c.isFake).map(c => c.playerId);
            let nominateCandidates = this.getAlivePlayers().filter(p =>
              p.id !== moderator.id &&
              !(p instanceof UserPlayer) &&
              p.role !== Role.SEER &&
              p.role !== Role.MEDIUM &&
              !((p as any).confirmedWhite) &&
              !fakeSeerIds.includes(p.id)
            );
            if (nominateCandidates.length === 0) {
              nominateCandidates = this.getAlivePlayers().filter(p => p.id !== moderator.id && !(p instanceof UserPlayer));
            }
            if (nominateCandidates.length > 0) {
              const nominate = nominateCandidates[Math.floor(Math.random() * nominateCandidates.length)];
              // 進行役が formation_2_1_co_confirm を発言（〇〇 を置換）
              const tpl = (DIALOGUES[moderator.name] as any)?.formation_2_1_co_confirm || '気が重いですが仮指定します。今日は〇〇吊りにしようと思いますが、何かCOありますか？';
              const txt = tpl.replace(/〇〇/g, nominate.getDisplayName());
              this.statements.push({ day: this.day, playerId: moderator.id, playerName: moderator.getDisplayName(), content: txt });
              this.emitPlayerStatement(moderator, txt, this.day);
              await this.delay(2400);

              // nominate が村人かどうか判定
              const isVillager = nominate.role === Role.VILLAGER;
              let protectorSpeaker: Player | null = null;

              if (isVillager) {
                const vtpl = (DIALOGUES[nominate.name] as any)?.vote_target_response_villager || 'COはないです！';
                const vtxt = vtpl.replace(/〇〇/g, nominate.getDisplayName());
                this.statements.push({ day: this.day, playerId: nominate.id, playerName: nominate.getDisplayName(), content: vtxt });
                this.emitPlayerStatement(nominate, vtxt, this.day);
                protectorSpeaker = null;
              } else {
                const ptpl = (DIALOGUES[nominate.name] as any)?.vote_target_response_protectors || 'COあります！狩人です！なので、吊り先は私以外でお願いします m(_ _)m';
                const ptxt = ptpl.replace(/〇〇/g, nominate.getDisplayName());
                this.statements.push({ day: this.day, playerId: nominate.id, playerName: nominate.getDisplayName(), content: ptxt });
                this.emitPlayerStatement(nominate, ptxt, this.day);
                // 発言テキストからもCO履歴に反映（襲撃優先の参照元）
                try { this.detectAndBroadcastCO(ptxt, nominate); } catch (e) {}
                // 発言が狩人COを示唆するため、player_co イベントを発行してクライアントの表示を更新
                try { this.eventEmitter.emit('player_co', { playerId: nominate.id, playerName: nominate.getDisplayName(), claimedRole: Role.KNIGHT }); } catch (e) {}
                protectorSpeaker = nominate;
              }

              await this.delay(2400);

              // nominate が村人でない場合、進行役が change_vote_target を発言
              if (!isVillager) {
                const chTpl = (DIALOGUES[moderator.name] as any)?.change_vote_target || 'わかりました、では吊り先変えますね。';
                this.statements.push({ day: this.day, playerId: moderator.id, playerName: moderator.getDisplayName(), content: chTpl });
                this.emitPlayerStatement(moderator, chTpl, this.day);
                await this.delay(2400);

                // protectorSpeaker が存在してかつ役職が狩人でない場合、狩人が knight_co を発言、そのあと protectorSpeaker が resist_knight_co を発言
                if (protectorSpeaker && protectorSpeaker.role !== Role.KNIGHT) {
                  const knight = this.getAlivePlayers().find(p => p.role === Role.KNIGHT && p.isAlive());
                  if (knight) {
                    const ktpl = (DIALOGUES[knight.name] as any)?.knight_co || 'ちょっと待ってください！私が狩人なのでそのまま〇〇を吊ってください！';
                    const ktxt = ktpl.replace(/〇〇/g, nominate.getDisplayName());
                    this.statements.push({ day: this.day, playerId: knight.id, playerName: knight.getDisplayName(), content: ktxt });
                    this.emitPlayerStatement(knight, ktxt, this.day);
                    // 発言テキストからもCO履歴に反映（襲撃優先の参照元）
                    try { this.detectAndBroadcastCO(ktxt, knight); } catch (e) {}
                    // 狩人CO 発言なので player_co イベントを発行してクライアント表示を更新
                    try { this.eventEmitter.emit('player_co', { playerId: knight.id, playerName: knight.getDisplayName(), claimedRole: Role.KNIGHT }); } catch (e) {}
                    await this.delay(2400);

                    const resistTpl = (DIALOGUES[protectorSpeaker.name] as any)?.resist_knight_co || 'いやいや、私が本物の狩人ですよ！';
                    const resistTxt = resistTpl.replace(/〇〇/g, knight.getDisplayName());
                    this.statements.push({ day: this.day, playerId: protectorSpeaker.id, playerName: protectorSpeaker.getDisplayName(), content: resistTxt });
                    this.emitPlayerStatement(protectorSpeaker, resistTxt, this.day);
                    // 対抗COもCO履歴に反映して整合性を取る
                    try { this.detectAndBroadcastCO(resistTxt, protectorSpeaker); } catch (e) {}
                    await this.delay(2400);
                  }
                }
              }

              // 進行役が designate_vote_target を発言
              // ルールに従い 〇〇 を決定する
              let designateTarget: Player | null = null;
              if (isVillager) {
                designateTarget = nominate; // vote_target_response_villager の発言者
              } else if (protectorSpeaker && protectorSpeaker.role === Role.KNIGHT) {
                // choose someone not user, moderator, seer, medium, knight
                const excludeIds = new Set<number>();
                const userPlayer = this.players.find(p => p instanceof UserPlayer) as UserPlayer | undefined;
                if (userPlayer) excludeIds.add(userPlayer.id);
                excludeIds.add(moderator.id);
                const seers = this.getAlivePlayers().filter(p => p.role === Role.SEER).map(p => p.id);
                seers.forEach(id => excludeIds.add(id));
                const mediums = this.getAlivePlayers().filter(p => p.role === Role.MEDIUM).map(p => p.id);
                mediums.forEach(id => excludeIds.add(id));
                // also exclude knights
                const knights = this.getAlivePlayers().filter(p => p.role === Role.KNIGHT).map(p => p.id);
                knights.forEach(id => excludeIds.add(id));
                // Exclude players who are explicitly confirmed white or have been divined white by any seer
                const isDivinedWhite = (candidateId: number) => {
                  return this.players.some(pl => {
                    const divs: Array<any> = (pl as any).divinationResults || [];
                    if (divs.some((r: any) => r && r.targetId === candidateId && r.result === DivinationResult.HUMAN)) return true;
                    const fdivs: Array<any> = (pl as any).fakeDivinationResults || [];
                    if (fdivs.some((r: any) => r && r.targetId === candidateId && r.result === DivinationResult.HUMAN)) return true;
                    return false;
                  });
                };

                let picks = this.getAlivePlayers().filter(p => {
                  if (excludeIds.has(p.id)) return false;
                  if ((p as any).confirmedWhite) return false;
                  if (isDivinedWhite(p.id)) return false;
                  return true;
                });
                if (picks.length === 0) picks = this.getAlivePlayers().filter(p => p.id !== moderator.id && !( (p as any).confirmedWhite ) && !isDivinedWhite(p.id));
                if (picks.length > 0) designateTarget = picks[Math.floor(Math.random() * picks.length)];
              } else if (protectorSpeaker && (protectorSpeaker.role === Role.MADMAN || protectorSpeaker.role === Role.WEREWOLF)) {
                designateTarget = protectorSpeaker; // designate to the protector speaker
              }

              // Fallback: if still null, pick a random alive non-moderator
              if (!designateTarget) {
                const picks = this.getAlivePlayers().filter(p => p.id !== moderator.id);
                if (picks.length > 0) designateTarget = picks[Math.floor(Math.random() * picks.length)];
              }

              if (designateTarget) {
                const dTpl = (DIALOGUES[moderator.name] as any)?.designate_vote_target || 'では投票時間が迫ってきたので、今日は〇〇吊りにします。ごめんなさい人(_ _*)';
                const dTxt = dTpl.replace(/〇〇/g, designateTarget.getDisplayName());
                this.statements.push({ day: this.day, playerId: moderator.id, playerName: moderator.getDisplayName(), content: dTxt });
                this.emitPlayerStatement(moderator, dTxt, this.day);
                // 設定: この日の投票指定を記録
                try { state.designateTargetId = designateTarget.id; state.designateDay = this.day; } catch (e) {}
                await this.delay(2400);

                // designateTarget reacts
                if (designateTarget.isAlive()) {
                  const reactKeys = ['reaction_to_being_target1', 'reaction_to_being_target2'];
                  const rk = reactKeys[Math.floor(Math.random() * reactKeys.length)];
                  const rTpl = (DIALOGUES[designateTarget.name] as any)?.[rk] || (rk === 'reaction_to_being_target1' ? 'えー、正直悲しいです。' : 'うーん、わかりました。');
                  const rTxt = rTpl.replace(/〇〇/g, moderator.getDisplayName());
                  this.statements.push({ day: this.day, playerId: designateTarget.id, playerName: designateTarget.getDisplayName(), content: rTxt });
                  this.emitPlayerStatement(designateTarget, rTxt, this.day);
                  await this.delay(2400);
                }

                // 進行役が ask_last_words を発言
                const askLast = (DIALOGUES[moderator.name] as any)?.ask_last_words || '最後に遺言は何かありますか？';
                this.statements.push({ day: this.day, playerId: moderator.id, playerName: moderator.getDisplayName(), content: askLast });
                this.emitPlayerStatement(moderator, askLast, this.day);
                await this.delay(2400);

                // 遺言の発言者決定
                // If resist_knight_co speaker exists and is the same as designateTarget, they say last_word_fake_knight_day1
                let resistSpeaker: Player | null = null;
                // fallback: if protectorSpeaker had spoken resist, set resistSpeaker
                if (protectorSpeaker) {
                  // check if protectorSpeaker recently said resist_knight_co by content match
                  const lastByProtector = this.statements.slice(-10).reverse().find(s => s.playerId === protectorSpeaker!.id && ((DIALOGUES[protectorSpeaker!.name] as any)?.resist_knight_co && s.content === ((DIALOGUES[protectorSpeaker!.name] as any).resist_knight_co.replace(/〇〇/g, (this.getAlivePlayers().find(p=>p.role===Role.KNIGHT)?.getDisplayName()||'')))));
                  if (lastByProtector) resistSpeaker = protectorSpeaker;
                }

                if (resistSpeaker && resistSpeaker.id === designateTarget.id) {
                  const lw = (DIALOGUES[resistSpeaker.name] as any)?.last_word_fake_knight_day1 || '私が本物の狩人なので、必ず〇〇を吊るようにお願いします！';
                  const lwTxt = lw.replace(/〇〇/g, moderator.getDisplayName());
                  this.statements.push({ day: this.day, playerId: resistSpeaker.id, playerName: resistSpeaker.getDisplayName(), content: lwTxt });
                  this.emitPlayerStatement(resistSpeaker, lwTxt, this.day);
                  await this.delay(2400);
                } else {
                  const lw = (DIALOGUES[designateTarget.name] as any)?.last_word_villager_day1 || 'あまり考察落とせなくてすみません…あとは村の皆さん頑張ってください！';
                  const lwTxt = lw.replace(/〇〇/g, moderator.getDisplayName());
                  this.statements.push({ day: this.day, playerId: designateTarget.id, playerName: designateTarget.getDisplayName(), content: lwTxt });
                  this.emitPlayerStatement(designateTarget, lwTxt, this.day);
                  await this.delay(2400);
                }

                // 進行役が respond_to_last_word を発言
                const resp = (DIALOGUES[moderator.name] as any)?.respond_to_last_word || 'わかりました、〇〇ごめんなさいね…';
                this.statements.push({ day: this.day, playerId: moderator.id, playerName: moderator.getDisplayName(), content: resp.replace(/〇〇/g, designateTarget.getDisplayName()) });
                this.emitPlayerStatement(moderator, resp.replace(/〇〇/g, designateTarget.getDisplayName()), this.day);
                await this.delay(2400);

                // 最後に ユーザー、進行役、designateTarget の人以外のランダムな誰か3人が apologize
                const userPlayer = this.players.find(p => p instanceof UserPlayer) as UserPlayer | undefined;
                const excludeIds = new Set<number>();
                if (userPlayer) excludeIds.add(userPlayer.id);
                excludeIds.add(moderator.id);
                excludeIds.add(designateTarget.id);
                let apCandidates = this.getAlivePlayers().filter(p => !excludeIds.has(p.id) && !(p instanceof UserPlayer));
                apCandidates = [...apCandidates].sort(() => Math.random() - 0.5);
                const apCount = Math.min(3, apCandidates.length);
                for (let i = 0; i < apCount; i++) {
                  const ap = apCandidates[i];
                  const apTxt = (DIALOGUES[ap.name] as any)?.apologize || 'ごめんなさい';
                  this.statements.push({ day: this.day, playerId: ap.id, playerName: ap.getDisplayName(), content: apTxt });
                  this.emitPlayerStatement(ap, apTxt, this.day);
                  await this.delay(1800);
                }
              }
            }
          }
        }
      } catch (e) {
        console.error('Post-vague_reason 2-1 sequence error:', e);
      }

      state.stage = 'debate_start';
    }

    // 5. 吊り議論開始
    if (state.stage === 'debate_start') {
      // debate_start proceeds without the default direct debate prompt
      await this.delay(1500);
      if (this.aiStatementsStopped) return;
      state.stage = 'vote_candidates';
    }

    // 6. 吊り候補配布
    if (state.stage === 'vote_candidates') {
      let voteCandidates: number[] = [];
      const coedPlayerIds = new Set(state.coPlayers.map(c => c.playerId));
      const white = new Set(state.whitelistIds);
      if (state.formation === '2-1') {
        voteCandidates = alivePlayers
          .filter(p => !coedPlayerIds.has(p.id) && !white.has(p.id) && p.id !== 1)
          .map(p => p.id);
      } else if (state.formation === '2-2') {
        voteCandidates = Array.from(coedPlayerIds).filter(id => id !== 1);
      } else {
        const seerCoIds = state.coPlayers.filter(c => c.claimedRole === Role.SEER).map(c => c.playerId);
        voteCandidates = seerCoIds.filter(id => id !== 1);
      }
      this.players.forEach(p => { p.setDay1VoteCandidates(voteCandidates.length > 0 ? voteCandidates : null); });
      state.stage = 'done';
    }
  }

  /**
   * ディレイ
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * ゲーム状態を取得
   */
  public getGameState() {
    return {
      day: this.day,
      phase: this.phase,
      players: this.players.map(p => ({
        id: p.id,
        name: p.getDisplayName(),
        icon: p.icon,
        role: p.role,
        team: p.team,
        status: p.status,
        trust: (p as any).trust !== undefined ? (p as any).trust : null,
      })),
      statements: this.statements,
      voteHistory: this.voteHistory,
      day1State: this.day1State ? { formation: this.day1State.formation } : null,
    };
  }

  /**
   * Safe wrapper for emitAskWho. Some flows assign an instance method
   * `(this as any).emitAskWho = async () => { ... }` dynamically. Calls
   * in other places use `(this as any).emitAskWho()`; if the instance
   * property is not present we provide a safe fallback to avoid
   * "is not a function" TypeError and optionally emit a minimal ask
   * prompt so the game flow continues.
   */
  private async emitAskWho(): Promise<void> {
    try {
      // If an instance-specific emitter was assigned, call it.
      if (Object.prototype.hasOwnProperty.call(this, 'emitAskWho')) {
        const fn = (this as any).emitAskWho;
        if (typeof fn === 'function') {
          // call the assigned function (bound to this)
          await fn.call(this);
          return;
        }
      }
    } catch (e) {
      console.log('[DEBUG emitAskWho wrapper inner call error]', e);
    }

    // Fallback: emit a simple GM-style ask or pick an AI speaker.
    try {
      // No longer prefer a moderator; pick a confirmed white or a random non-user AI speaker
      const aiPlayers = this.players.filter(p => !(p instanceof UserPlayer));
      let speaker: Player | undefined = this.getAlivePlayers().find(p => (p as any).confirmedWhite && p.isAlive() && !(p instanceof UserPlayer));
      if (!speaker) speaker = aiPlayers.find(p => p.isAlive() && !(p instanceof UserPlayer));

      const gmAsk = 'みんなは今いるグレーの中で怪しいと思う方は誰ですか？';
      if (!speaker) {
        try { this.eventEmitter.emit('gm_message', { message: gmAsk }); } catch (e) {}
        return;
      }

      const askWho = (DIALOGUES[speaker.name] as any)?.ask_who_suspect || gmAsk;
      this.statements.push({ day: this.day, playerId: speaker.id, playerName: speaker.getDisplayName(), content: askWho });
      this.emitPlayerStatement(speaker, askWho, this.day);
      try {
        // フォールバック経路からでも vague_suspect の逐次シーケンスを開始する
        await (this as any).runVagueSequence?.(aiPlayers, (this as any)._askWhoSpeakerId);
      } catch (e) { console.log('[DEBUG emitAskWho->runVagueSequence error]', e); }
      // Note: full vague_suspect sequence is not reproduced here; the dynamic
      // instance implementation handles that when present.
    } catch (e) {
      console.log('[DEBUG emitAskWho fallback error]', e);
    }
  }

  /**
   * Permanent implementation of vague suspect sequence.
   * Replaces the previous dynamic `(this as any).runVagueSequence` assignment.
   */
  private async runVagueSequence(aiPlayersParam?: Player[], askWhoSpeakerId?: number): Promise<void> {
    try { console.log('[TRACE runVagueSequence start]'); } catch (e) {}
    try { this.suspendAIStatements = true; } catch (e) {}
    try { setTimeout(() => { try { if (this.suspendAIStatements) this.suspendAIStatements = false; } catch (e) {} }, 15000); } catch (e) {}
    const playersList = aiPlayersParam && aiPlayersParam.length ? aiPlayersParam : this.players.filter(p => !(p instanceof UserPlayer));
    const state = this.day1State;
    const coIds = new Set((state?.coPlayers || []).map((c: any) => c.playerId));
    // Speakers: all alive players except the User and the ask_who speaker
    const order_local = [...playersList].filter(p =>
      p.isAlive() &&
      !(p instanceof UserPlayer) &&
      p.id !== askWhoSpeakerId
    ).sort(() => Math.random() - 0.5);
    const suspectPairs: { suspecter: Player; target: Player }[] = [];
    for (const who of order_local) {
      if (this.aiStatementsStopped) break;
      // use original probabilistic behaviour (can be tuned)
      const doVague = Math.random() < 0.5;
      if (!doVague) {
        const noneDlg = (DIALOGUES[who.name] as any)?.none_suspect ?? 'まだ誰も思い浮かばないです…';
        this.statements.push({ day: this.day, playerId: who.id, playerName: who.getDisplayName(), content: noneDlg });
        this.emitPlayerStatement(who, noneDlg, this.day);
        await this.delay(2400);
        continue;
      }
      let targets_local = this.getAlivePlayers().filter(p =>
        p.id !== who.id &&
        !(p instanceof UserPlayer) &&
        !coIds.has(p.id)
      );
      if (targets_local.length === 0) {
        const noneDlg_local = (DIALOGUES[who.name] as any)?.none_suspect ?? 'まだ誰も思い浮かばないです…';
        this.statements.push({ day: this.day, playerId: who.id, playerName: who.getDisplayName(), content: noneDlg_local });
        this.emitPlayerStatement(who, noneDlg_local, this.day);
        await this.delay(2400);
        continue;
      }
      const target_local = targets_local[Math.floor(Math.random() * targets_local.length)];
      const noneDlg_local = (DIALOGUES[who.name] as any)?.none_suspect ?? 'まだ誰も思い浮かばないです…';
      if (coIds.has(target_local.id)) {
        this.statements.push({ day: this.day, playerId: who.id, playerName: who.getDisplayName(), content: noneDlg_local });
        this.emitPlayerStatement(who, noneDlg_local, this.day);
      } else {
        const dlg_local = (DIALOGUES[who.name] as any)?.vague_suspect ?? 'なんとなく〇〇が怪しいのかなと思ってます';
        const txt_local = dlg_local.replace(/〇〇/g, target_local.getDisplayName());
        this.statements.push({ day: this.day, playerId: who.id, playerName: who.getDisplayName(), content: txt_local });
        this.emitPlayerStatement(who, txt_local, this.day);
        // record suspect pair for possible ask_reason emission later
        try { suspectPairs.push({ suspecter: who, target: target_local }); } catch (e) {}
      }
      await this.delay(2400);
    }
    // After the vague sequence, ensure at least one ask_reason is emitted
    try {
      if (suspectPairs.length > 0) {
        const picked = suspectPairs.sort(() => Math.random() - 0.5).slice(0, 3);
        let anyAskEmitted = false;
        for (const pair of picked) {
          if (this.aiStatementsStopped) break;
          const { suspecter, target } = pair;
          let asker: Player | null = target;
          if (target instanceof UserPlayer) {
            const alt = this.getAlivePlayers().filter(p => p.isAlive() && !(p instanceof UserPlayer) && p.id !== suspecter.id);
            if (alt.length > 0) asker = alt[Math.floor(Math.random() * alt.length)];
            else asker = null;
          }
          if (asker && !(asker instanceof UserPlayer)) {
            const ar = (DIALOGUES[asker.name] as any)?.ask_reason ?? '〇〇さん、なぜ私が怪しいと思ったのですか？';
            const arTxt = ar.replace(/〇〇/g, suspecter.getDisplayName());
            this.statements.push({ day: this.day, playerId: asker.id, playerName: asker.getDisplayName(), content: arTxt, key: 'ask_reason' });
            this.emitPlayerStatement(asker, arTxt, this.day, 'ask_reason');
            anyAskEmitted = true;
            await this.delay(3000);

            // pick a random responder (not user, not suspecter, not asker)
            const possibleResponders = this.getAlivePlayers().filter(p =>
              p.isAlive() && !(p instanceof UserPlayer) && p.id !== suspecter.id && p.id !== asker.id
            );
            if (possibleResponders.length > 0) {
              const responder = possibleResponders[Math.floor(Math.random() * possibleResponders.length)];
              const confTpl = (DIALOGUES[responder.name] as any)?.conformity;
              if (confTpl) {
                const confTxt = confTpl.replace(/〇〇/g, asker.getDisplayName());
                this.statements.push({ day: this.day, playerId: responder.id, playerName: responder.getDisplayName(), content: confTxt });
                this.emitPlayerStatement(responder, confTxt, this.day);
                await this.delay(2400);
              }
            }
          }
            // After ask_reason/conformity, emit vague_reason and rebut_vague for the pair
            try {
              const reasonIdx = Math.floor(Math.random() * 3);
              if (!(suspecter instanceof UserPlayer)) {
                const vrKey = ['vague_reason1','vague_reason2','vague_reason3'][reasonIdx];
                const vr = (DIALOGUES[suspecter.name] as any)?.[vrKey] ?? '正直、直感かな…';
                const vrTxt = vr.replace(/〇〇/g, target.getDisplayName());
                this.statements.push({ day: this.day, playerId: suspecter.id, playerName: suspecter.getDisplayName(), content: vrTxt });
                this.emitPlayerStatement(suspecter, vrTxt, this.day);
                await this.delay(3000);
              }
              if (!(target instanceof UserPlayer)) {
                const rbKey = ['rebut_vague1','rebut_vague2','rebut_vague3'][reasonIdx];
                const rb = (DIALOGUES[target.name] as any)?.[rbKey] ?? 'その理由は納得できないな。';
                const rbTxt = rb.replace(/〇〇/g, suspecter.getDisplayName());
                this.statements.push({ day: this.day, playerId: target.id, playerName: target.getDisplayName(), content: rbTxt });
                this.emitPlayerStatement(target, rbTxt, this.day);
                await this.delay(2400);
              }
            } catch (e) { /* ignore vague/rebut errors */ }
        }
        // If none emitted (e.g., all targets were user and no alt), try a fallback single ask_reason
        if (!anyAskEmitted && suspectPairs.length > 0) {
          const pair = suspectPairs[0];
          const { suspecter } = pair;
          const alt = this.getAlivePlayers().filter(p => p.isAlive() && !(p instanceof UserPlayer) && p.id !== suspecter.id);
          if (alt.length > 0) {
            const asker = alt[Math.floor(Math.random() * alt.length)];
            const ar = (DIALOGUES[asker.name] as any)?.ask_reason ?? '〇〇さん、なぜ私が怪しいと思ったのですか？';
            const arTxt = ar.replace(/〇〇/g, suspecter.getDisplayName());
            this.statements.push({ day: this.day, playerId: asker.id, playerName: asker.getDisplayName(), content: arTxt, key: 'ask_reason' });
            this.emitPlayerStatement(asker, arTxt, this.day, 'ask_reason');
            await this.delay(3000);
          }
        }
      }
    } catch (e) { /* ignore */ }
    try { (this as any)._vagueDone = true; } catch (e) {}
    try { this.suspendAIStatements = false; } catch (e) {}
    try { console.log('[TRACE runVagueSequence end]'); } catch (e) {}
  }
}
