import { Role, Team, PlayerStatus, Statement, VoteRecord, DivinationResult, MediumResult, COInfo, VoteReason, StatementCategory, COType } from './types';
import { Character } from './characters';

/**
 * プレイヤーの基底クラス
 */
export abstract class Player {
  public id: number;
  public name: string;
  public icon: string;
  public personality: string;
  public speechStyle: string;
  public reactionType: 'aggressive' | 'defensive' | 'logical' | 'emotional' | 'passive' | 'neutral';
  public avoidActions: string[];
  public role: Role;
  public team: Team;
  public status: PlayerStatus;
  // 新しい確定フラグ
  public confirmedWhite: boolean = false;
  public confirmedBlack: boolean = false;
  public halfWhite: boolean = false;
  public halfBlack: boolean = false;
  
  // 疑いスコア（他プレイヤーへの疑念度）
  protected suspicionScores: Map<number, number> = new Map();
  
  // AI思考ログ（デバッグ用）
  protected thoughtLog: Array<{day: number, thought: string}> = [];
  
  // AI思考タイプ
  protected thinkingType: 'logical' | 'emotional' | 'cautious' | 'agitator' = 'logical';
  
  // 前日に言及したプレイヤーID（連続して同じ人を疑わないため）
  protected lastMentionedPlayerId: number | null = null;
  
  // 今日の発言回数
  protected statementCountToday: Map<number, number> = new Map();
  
  // 過去の発言ログ（全プレイヤー）
  protected statements: Statement[] = [];
  
  // 過去の投票履歴
  protected voteHistory: VoteRecord[] = [];
  
  // このフェーズで疑われたプレイヤーのカウント
  protected suspicionCount: Map<number, number> = new Map();
  
  // 今日のフェーズで既に使用された発言内容（重複防止）
  protected static usedStatementsToday: Set<string> = new Set();
  
  // プレイヤー発言への反応が必要かのフラグ
  protected needsReactionToUser: boolean = false;
  
  // 強制反応フラグ（重要なユーザー発言時）
  protected forceReaction: boolean = false;
  
  // 最後に疑われた日
  protected lastSuspectedDay: number = 0;
  
  // 議論テーマ管理
  protected discussionTheme: 'normal' | 'seer_co' | 'medium_co' = 'normal';
  protected coPlayerName: string = '';
  protected counterCORequested: boolean = false;
  
  // CO情報の記録
  protected coInfoList: COInfo[] = [];
  
  // 投票理由の記録
  protected myVoteReasons: VoteReason[] = [];

  // 確定情報のキャッシュ（全AIの再計算用）
  protected confirmedHumans: Set<number> = new Set();
  protected confirmedWolves: Set<number> = new Set();

  // 初日専用の吊り先制限（陣形による候補絞り込み）
  protected day1VoteCandidates: number[] | null = null;
  
  // 今日発言したか
  protected hasSpokenToday: boolean = false;
  
  // 1日ごとの発言カテゴリー履歴（同一意義の発言防止用）
  protected dailyStatementCategories: Map<number, StatementCategory[]> = new Map();
  
  constructor(id: number, name: string, role: Role, team: Team, character?: Character) {
    this.id = id;
    this.name = character?.name || name;
    this.icon = character?.icon || '👤';
    this.personality = character?.personality || '普通';
    this.speechStyle = character?.speechStyle || '普通';
    this.reactionType = character?.reactionType || 'neutral';
    this.avoidActions = character?.avoidActions || [];
    this.role = role;
    this.team = team;
    this.status = PlayerStatus.ALIVE;
    // 確定フラグはデフォルト false（フィールド初期化済み）
    
    // 思考タイプをランダムに割り当て
    const types: Array<'logical' | 'emotional' | 'cautious' | 'agitator'> = ['logical', 'emotional', 'cautious', 'agitator'];
    this.thinkingType = types[Math.floor(Math.random() * types.length)];
  }
  
  /**
   * プレイヤー名に敬称を付ける（「あなた」の場合は付けない）
   */
  protected formatPlayerName(player: Player): string {
    return player.name === 'あなた' ? 'あなた' : `${player.name}さん`;
  }

  /**
   * 表示用の名前を取得（「あなた」はそのまま、それ以外は「〜さん」を付与）
   */
  public getDisplayName(): string {
    // 基底クラスでは素の名前を返す（UI上の発言者名はそのまま表示するため）
    return this.name;
  }
  
  /**
   * ユーザー発言の重要度を判定
   * 0=通常, 1=高優先度（CO等）, 2=緊急（指名・圧力・指摘）
   */
  protected getUserStatementPriority(content: string, _speakerId: number): number {
    // 挨拶・自己紹介（初日のみ高優先度）
    if (/よろしく|はじめまして|こんにちは|よろしくお願い/.test(content)) {
      return 1;
    }
    
    // 自分への指名・質問
    if (new RegExp(`${this.name}.*どう|${this.name}.*思う|${this.name}.*意見|${this.name}.*について`).test(content)) {
      return 2;
    }
    
    // 矛盾・指摘（最優先）
    if (/矛盾|おかしい|同じこと|怪しい|嘘|偽|信用できない/.test(content)) {
      return 2;
    }
    
    // 擁護・否定
    if (/擁護|かばう|信じる|違うと思う|〇〇じゃない/.test(content)) {
      return 2;
    }
    
    // 役職CO（最優先）
    if (/CO|占い師です|霊能者です|狩人です|占い結果|占いました/.test(content)) {
      return 2;
    }
    
    // 対抗確認
    if (/対抗|他に.*いますか|本当ですか/.test(content)) {
      return 2;
    }
    
    // 圧力・脅迫
    if (/答えないと|投票する|吊る|処刑|黙ってる/.test(content)) {
      return 1;
    }
    
    // 疑いの発言
    if (/疑わしい|人狼だと思う/.test(content)) {
      return 1;
    }
    
    // 質問
    if (/\?|？|どう思|意見|教えて/.test(content)) {
      return 1;
    }
    
    return 0;
  }
  
  /**
   * 発言が重複していないかチェック
   * 類似度が高い場合はtrueを返す
   */
  protected isDuplicateStatement(statement: string): boolean {
    // 短い発言は除外
    if (statement.length < 5) return false;
    
    // 禁止定型文（使用禁止）- 更新のない、説得力のない定型文
    const bannedPhrases = [
      '判断材料が不足',
      '様子を見',
      '情報が少ない',
      '冷静に状況を判断',
      '慎重に進めましょう',
      '落ち着いて',
      '整理しましょう',
      'もう少し様子を見たいと思います',
      '今のところ判断が難しいですね',
      'もう少し観察したいです',
      '慎重に進めていきましょう',
      'なるほど、その視点は参考になります',
      'そういう考え方もあるんですね',
    ];
    
    // 禁止定型文が含まれていたら重複扱い
    for (const banned of bannedPhrases) {
      if (statement.includes(banned)) {
        return true;
      }
    }
    
    // キーフレーズを抽出（同日に使われていたら重複）
    const keyPhrases = [
      '論理が曖昧',
      '話が飛んでる',
      '説明が足りない',
      '発言が不自然',
      '矛盾があります',
      '一致していません',
      '行動パターン',
      '整合性',
    ];
    
    for (const phrase of keyPhrases) {
      if (statement.includes(phrase) && Player.usedStatementsToday.has(phrase)) {
        return true;
      }
    }
    
    // 完全一致チェック
    if (Player.usedStatementsToday.has(statement)) {
      return true;
    }
    
    // 類似文チェック（主語・名前を除いた文の骨格が同じ場合）
    // より厳密な骨格抽出
    const extractSkeleton = (text: string): string => {
      return text
        .replace(/[ぁ-ん]+さん/g, '[名前]')          // 敬称付き名前
        .replace(/あなた/g, '[名前]')                // ユーザーの代名詞
        .replace(/[ぁ-ん]+/g, '[プレイヤー]')        // その他プレイヤー名
        .replace(/\s+/g, '')                        // 空白削除
        .replace(/[、。！？、]/g, '');               // 句読点削除
    };
    
    const skeleton = extractSkeleton(statement);
    
    for (const used of Player.usedStatementsToday) {
      const usedSkeleton = extractSkeleton(used);
      
      // 骨格が完全一致 = 異なるプレイヤーを対象にしていても同じ意味
      if (skeleton === usedSkeleton && skeleton.length > 5) {
        return true;
      }
    }
    
    return false;
  }
  
  /**
   * 発言を使用済みとして記録
   */
  protected markStatementAsUsed(statement: string): void {
    Player.usedStatementsToday.add(statement);
    
    // キーフレーズも記録
    const keyPhrases = [
      '論理が曖昧',
      '話が飛んでる',
      '説明が足りない',
      '判断材料が不足',
      '様子を見',
      '情報が少ない',
    ];
    
    for (const phrase of keyPhrases) {
      if (statement.includes(phrase)) {
        Player.usedStatementsToday.add(phrase);
      }
    }
  }
  
  /**
   * 新しい日が始まったら使用済み発言をクリア
   */
  public static clearUsedStatements(): void {
    Player.usedStatementsToday.clear();
  }
  
  /**
   * ユーザー発言の内容を分析してリアクションフラグを設定
   */
  protected analyzeUserStatement(statements: Statement[], day: number): void {
    const todayUserStatements = statements.filter(
      s => s.day === day && s.playerId === 0 // プレイヤーID=0がユーザー
    );
    
    if (todayUserStatements.length === 0) return;
    
    const lastStatement = todayUserStatements[todayUserStatements.length - 1];
    const priority = this.getUserStatementPriority(lastStatement.content, lastStatement.playerId);
    
    if (priority >= 1) {
      this.needsReactionToUser = true;
    }
    
    // 自分が疑われているかチェック
    if (new RegExp(`${this.name}.*怪しい|${this.name}.*人狼|${this.name}.*疑わしい`).test(lastStatement.content)) {
      this.lastSuspectedDay = day;
      this.needsReactionToUser = true;
    }
  }
  
  /**
   * 生存しているか判定
   */
  public isAlive(): boolean {
    return this.status === PlayerStatus.ALIVE;
  }
  
  /**
   * プレイヤーを死亡させる
   */
  public kill(): void {
    this.status = PlayerStatus.DEAD;
  }
  
  /**
   * 疑いスコアを初期化
   */
  protected initializeSuspicionScores(alivePlayers: Player[]): void {
    // 生存プレイヤーで初期化（自分以外）
    alivePlayers.forEach(p => {
      if (p.id !== this.id && !this.suspicionScores.has(p.id)) {
        this.suspicionScores.set(p.id, 0);
      }
    });
  }
  
  /**
   * 発言を記録
   */
  public recordStatement(statement: Statement): void {
    this.statements.push(statement);
  }
  
  /**
   * 投票を記録
   */
  public recordVote(vote: VoteRecord): void {
    this.voteHistory.push(vote);
  }
  
  /**
   * CO情報を受け取る
   */
  public receiveCOInfo(coInfo: COInfo): void {
    this.coInfoList.push(coInfo);
    // 真のCO（TRUE_CO）または矛盾COの場合のみ反応
    if (coInfo.playerId !== this.id && 
        (coInfo.coType === COType.TRUE_CO || coInfo.coType === COType.CONTRADICTORY_CO)) {
      this.forceReaction = true;
      this.needsReactionToUser = true;
    }
  }
  
  /**
   * 強制反応フラグを設定
   */
  public setForceReaction(value: boolean): void {
    this.forceReaction = value;
    if (value) {
      this.needsReactionToUser = true;
    }
  }
  
  /**
   * 今日発言済みフラグをリセット
   */
  public resetDailyFlags(): void {
    this.hasSpokenToday = false;
    this.forceReaction = false;
    this.discussionTheme = 'normal';
    this.coPlayerName = '';
    this.counterCORequested = false;
    this.day1VoteCandidates = null;
  }
  
  public setDiscussionContext(theme: 'normal' | 'seer_co' | 'medium_co', coPlayerName: string, counterRequested: boolean): void {
    this.discussionTheme = theme;
    this.coPlayerName = coPlayerName;
    this.counterCORequested = counterRequested;
  }

  /**
   * 初日の吊り先候補をセット（nullでリセット）
   */
  public setDay1VoteCandidates(candidates: number[] | null): void {
    this.day1VoteCandidates = candidates;
  }

  /**
   * 確定情報（占い）を受け取ったときのフック
   */
  public onDivinationInfo(day: number, targetId: number, result: DivinationResult): void {
    if (result === DivinationResult.WEREWOLF) {
      this.confirmedWolves.add(targetId);
      // 狼確定は疑いスコアを強く上げる
      const current = this.suspicionScores.get(targetId) || 0;
      this.suspicionScores.set(targetId, current + 5);
    } else if (result === DivinationResult.HUMAN) {
      this.confirmedHumans.add(targetId);
      // 人間確定は疑いスコアをリセット方向へ
      this.suspicionScores.set(targetId, Math.min(this.suspicionScores.get(targetId) || 0, 0));
    }
    this.thoughtLog.push({ day, thought: `占い確定: ${targetId} -> ${result === DivinationResult.WEREWOLF ? '狼' : '人間'}` });
  }

  /**
   * 確定情報（霊能者）を受け取ったときのフック
   */
  public onMediumInfo(day: number, targetId: number, result: MediumResult): void {
    if (result === MediumResult.WEREWOLF) {
      this.confirmedWolves.add(targetId);
      const current = this.suspicionScores.get(targetId) || 0;
      this.suspicionScores.set(targetId, current + 5);
    } else if (result === MediumResult.HUMAN) {
      this.confirmedHumans.add(targetId);
      this.suspicionScores.set(targetId, Math.min(this.suspicionScores.get(targetId) || 0, 0));
    }
    this.thoughtLog.push({ day, thought: `霊能者確定: ${targetId} -> ${result === MediumResult.WEREWOLF ? '狼' : '人間'}` });
  }
  
  /**
   * 今日の発言回数を記録
   */
  protected incrementStatementCount(day: number): void {
    const count = this.statementCountToday.get(day) || 0;
    this.statementCountToday.set(day, count + 1);
  }
  
  /**
   * 発言カテゴリーを記録（同日に同じカテゴリーで複数発言することを防止）
   */
  protected recordStatementCategory(day: number, category: StatementCategory): void {
    const categories = this.dailyStatementCategories.get(day) || [];
    categories.push(category);
    this.dailyStatementCategories.set(day, categories);
  }
  
  /**
   * 当日の発言カテゴリーが使用済みかチェック（同一カテゴリー1日1回まで）
   */
  protected isCategoryUsedToday(day: number, category: StatementCategory): boolean {
    const categories = this.dailyStatementCategories.get(day) || [];
    return categories.includes(category);
  }
  
  /**
   * 発言履歴を更新
   */
  public updateStatements(statements: Statement[]): void {
    this.statements = statements;
  }
  
  /**
   * 投票履歴を更新
   */
  public updateVoteHistory(voteHistory: VoteRecord[]): void {
    this.voteHistory = voteHistory;
  }
  
  /**
   * 特定のプレイヤーに対する疑いを増やす
   */
  protected addSuspicion(playerId: number, amount: number = 1): void {
    const current = this.suspicionScores.get(playerId) || 0;
    this.suspicionScores.set(playerId, current + amount);
  }
  
  /**
   * 最も疑わしいプレイヤーを取得
   */
  protected getMostSuspiciousPlayer(alivePlayers: Player[]): Player | null {
    let maxScore = -1;
    let suspiciousPlayer: Player | null = null;
    
    alivePlayers.forEach(p => {
      if (p.id !== this.id) {
        const score = this.suspicionScores.get(p.id) || 0;
        if (score > maxScore) {
          maxScore = score;
          suspiciousPlayer = p;
        }
      }
    });
    
    return suspiciousPlayer;
  }

  /**
   * ユーザー発言への反応が必要か判定
   */
  protected shouldRespondToUser(_day: number, userStatementPriority: number): boolean {
    // 重要な発言には必ず反応
    if (userStatementPriority >= 1) {
      return true;
    }
    
    // 通常の発言には50%の確率で反応
    return Math.random() < 0.5;
  }

  /**
   * ユーザーが自分を疑ったかチェック
   */
  protected checkIfUserSuspectedMe(userStatement: Statement): boolean {
    const content = userStatement.content.toLowerCase();
    const myNameVariations = [
      this.name.toLowerCase(),
      this.name.replace('さん', '').toLowerCase()
    ];
    
    // 自分の名前が含まれているか
    const mentionsMe = myNameVariations.some(name => content.includes(name));
    
    // 疑いを示すキーワード
    const suspicionKeywords = ['怪しい', '疑わしい', '人狼', 'おかしい', '違和感'];
    const hasSuspicion = suspicionKeywords.some(keyword => content.includes(keyword));
    
    return mentionsMe && hasSuspicion;
  }

  /**
   * ユーザー発言に対する反応を生成
   */
  protected generateUserResponse(userStatement: Statement, _alivePlayers: Player[], _day: number): string {
    const content = userStatement.content;
    
    // 自分が疑われた場合の弁明
    if (this.checkIfUserSuspectedMe(userStatement)) {
      const excuses = [
        '初日なので、まだ確信は持てていません。もう少し様子を見たいです。',
        '発言が少なかったので気になりました。誤解だったかもしれません。',
        'すみません、判断材料が少なくて違和感を感じただけです。',
      ];
      return excuses[Math.floor(Math.random() * excuses.length)];
    }
    
    // 役職に関する質問への反応
      if (/役職|占い|霊能|狩人|CO/.test(content)) {
      return '';
    }
    
    // 投票に関する質問
    if (/投票|吊る|処刑|指定/.test(content)) {
      return 'その投票先について、もう少し根拠を聞かせてください。';
    }
    
    // 強い断定への反応
    if (/[！!]{2,}|絶対|確実|間違いない|明らか/.test(content)) {
      return 'そこまで断言する根拠は何でしょうか？';
    }
    
    // 急かす発言への反応
    if (/決めよう|決める|まとめ|結論|進めよう/.test(content)) {
      return '';
    }
    
    return 'なるほど、その意見も一理ありますね。';
  }

  /**
   * 他のAIプレイヤーの発言に対する反応を生成
   */
  protected generateAIResponse(targetStatement: Statement, _alivePlayers: Player[], _day: number): string {
    const content = targetStatement.content;
    
    // 他のAIが自分を疑った場合
    if (content.includes(this.name)) {
      const responses = [
        '確かに、そういう見方もできますね。でも他にも気になる人がいます。',
        '初日は判断が難しいですからね。もう少し様子を見ましょう。',
        '疑った理由は人それぞれだと思いますよ。',
      ];
      return responses[Math.floor(Math.random() * responses.length)];
    }
    
    // 役職に関する発言への反応
    if (/CO|カミングアウト|占い|霊能者/.test(content)) {
      return '役職の話が出ましたね。真贋を見極めるのは難しいですが、慎重に行きましょう。';
    }
    
    // 他者への疑いへの反応
    if (/怪しい|疑わしい|人狼/.test(content)) {
      return 'それもありますが、他にも怪しい人がいる気がします。';
    }
    
    // 断定的な発言への反応
    if (/絶対|確実|間違いない/.test(content)) {
      return '確かにそう見えますね。でも決めつけは危険かもしれません。';
    }
    
    // 情報不足への言及
    if (/情報|足りない|わからない/.test(content)) {
      return 'まだ情報が足りない気がしますが、どうでしょう。';
    }
    
    return '興味深い意見ですね。もう少し聞かせてください。';
  }

  /**
   * 昼の発言を生成（AIロジック）
   * @param userStatementPriority ユーザー発言の重要度 (0=通常, 1=重要)
   */
  public abstract makeStatement(day: number, alivePlayers: Player[], userStatementPriority?: number): string;

  /**
   * 投票先を決定（AIロジック）
   */
  public abstract vote(day: number, alivePlayers: Player[]): number;

  /**
   * 夜の行動を決定（AIロジック）
   * @returns 行動対象のプレイヤーID、または行動なしの場合はnull
   */
  public abstract nightAction(day: number, alivePlayers: Player[]): number | null;
}

/**
 * 村人クラス
 */
export class Villager extends Player {
  constructor(id: number, name: string, character?: Character) {
    super(id, name, Role.VILLAGER, Team.VILLAGER, character);
  }

  public makeStatement(day: number, alivePlayers: Player[], userStatementPriority: number = 0): string {
    this.initializeSuspicionScores(alivePlayers);
    this.analyzeUserStatement(this.statements, day);
    
    const statementCount = this.statementCountToday.get(day) || 0;
    
    // 強制反応が必要な場合は発言制限を無視
    if (this.forceReaction) {
      const statement = this.generateForcedReaction(day, alivePlayers);
      if (statement) {
        this.incrementStatementCount(day);
        this.markStatementAsUsed(statement);
        this.hasSpokenToday = true;
        this.forceReaction = false;
        return statement;
      }
    }
    
    // 発言回数制限なし（ユーザー発言への反応を優先）
    // ただし、クールダウンは別途game.ts側で管理される
    
    let statement = '';
    
    // 最優先: 対抗確認要求への反応
    if (this.counterCORequested && this.discussionTheme !== 'normal') {
      statement = this.generateCounterCOResponse(day, alivePlayers);
      this.counterCORequested = false; // 一度反応したらリセット
    }
    // 次: 占い師CO議論中
    else if (this.discussionTheme === 'seer_co' && statementCount < 2) {
      statement = this.generateCODiscussionStatement(day, alivePlayers);
    }
    // 次: ユーザー発言への反応（優先度1以上）
    else if (userStatementPriority >= 1) {
      statement = this.generateUserReaction(day, alivePlayers);
      
      // ユーザー反応が生成できなかった場合は通常の発言へ
      if (!statement || statement.trim() === '') {
        if (day === 1) {
          statement = this.generateDay1Statement(alivePlayers);
        } else {
          statement = this.generateDeductionStatement(day, alivePlayers);
        }
      }
    }
    // 次: 自分が疑われた場合の反応
    else if (this.lastSuspectedDay === day && statementCount < 2) {
      statement = this.generateDefenseStatement(day, alivePlayers);
    }
    // 通常の発言
    else {
      if (day === 1) {
        statement = this.generateDay1Statement(alivePlayers);
      } else {
        statement = this.generateDeductionStatement(day, alivePlayers);
      }
    }
    
    // 重複チェック
    if (this.isDuplicateStatement(statement)) {
      statement = this.generateAlternativeStatement(day, alivePlayers);
    }
    
    if (statement) {
      this.incrementStatementCount(day);
      this.markStatementAsUsed(statement);
    }
    
    return statement;
  }
  
  /**
   * 強制反応生成（CO等の重要発言時）
   */
  private generateForcedReaction(day: number, alivePlayers: Player[]): string {
    // 最新のCO情報を確認
    const latestCO = this.coInfoList.filter(co => co.day === day).slice(-1)[0];
    
    if (latestCO) {
      return this.generateCOReactionDetailed(latestCO, alivePlayers);
    }
    
    // ユーザーの直近の重要発言に反応
    const userStatements = this.statements.filter(s => s.day === day && s.playerId === 0);
    if (userStatements.length > 0) {
      return this.generateUserReaction(day, alivePlayers);
    }
    
    return '';
  }
  
  /**
   * CO情報への詳細反応（キャラクター性格とCO内容で変化）
   */
  private generateCOReactionDetailed(coInfo: COInfo, _alivePlayers: Player[]): string {
    const coPlayerName = coInfo.playerName;
    const role = coInfo.claimedRole;
    
    // CO役職による反応の違い
    let roleText = '';
    switch (role) {
      case Role.SEER:
        roleText = '占い師';
        break;
      case Role.MEDIUM:
        roleText = '霊能者';
        break;
      case Role.KNIGHT:
        roleText = '狩人';
        break;
      default:
        roleText = '役職';
    }
    
    // キャラクター性格による反応パターン
    switch (this.reactionType) {
      case 'aggressive': // シンジョー
        const aggressiveCO = [
          `${coPlayerName}が${roleText}CO？本当かよ？`,
          `おい、${roleText}COするなら証拠見せろよ。`,
          `${roleText}COか。タイミング怪しくね？`,
          `${coPlayerName}、${roleText}なら早く情報出せ。`,
        ];
        return aggressiveCO[Math.floor(Math.random() * aggressiveCO.length)];
        
      case 'defensive': // サヤカ
        const defensiveCO = [
          `${coPlayerName}さんが${roleText}CO...対抗はいますか？`,
          '',
          `え、${roleText}CO？もう少し詳しく聞かせてください。`,
          `${coPlayerName}さんが${roleText}なら、結果を教えてほしいです。`,
        ];
        return defensiveCO[Math.floor(Math.random() * defensiveCO.length)];
        
        case 'logical': // アツト、ミヤビ
          const logicalCO = [
            `${coPlayerName}さんが${roleText}。対抗がいるかで真偽判断できますね。`,
            `${roleText}COを確認しました。結果を共有してもらえますか？`,
            `なるほど、${roleText}CO。他の情報と照合します。`,
          ];
          return logicalCO[Math.floor(Math.random() * logicalCO.length)];
        
      case 'emotional': // マユミ、ジョン
        const emotionalCO = [
            `${coPlayerName}さんが${roleText}COですね。`,
            `${coPlayerName}さん${roleText}なんですね。頼りにしてます！`,
            `${roleText}CO...本当かな...`,
        ];
        return emotionalCO[Math.floor(Math.random() * emotionalCO.length)];
        
      case 'passive': // ヤスキチ
        const passiveCO = [
          `${roleText}COね。まあ、そう言うならそうなんだろ。`,
          `はいはい、${roleText}CO了解。`,
          `${coPlayerName}が${roleText}か。別にいいけど。`,
          `${roleText}ねえ...で？`,
        ];
        return passiveCO[Math.floor(Math.random() * passiveCO.length)];
        
      case 'neutral': // ヨシコ
        const neutralCO = [
          '',
          `${coPlayerName}さん、${roleText}として今後も情報共有お願いします。`,
          `${roleText}COありがとうございます。対抗の有無を確認したいです。`,
        ];
        return neutralCO[Math.floor(Math.random() * neutralCO.length)];
        
      default:
        return `${coPlayerName}さんが${roleText}COですね。確認しました。`;
    }
  }
  
  /**
   * ユーザー発言への反応生成（キャラクター性格反映）
   */
  private generateUserReaction(day: number, _alivePlayers: Player[]): string {
    const userStatements = this.statements.filter(s => s.day === day && s.playerId === 0);
    if (userStatements.length === 0) return '';
    
    const lastUserStatement = userStatements[userStatements.length - 1];
    const content = lastUserStatement.content;
    
    // 矛盾CO検出（同じ日で複数のCOが異なる場合）
    const userCOStatements = userStatements.filter(s => /CO|占い師|霊能者|狩人|村人です|村人だ/.test(s.content));
    if (userCOStatements.length > 1) {
      // 複数のCOが存在する = 矛盾の可能性
      const coTexts = userCOStatements.map(s => s.content);
      // 役職が異なるCOであれば矛盾
      const roles: (string | null)[] = coTexts.map(t => {
        if (/占い師/.test(t)) return '占い師';
        if (/霊能者/.test(t)) return '霊能者';
        if (/狩人/.test(t)) return '狩人';
        if (/村人/.test(t)) return '村人';
        return null;
      });
      
      const uniqueRoles = new Set(roles.filter(r => r !== null));
      if (uniqueRoles.size > 1) {
        // 異なる役職のCOがある = 明らかな矛盾
        return this.generateCOContradictionResponse(coTexts);
      }
    }
    
    // 挨拶・自己紹介への反応
    if (/よろしく|はじめまして|こんにちは/.test(content)) {
      return this.generateGreetingResponse();
    }
    
    // 矛盾・指摘への反応（自分が対象の場合）
    if (content.includes(this.name) && /矛盾|おかしい|同じこと|怪しい/.test(content)) {
      return this.generateAccusationResponse(content);
    }
    
    // 擁護への反応
    if (/擁護|かばう|信じる/.test(content)) {
      return this.generateDefenseResponse(content);
    }
    
    // CO質問への反応
    if (/COあります|COは|CO.*ありますか|COない/.test(content)) {
      return this.generateCOQuestionResponse();
    }
    
    // CO検出
    if (/CO|占い師|霊能者|狩人|占い結果|占いました|村人です|村人だ/.test(content)) {
      return this.generateCOReaction(content);
    }
    
    // 自分への指名
    if (new RegExp(`${this.name}.*どう|${this.name}.*思う`).test(content)) {
      return this.generateDirectQuestionResponse(content);
    }
    
    // 圧力発言
    if (/答えないと|投票する|吊る/.test(content)) {
      return this.generatePressureResponse();
    }
    
    // 疑いの発言
    if (/怪しい|疑わしい|人狼/.test(content)) {
      return this.generateSuspicionReaction(content);
    }
    
    return this.generateGeneralReaction(content);
  }
  
  /**
   * CO矛盾への反応（キャラクター性格別）
   */
  private generateCOContradictionResponse(_coTexts: string[]): string {
    switch (this.reactionType) {
      case 'aggressive':
        const aggressiveContradictions = [
          'おい、さっきと言ってることが違うじゃねーか！',
          'COが矛盾してるぞ。嘘つきなのか？',
          '占い師だの霊能者だの、話がコロコロ変わってるじゃん。',
        ];
        return aggressiveContradictions[Math.floor(Math.random() * aggressiveContradictions.length)];
        
      case 'defensive':
        const defensiveContradictions = [
          'え、ちょっと待ってください。さっきと違う役職を言ってませんか？',
          'あ、矛盾しています。本当の役職は何ですか？',
          'す、すみません。発言がぶれているように見えるのですが...',
        ];
        return defensiveContradictions[Math.floor(Math.random() * defensiveContradictions.length)];
        
      case 'logical':
        const logicalContradictions = [
          '矛盾を検出しました。複数回異なる役職をCOしています。',
          'CO内容の整合性がありません。どちらが本当ですか？',
          '論理的に矛盾しています。説明してください。',
        ];
        return logicalContradictions[Math.floor(Math.random() * logicalContradictions.length)];
        
      case 'emotional':
        const emotionalContradictions = [
          'え、さっきと違うこと言ってませんか...？',
          'ちょっと怖いんですけど...嘘ついてるんですか...？',
          '矛盾してる...本当のこと言ってくださいよ...。',
        ];
        return emotionalContradictions[Math.floor(Math.random() * emotionalContradictions.length)];
        
      case 'passive':
        const passiveContradictions = [
          'あ、言ってることが違うな。',
          'COが矛盾してるけど。',
          'まあ、嘘ついてるんだろ。',
        ];
        return passiveContradictions[Math.floor(Math.random() * passiveContradictions.length)];
        
      case 'neutral':
        const neutralContradictions = [
          'すみません。複数のCOがされているようですが、整理してもらえますか？',
          'COの内容が矛盾しているようです。詳しく説明をお願いします。',
          'ご発言に矛盾が見られます。どちらが正しいのでしょうか？',
        ];
        return neutralContradictions[Math.floor(Math.random() * neutralContradictions.length)];
        
      default:
        return '矛盾していないでしょうか？確認してもらえますか？';
    }
  }
  
  /**
   * 挨拶への応答
   */
  private generateGreetingResponse(): string {
    switch (this.reactionType) {
      case 'aggressive':
        return 'ああ、よろしくな。';
      case 'defensive':
        return 'よろしくお願いします！頑張りましょう。';
      case 'logical':
        return 'よろしくお願いします。論理的に進めましょう。';
      case 'emotional':
        return 'よろしくです！楽しみましょうね！';
      case 'passive':
        return 'はいはい、よろしく。';
      case 'neutral':
        return 'よろしくお願いします。皆で協力しましょう。';
      default:
        return 'よろしくお願いします。';
    }
  }
  
  /**
   * 指摘・非難への反応（自分が対象）
   */
  private generateAccusationResponse(_content: string): string {
    switch (this.reactionType) {
      case 'aggressive':
        const aggressiveAccusations = [
          'は？何言ってんだ？俺を疑うのか？',
          'おかしいのはお前の方だろ！',
          '根拠もなく決めつけんな！',
        ];
        return aggressiveAccusations[Math.floor(Math.random() * aggressiveAccusations.length)];
        
      case 'defensive':
        const defensiveAccusations = [
          'ち、違います！誤解です！',
          'そんなつもりじゃないんです...説明させてください！',
          'え、私ですか？なぜそう思うんですか？',
        ];
        return defensiveAccusations[Math.floor(Math.random() * defensiveAccusations.length)];
        
      case 'logical':
        const logicalAccusations = [
          'その指摘の根拠を具体的に教えてください。',
          '誤解があるようです。論理的に説明しますね。',
          'なぜそう判断したのか、理由を聞かせてください。',
        ];
        return logicalAccusations[Math.floor(Math.random() * logicalAccusations.length)];
        
      case 'emotional':
        const emotionalAccusations = [
          'えっ...そんなこと言われると悲しいです...',
          'ひどい...私何もしてないのに...',
          '誤解ですよ！信じてください！',
        ];
        return emotionalAccusations[Math.floor(Math.random() * emotionalAccusations.length)];
        
      case 'passive':
        const passiveAccusations = [
          '別に疑うなら疑えば？',
          'そう見えるなら仕方ないけど。',
          'まあ、好きに思えばいいよ。',
        ];
        return passiveAccusations[Math.floor(Math.random() * passiveAccusations.length)];
        
      case 'neutral':
        const neutralAccusations = [
          'その指摘について、詳しく聞かせてもらえますか？',
          '誤解があると思います。説明させてください。',
          'なるほど、そう見えたんですね。でも違います。',
        ];
        return neutralAccusations[Math.floor(Math.random() * neutralAccusations.length)];
        
      default:
        return '私は違います。誤解です。';
    }
  }
  
  /**
   * 擁護への反応
   */
  private generateDefenseResponse(content: string): string {
    // 自分が擁護されているかチェック
    if (content.includes(this.name)) {
      switch (this.reactionType) {
        case 'aggressive':
          return 'ありがとな。わかってくれる人がいて助かるわ。';
        case 'defensive':
          return 'ありがとうございます...心強いです。';
        case 'logical':
          return 'ありがとうございます。冷静に見てくれる人がいて助かります。';
        case 'emotional':
          return 'ありがとうございます！嬉しいです！';
        case 'passive':
          return 'まあ、ありがと。';
        case 'neutral':
          return 'ありがとうございます。皆で真実を見つけましょう。';
        default:
          return 'ありがとうございます。';
      }
    } else {
      // 第三者として擁護を見た反応
      switch (this.reactionType) {
        case 'aggressive':
          return 'そうやってかばうのも怪しいけどな。';
        case 'defensive':
          return 'そういう見方もあるんですね...';
        case 'logical':
          return 'その擁護の根拠は何ですか？';
        case 'emotional':
          return '優しいですね...';
        case 'passive':
          return 'まあ、そう思うならそうなんだろ。';
        case 'neutral':
          return 'なるほど、そういう意見もありますね。';
        default:
          return 'そういう見方もあるんですね。';
      }
    }
  }
  
  /**
   * CO発言への反応（キャラクター性格別）
   */
  /**
   * 対抗確認要求への応答
   */
  private generateCounterCOResponse(_day: number, _alivePlayers: Player[]): string {
    // 自分が対抗役職を持っている場合
    if (this.discussionTheme === 'seer_co' && this.role === Role.SEER && this.id !== 1) {
      return this.generateCounterCO();
    }
    
    // 対抗でない場合は評価コメント
    switch (this.reactionType) {
      case 'aggressive':
        return `対抗いないなら${this.coPlayerName}真でいいんじゃね？`;
      case 'defensive':
        return `対抗が出ないなら、${this.coPlayerName}さんを信じてもいいかもしれません...`;
      case 'logical':
        return `対抗不在ということは、${this.coPlayerName}さんの信用度は高いですね。`;
      case 'emotional':
        return `対抗いないみたいですね！${this.coPlayerName}さん、頑張ってください！`;
      case 'passive':
        return '対抗いないなら、まあそういうことだろ。';
      case 'neutral':
        return `対抗が出ないようなら、${this.coPlayerName}さんを軸に進めましょう。`;
      default:
        return `対抗がいないなら、${this.coPlayerName}さんの発言を重視すべきですね。`;
    }
  }
  
  /**
   * 対抗COを出す
   */
  private generateCounterCO(): string {
    switch (this.reactionType) {
      case 'aggressive':
        return '悪いが、俺も占い師だ。対抗CO。';
      case 'defensive':
        return 'すみません...実は私も占い師です。対抗します。';
      case 'logical':
        return '私も占い師です。対抗COします。';
      case 'emotional':
        return 'えっと...私も占い師なんです！';
      case 'passive':
        return '面倒だが、俺も占い師だ。';
      case 'neutral':
        return '私も占い師です。対抗させていただきます。';
      default:
        return '対抗します。私も占い師です。';
    }
  }
  
  /**
   * CO議論専用の発言生成
   */
  private generateCODiscussionStatement(_day: number, _alivePlayers: Player[]): string {
    const isUserCO = this.coPlayerName === 'あなた';
    
    switch (this.reactionType) {
      case 'aggressive':
        const aggressiveCO = [
          `${this.coPlayerName}の占い、どうなんだ？信じていいのか？`,
          `占い師COのタイミングが早すぎねーか？`,
          `${this.coPlayerName}、結果を詳しく教えろよ。`,
        ];
        return aggressiveCO[Math.floor(Math.random() * aggressiveCO.length)];
        
      case 'defensive':
        const defensiveCO = [
          `${this.coPlayerName}さんの占い結果、どう見るべきでしょうか...`,
          `占い師がいるのは心強いですが、真偽は慎重に...`,
          `${this.coPlayerName}さん、次の結果も教えてくださいね。`,
        ];
        return defensiveCO[Math.floor(Math.random() * defensiveCO.length)];
        
      case 'logical':
        const logicalCO = [
          `${this.coPlayerName}さんの占い結果を軸に推理を進めましょう。`,
          `占い師の真偽判断が今日の重要ポイントです。`,
          `${this.coPlayerName}さん、占い先の選定理由を教えてください。`,
          isUserCO ? 'あなたが占い師なら、結果を共有してください。' : `${this.coPlayerName}さんを軸に議論を進めるべきです。`,
        ];
        return logicalCO[Math.floor(Math.random() * logicalCO.length)];
        
      case 'emotional':
        const emotionalCO = [
          `${this.coPlayerName}さん、本当に占い師ですか？信じていいですか？`,
          `占い師さんが出てくれて嬉しいです！`,
          `${this.coPlayerName}さんの結果、すごく気になります！`,
        ];
        return emotionalCO[Math.floor(Math.random() * emotionalCO.length)];
        
      case 'passive':
        const passiveCO = [
          `まあ、${this.coPlayerName}が占い師ならそれでいいんじゃね。`,
          '占い結果次第だな。',
          `${this.coPlayerName}の言う通りにするしかないだろ。`,
        ];
        return passiveCO[Math.floor(Math.random() * passiveCO.length)];
        
      case 'neutral':
        const neutralCO = [
          `${this.coPlayerName}さんの占い結果を確認しながら進めましょう。`,
          '占い師が出たので、情報が増えますね。',
          `${this.coPlayerName}さん、今後の結果も共有してください。`,
        ];
        return neutralCO[Math.floor(Math.random() * neutralCO.length)];
        
      default:
        return `${this.coPlayerName}さんの占い結果を重視します。`;
    }
  }
  
  /**
   * CO質問への応答
   */
  private generateCOQuestionResponse(): string {
    switch (this.reactionType) {
      case 'aggressive':
        return '今のところはねーな。';
      case 'defensive':
        return '私は特にありません...';
      case 'logical':
        return 'まだそのタイミングではないと判断しています。';
      case 'emotional':
        return '今は何もないです！';
      case 'passive':
        return '別に。';
      case 'neutral':
        return '今のところは大丈夫です。';
      default:
        return 'まだありません。';
    }
  }
  
  private generateCOReaction(content: string): string {
    // 村人COへの反応
    if (/村人です|村人だ/.test(content)) {
      switch (this.reactionType) {
        case 'aggressive':
          return '村人CO？まあ、初日だし無難だな。';
        case 'defensive':
          return '村人COですね。了解しました。';
        case 'logical':
          return '村人COですか。情報としては弱いですが、了解です。';
        case 'emotional':
          return '村人なんですね！わかりました！';
        case 'passive':
          return 'ふーん、村人か。';
        case 'neutral':
          return '村人COありがとうございます。';
        default:
          return '村人ですね、了解しました。';
      }
    }
    
    // その他のCO（占い師、霊能者、狩人等）
    switch (this.reactionType) {
      case 'aggressive':
        return 'おいおい、いきなりCO？本当か？';
      case 'defensive':
        return 'COですか...真偽を確認したいですね。';
      case 'logical':
        return 'なるほど。その根拠を教えていただけますか？';
      case 'emotional':
        return 'えっ、本当ですか？';
      case 'passive':
        return 'まあ、そう言うならそうなんだろ。';
      case 'neutral':
        return '役職の話は大切ですね。みなさんはどう思いますか？';
      default:
        return 'COありがとうございます。';
    }
  }
  
  /**
   * 直接質問への応答（キャラクター性格別）
   */
  private generateDirectQuestionResponse(_content: string): string {
    // 具体的事実を1つ添えて回答する
    switch (this.reactionType) {
      case 'aggressive':
        return '';
      case 'defensive':
        return '';
      case 'logical':
        return '';
      case 'emotional':
        return '';
      case 'passive':
        return '';
      case 'neutral':
        return '';
      default:
        return '';
    }
  }
  
  /**
   * 圧力への反応（キャラクター性格別）
   */
  private generatePressureResponse(): string {
    switch (this.reactionType) {
      case 'aggressive':
        return 'は？脅してんのか？そっちこそ怪しいんじゃねーの？';
      case 'defensive':
        return 'ちょ、ちょっと待ってください！そんな言い方されても...';
      case 'logical':
        return 'その圧力は論理的ではありませんね。冷静に議論しましょう。';
      case 'emotional':
        return 'そんな...怖いです。でも私は何も隠してません！';
      case 'passive':
        return 'はいはい、わかったわかった。';
      case 'neutral':
        return 'そういう進め方は良くないと思います。';
      default:
        return '落ち着いて話し合いましょう。';
    }
  }
  
  /**
   * 疑い発言への反応
   */
  private generateSuspicionReaction(content: string): string {
    // 自分が疑われているか確認
    if (content.includes(this.name)) {
      return this.generateDefenseStatement(1, []);
    }
    // 具体的事実を1つ示しつつ応答
    const yesterday = Math.max(1, (this.statements.slice(-1)[0]?.day || 1) - 1);
    const vote = this.voteHistory.find(v => v.day === yesterday);
    const fact = vote ? `昨日はID${vote.targetId}への投票がありました` : '昨日の投票やCOに決定的な材料はありませんでした';
    switch (this.reactionType) {
      case 'aggressive':
        return `それって決めつけじゃね？${fact}。証拠あんのか？`;
      case 'defensive':
        return `確かに怪しい部分はありますが、${fact}。断定するのは早いかも...`;
      case 'logical':
        return `その疑いの根拠を整理してもらえますか？${fact} を踏まえて議論しましょう。`;
      case 'emotional':
        return `そう言われると、そんな気もしてきました...。${fact}。`;
      case 'passive':
        return `まあ、そう思うならそれでいいんじゃね。${fact}。`;
      case 'neutral':
        return `疑いは大切ですが、${fact} など他の可能性も考えたいですね。`;
      default:
        return `なるほど、そういう見方もあるんですね。${fact}。`;
    }
  }
  
  /**
   * 一般的な反応
   */
  private generateGeneralReaction(_content: string): string {
    const reactions = [
      'なるほど、その視点は参考になります。',
      'そういう考え方もあるんですね。',
      'もう少し詳しく聞かせてもらえますか？',
      '面白い意見ですね。',
    ];
    return reactions[Math.floor(Math.random() * reactions.length)];
  }
  
  /**
   * 防御発言生成（疑われた時）
   */
  private generateDefenseStatement(_day: number, _alivePlayers: Player[]): string {
    switch (this.reactionType) {
      case 'aggressive':
        return '俺を疑うってことは、お前が怪しいってことだろ！';
      case 'defensive':
        return 'ち、違います！私は村人です！信じてください！';
      case 'logical':
        return '疑う理由を具体的に説明してください。反論します。';
      case 'emotional':
        return 'そんな...私何もしてません。信じてもらえないんですか...？';
      case 'passive':
        return '別に疑うならそれでいいけど。勝手にどうぞ。';
      case 'neutral':
        return '疑われるのは理解できますが、誤解です。';
      default:
        return '私は村人です。冷静に判断してください。';
    }
  }
  
  /**
   * 初日の発言生成（キャラクター性格反映）
   */
  private generateDay1Statement(alivePlayers: Player[]): string {
    const others = alivePlayers.filter(p => 
      p.id !== this.id && 
      p.id !== this.lastMentionedPlayerId
    );
    
    if (others.length === 0) return '';
    
    const target = others[Math.floor(Math.random() * others.length)];
    this.lastMentionedPlayerId = target.id;
    
    // キャラクター性格別の発言パターン
    switch (this.reactionType) {
      case 'aggressive': // シンジョー
        const aggressiveStatements = [''];
        return aggressiveStatements[Math.floor(Math.random() * aggressiveStatements.length)];
        
      case 'defensive': // サヤカ
        const defensiveStatements = [''];
        return defensiveStatements[Math.floor(Math.random() * defensiveStatements.length)];
        
      case 'logical': // アツト、ミヤビ
        const logicalStatements = [''];
        return logicalStatements[Math.floor(Math.random() * logicalStatements.length)];
        
      case 'emotional': // マユミ、ジョン
        const emotionalStatements = [''];
        return emotionalStatements[Math.floor(Math.random() * emotionalStatements.length)];
        
      case 'passive': // ヤスキチ
        const passiveStatements = [''];
        return passiveStatements[Math.floor(Math.random() * passiveStatements.length)];
        
      case 'neutral': // ヨシコ
        const neutralStatements = [''];
        return neutralStatements[Math.floor(Math.random() * neutralStatements.length)];

      default:
        return '';
    }
  }
  
  /**
   * 代替発言生成（重複回避用）- より具体的な発言を優先
   */
  private generateAlternativeStatement(_day: number, _alivePlayers: Player[]): string {
    const alternatives = [
      // より具体的で説得力のある代替発言
      '過去の行動パターンを整理する必要があります。',
      '複数の視点から分析してみましょう。',
      '昨日と今日の発言内容を比較したいです。',
      'プレイヤーごとの投票パターンが気になります。',
      '疑いの根拠を明確にしてから判断しましょう。',
      '情報を整理してから発言したいです。',
      '皆さんの意見を参考にさせてください。',
    ];
    
    // さらに重複していたら空文字列を返す
    for (const alt of alternatives) {
      if (!this.isDuplicateStatement(alt)) {
        return alt;
      }
    }
    
    return '';
  }
  
  /**
   * 疑いや推理の発言を生成（2日目以降）
   * 必須3要素: ①具体的事実 ②理由（論理/心理）③代替仮説
   */
  private generateDeductionStatement(day: number, alivePlayers: Player[]): string {
    const target = this.selectSuspiciousTarget(alivePlayers, day);
    if (!target) return '';

    const targetName = this.formatPlayerName(target);
    this.lastMentionedPlayerId = target.id;

    // ① 具体的事実
    const yesterday = day - 1;
    const yesterdayVotes = this.voteHistory.filter(v => v.day === yesterday);
    const targetVote = yesterdayVotes.find(v => v.voterId === target.id);
    const targetYesterdaysStatements = this.statements.filter(s => s.day === yesterday && (s.playerId === target.id || s.playerName === target.name));

    let fact = '';
    if (targetVote) {
      const votedName = (alivePlayers.find(p => p.id === targetVote.targetId)?.name) || '不明';
      fact = `昨日(${yesterday}日目)の投票で${targetName}は${votedName === 'あなた' ? 'あなた' : votedName + 'さん'}に投票`;
    } else if (targetYesterdaysStatements.length > 0) {
      const sample = targetYesterdaysStatements[targetYesterdaysStatements.length - 1].content;
      fact = `昨日(${yesterday}日目)の発言「${sample.slice(0, 20)}…」`;
    } else {
      fact = `これまでの発言量と行動の傾向`;
    }

    // ② 理由（性格×視点）
    let reason = '';
    switch (this.reactionType) {
      case 'logical':
        reason = '発言と投票の整合性が低く、矛盾が見られるため';
        break;
      case 'aggressive':
        reason = 'タイミングと態度が不自然で、狼の身内切りや誘導に見えるため';
        break;
      case 'defensive':
        reason = '慎重さが欠けており、村利より自己防衛が優先に見えるため';
        break;
      case 'emotional':
        reason = '雰囲気や反応に違和感があり、心理的に狼寄りに感じるため';
        break;
      case 'passive':
        reason = '直近の動きが雑で、責任回避の投票に見えるため';
        break;
      default:
        reason = '全体の流れと照らし合わせて不自然な点があるため';
    }

    // ③ 代替仮説（村人だった場合）
    let alternative = '';
    switch (this.reactionType) {
      case 'logical':
        alternative = '村なら情報不足で誤った判断をした可能性や、役職保護のための発言ぶれ';
        break;
      case 'aggressive':
        alternative = '村なら焦りやミスで雑になった可能性';
        break;
      case 'defensive':
        alternative = '村なら疑われて萎縮し、防御的になっただけの可能性';
        break;
      case 'emotional':
        alternative = '村なら周囲に流されてしまっただけの可能性';
        break;
      case 'passive':
        alternative = '村なら消極的で流れ任せになっただけの可能性';
        break;
      default:
        alternative = '村なら情報整理が追いついていないだけの可能性';
    }

    return `${fact}。${reason}ので、${targetName}が気になります。ただ、${alternative}もあり得ます。`;
  }
  
  /**
   * 疑わしいターゲットを選定
   */
  private selectSuspiciousTarget(alivePlayers: Player[], day: number): Player | null {
    const candidates = alivePlayers.filter(p => 
      p.id !== this.id && 
      p.id !== this.lastMentionedPlayerId
    );
    
    if (candidates.length === 0) {
      return alivePlayers.find(p => p.id !== this.id) || null;
    }
    
    // 投票履歴から怪しいプレイヤーを選定
    const voteCounts = new Map<number, number>();
    this.voteHistory
      .filter(v => v.day === day - 1)
      .forEach(v => {
        voteCounts.set(v.targetId, (voteCounts.get(v.targetId) || 0) + 1);
      });
    
    // 投票されなかったプレイヤーを優先的に疑う（人狼が仲間を守った可能性）
    const notVotedPlayers = candidates.filter(p => !voteCounts.has(p.id));
    if (notVotedPlayers.length > 0 && Math.random() < 0.6) {
      return notVotedPlayers[Math.floor(Math.random() * notVotedPlayers.length)];
    }
    
    // ランダムに選定
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  public vote(day: number, alivePlayers: Player[]): number {
    this.initializeSuspicionScores(alivePlayers);
    
    // ユーザー（ID=1）を投票対象から除外
    const baseTargets = alivePlayers.filter(p => p.id !== this.id && p.id !== 1);
    if (baseTargets.length === 0) return this.id;
    let targets = baseTargets;
    if (day === 1 && this.day1VoteCandidates && this.day1VoteCandidates.length > 0) {
      const restricted = baseTargets.filter(p => this.day1VoteCandidates!.includes(p.id));
      if (restricted.length > 0) {
        targets = restricted;
      }
    }
    
    let voteTargetId: number;
    let voteReason: string;
    
    // 発言で言及したプレイヤーへの投票を優先
    if (this.lastMentionedPlayerId) {
      const mentionedPlayer = targets.find(p => p.id === this.lastMentionedPlayerId);
      if (mentionedPlayer) {
        voteTargetId = mentionedPlayer.id;
        voteReason = `発言で疑った${this.formatPlayerName(mentionedPlayer)}`;
        
        // 投票理由を記録
        this.myVoteReasons.push({
          voterId: this.id,
          targetId: voteTargetId,
          reason: voteReason,
          day: day,
        });
        
        this.thoughtLog.push({
          day,
          thought: voteReason
        });
        return voteTargetId;
      }
    }
    
    // 疑いスコアが高いプレイヤーに投票
    let maxScore = -1;
    let voteTarget: Player | null = null;
    
    for (const p of targets) {
      const score = this.suspicionScores.get(p.id) || 0;
      if (score > maxScore) {
        maxScore = score;
        voteTarget = p;
      }
    }
    
    if (voteTarget !== null) {
      voteTargetId = voteTarget.id;
      voteReason = `疑いスコアが高い${this.formatPlayerName(voteTarget)}`;
      
      this.myVoteReasons.push({
        voterId: this.id,
        targetId: voteTargetId,
        reason: voteReason,
        day: day,
      });
      
      this.thoughtLog.push({
        day,
        thought: voteReason
      });
      return voteTargetId;
    }
    
    // ランダム投票（ユーザーは50%確率で回避）
    const nonUserTargets = targets.filter(p => p.name !== 'あなた');
    const availableTargets = nonUserTargets.length > 0 && Math.random() < 0.5
      ? nonUserTargets
      : targets;
    
    const target = availableTargets[Math.floor(Math.random() * availableTargets.length)];
    voteTargetId = target.id;
    voteReason = `ランダムで${this.formatPlayerName(target)}に投票`;
    
    this.myVoteReasons.push({
      voterId: this.id,
      targetId: voteTargetId,
      reason: voteReason,
      day: day,
    });
    
    this.thoughtLog.push({
      day,
      thought: voteReason
    });
    
    return voteTargetId;
  }

  public nightAction(_day: number, _alivePlayers: Player[]): number | null {
    return null; // 村人は夜の行動なし
  }
}

/**
 * 人狼クラス
 */
export class Werewolf extends Player {
  constructor(id: number, name: string, character?: Character) {
    super(id, name, Role.WEREWOLF, Team.WEREWOLF, character);
  }

  private attackHistory: Array<{day: number, targetId: number}> = [];

  public makeStatement(day: number, alivePlayers: Player[], userStatementPriority: number = 0): string {
    this.initializeSuspicionScores(alivePlayers);
    
    const statementCount = this.statementCountToday.get(day) || 0;
    
    // 初日は最大1回の発言に制限
    if (day === 1 && statementCount >= 1 && userStatementPriority === 0) {
      return '';
    }
    
    // ユーザー発言への反応
    const recentStatements = this.statements.filter(s => s.day === day).slice(-5);
    const userStatement = recentStatements.find(s => s.playerName === 'あなた');
    
    if (userStatement) {
      const priority = this.getUserStatementPriority(userStatement.content, userStatement.playerId);
      
      if (this.shouldRespondToUser(day, priority)) {
        this.incrementStatementCount(day);
        return this.generateUserResponse(userStatement, alivePlayers, day);
      }
    }
    
    // 初日は村人のふりをする
    if (day === 1) {
      this.incrementStatementCount(day);
      const others = alivePlayers.filter(p => p.id !== this.id && p.team !== Team.WEREWOLF);
      if (others.length === 0) {
        const statement = `${this.getDisplayName()}です。`;
        return statement;
      }
      
      return `${this.getDisplayName()}です。`;
    }
    
    // 2日目以降も村人のふりを続ける
    this.incrementStatementCount(day);
    return this.generateWerewolfStatement(day, alivePlayers);
  }

  private generateWerewolfStatement(_day: number, alivePlayers: Player[]): string {
    // 村人陣営を疑って混乱させる - より根拠付きの発言を
    const villagers = alivePlayers.filter(p => p.id !== this.id && p.team !== Team.WEREWOLF);
    
    if (villagers.length === 0) {
      return '情報が不足していますね。もう少し様子を見ましょう。';
    }
    
    const target = villagers[Math.floor(Math.random() * villagers.length)];
    
    const statements = [''];

    this.addSuspicion(target.id, 1);

    return statements[Math.floor(Math.random() * statements.length)];
  }

  /**
   * 人狼は疑われた時により強く弁明する
   */
  protected generateUserResponse(userStatement: Statement, _alivePlayers: Player[], _day: number): string {
    const content = userStatement.content;
    
    // 自分が疑われた場合の強い弁明
    if (this.checkIfUserSuspectedMe(userStatement)) {
      const excuses = [
        'すみません、初日で判断材料が少なくて....。誤解だったかもしれません。',
        '発言のタイミングが少し気になっただけです。深い意味はありません。',
        '最初は誰もが疑わしいですからね。もう少し話を聞かせてください。',
      ];
      return excuses[Math.floor(Math.random() * excuses.length)];
    }
    
    // 役職に関する質問への反応
    if (/役職|占い|霊能者|狩人|CO/.test(content)) {
      return 'そうですね、役職者の情報は重要ですね。慎重に見ていきましょう。';
    }
    
    // 投票に関する質問
    if (/投票|吊る|処刑|指定/.test(content)) {
      return 'まだ早いかもしれませんが、理由を聞かせてもらえますか？';
    }
    
    // 強い断定への反応
    if (/[！!]{2,}|絶対|確実|間違いない|明らか/.test(content)) {
      return 'その根拠は何ですか？気になります。';
    }
    
    // 急かす発言への反応
    if (/決めよう|決める|まとめ|結論|進めよう/.test(content)) {
      return 'もう少し議論したいところですが、どうでしょうか。';
    }
    
    // デフォルト
    return 'なるほど、その意見は参考になりますね。';
  }

  public vote(day: number, alivePlayers: Player[]): number {
    // 村人陣営をランダムに投票（ユーザーID=1は除外）
    const baseVillagers = alivePlayers.filter(p => p.id !== this.id && p.id !== 1 && p.team !== Team.WEREWOLF);
    let villagers = baseVillagers;
    if (day === 1 && this.day1VoteCandidates && this.day1VoteCandidates.length > 0) {
      const restricted = baseVillagers.filter(p => this.day1VoteCandidates!.includes(p.id));
      if (restricted.length > 0) {
        villagers = restricted;
      }
    }
    
    if (villagers.length === 0) {
      const targets = alivePlayers.filter(p => p.id !== this.id && p.id !== 1);
      if (targets.length === 0) return this.id;
      return targets[Math.floor(Math.random() * targets.length)].id;
    }
    
    const target = villagers[Math.floor(Math.random() * villagers.length)];
    
    this.thoughtLog.push({
      day,
      thought: `${this.formatPlayerName(target)}に投票（村人を減らす）`
    });
    
    return target.id;
  }

  public nightAction(day: number, alivePlayers: Player[]): number | null {
    // (仕様)
    // - まず、狩人COしている生存者がいれば最優先で襲撃
    // - 攻撃回数ごとに優先度が変わる（1回目／2回目／3回目以降）

    const nonWere = alivePlayers.filter(p => p.id !== this.id && p.team !== Team.WEREWOLF);
    if (nonWere.length === 0) return null;

    // 常に最優先: 生存する狩人CO者（自分が認識しているCO情報で判定）
    const knightCOIds = new Set<number>();
    this.coInfoList.forEach(ci => { if (ci.claimedRole === Role.KNIGHT) knightCOIds.add(ci.playerId); });
    const aliveKnightCOs = nonWere.filter(p => knightCOIds.has(p.id));
    if (aliveKnightCOs.length > 0) {
      const chosen = aliveKnightCOs[Math.floor(Math.random() * aliveKnightCOs.length)];
      this.attackHistory.push({ day, targetId: chosen.id });
      this.thoughtLog.push({ day, thought: `${this.formatPlayerName(chosen)}を襲撃対象に選択（狩人CO優先）` });
      return chosen.id;
    }

    // attackIndex: 次の攻撃が何回目に相当するか（1始まり）
    const attackIndex = this.attackHistory.length + 1;

    // 陣形情報（game.ts が配列に付与している可能性あり）
    const formation = (alivePlayers as any).formation as ('2-1'|'2-2'|'3-1') | undefined;

    const selectRandomExcluding = (arr: Player[]) => arr[Math.floor(Math.random() * arr.length)];

    let candidatePool: Player[] = [];

    const isRoleCO = (p: Player) => this.coInfoList.some(ci => ci.playerId === p.id && ci.claimedRole !== undefined && ci.claimedRole !== Role.KNIGHT);

    if (attackIndex === 1) {
      // 1回目
      if (formation === '2-1') {
        // 2-1: 人狼・ユーザー以外からランダム（userは既に除外されている配列で渡される）
        candidatePool = nonWere.slice();
      } else {
        // 3-1 または 2-2: 人狼、ユーザー、役職CO(狩人除く)以外
        candidatePool = nonWere.filter(p => !isRoleCO(p));
      }

      if (candidatePool.length === 0) candidatePool = nonWere.slice();

      const chosen = selectRandomExcluding(candidatePool);
      this.attackHistory.push({ day, targetId: chosen.id });
      this.thoughtLog.push({ day, thought: `${this.formatPlayerName(chosen)}を襲撃対象に選択（1回目ルール）` });
      return chosen.id;
    }

    // 2回目以降（2回目と3回目以降は同じロジック）
    // 2回目: 進行 → 白確 → 1回目と同じ条件
    // 3回目以降: 2回目と同じ

    // 進行候補（当日発言があるか発言回数が多い）
    const progressCandidates = nonWere.filter(p => {
      const count = (p as any).statementCountToday?.get?.(day) || 0;
      return count > 0 || (p as any).hasSpokenToday === true;
    });

    if (progressCandidates.length > 0) {
      // 上位1名を選ぶ
      progressCandidates.sort((a: Player, b: Player) => {
        const ca = (a as any).statementCountToday?.get?.(day) || 0;
        const cb = (b as any).statementCountToday?.get?.(day) || 0;
        return cb - ca;
      });
      const chosen = progressCandidates[0];
      this.attackHistory.push({ day, targetId: chosen.id });
      this.thoughtLog.push({ day, thought: `${this.formatPlayerName(chosen)}を襲撃対象に選択（進行優先）` });
      return chosen.id;
    }

    // 白確候補
    const whiteCandidates = nonWere.filter(p => this.confirmedHumans.has(p.id) || (p as any).confirmedWhite === true);
    if (whiteCandidates.length > 0) {
      const chosen = selectRandomExcluding(whiteCandidates);
      this.attackHistory.push({ day, targetId: chosen.id });
      this.thoughtLog.push({ day, thought: `${this.formatPlayerName(chosen)}を襲撃対象に選択（白確優先）` });
      return chosen.id;
    }

    // フォールバック: 1回目と同じ条件
    if (formation === '2-1') {
      candidatePool = nonWere.slice();
    } else {
      candidatePool = nonWere.filter(p => !isRoleCO(p));
    }
    if (candidatePool.length === 0) candidatePool = nonWere.slice();
    const chosen = selectRandomExcluding(candidatePool);
    this.attackHistory.push({ day, targetId: chosen.id });
    this.thoughtLog.push({ day, thought: `${this.formatPlayerName(chosen)}を襲撃対象に選択（フォールバック）` });
    return chosen.id;
  }
}

/**
 * 占い師クラス
 */
export class Seer extends Player {
  private divinationResults: Array<{day: number, targetId: number, result: DivinationResult}> = [];
  private nightActionHistory: Array<{day: number, variable: string | null, targetId: number | null}> = [];

  constructor(id: number, name: string, character?: Character) {
    super(id, name, Role.SEER, Team.VILLAGER, character);
  }

  /**
   * 占い結果を記録
   */
  public addDivinationResult(day: number, targetId: number, result: DivinationResult): void {
    try { console.log(`[TRACE addDivinationResult] seer=${this.id} day=${day} target=${targetId} result=${result}`); } catch(e) {}
    this.divinationResults.push({day, targetId, result});
  }

  public makeStatement(day: number, alivePlayers: Player[], userStatementPriority: number = 0): string {
    this.initializeSuspicionScores(alivePlayers);
    
    const statementCount = this.statementCountToday.get(day) || 0;
    
    // 初日は最大1回の発言に制限
    if (day === 1 && statementCount >= 1 && userStatementPriority === 0) {
      return '';
    }
    
    // 初日は慎重に振る舞う
    if (day === 1) {
      this.incrementStatementCount(day);
      const statement = `${this.getDisplayName()}です。`;
      return statement;
    }
    
    // 2日目以降、占い結果をCOするか判断
    if (day >= 2) {
      const werewolfResults = this.divinationResults.filter(r => r.result === DivinationResult.WEREWOLF);
      
      // 人狼を見つけた場合はCOする（50%の確率で）
      if (werewolfResults.length > 0 && Math.random() < 0.5) {
        const latestResult = werewolfResults[werewolfResults.length - 1];
        const target = alivePlayers.find(p => p.id === latestResult.targetId);
        
        if (target) {
          this.incrementStatementCount(day);
          return `占い師COします。${this.formatPlayerName(target)}を占いました。結果は人狼です。`;
        }
      }
    }
    
    this.incrementStatementCount(day);
    return this.generateSeerStatement(day, alivePlayers);
  }

  private generateSeerStatement(_day: number, alivePlayers: Player[]): string {
    // 占い結果を踏まえた慎重な発言
    const humanResults = this.divinationResults.filter(r => r.result === DivinationResult.HUMAN);
    
    if (humanResults.length > 0) {
      const target = alivePlayers.find(p => p.id === humanResults[0].targetId);
      if (target) {
        return '';
      }
    }
    
    return '慎重に状況を見極めたいですね。';
  }

  public vote(day: number, alivePlayers: Player[]): number {
    // 人狼結果が出たプレイヤーを優先的に投票
    const werewolfResults = this.divinationResults.filter(r => r.result === DivinationResult.WEREWOLF);
    
    if (werewolfResults.length > 0) {
      const latestWerewolf = werewolfResults[werewolfResults.length - 1];
      const target = alivePlayers.find(p => p.id === latestWerewolf.targetId);
      
      if (target) {
        this.thoughtLog.push({
          day,
          thought: `占い結果に基づき${this.formatPlayerName(target)}に投票`
        });
        return target.id;
      }
    }
    
    // 占い結果がない場合はランダム（ユーザーID=1は除外）
    const baseTargets = alivePlayers.filter(p => p.id !== this.id && p.id !== 1);
    if (baseTargets.length === 0) return this.id;
    let targets = baseTargets;
    if (day === 1 && this.day1VoteCandidates && this.day1VoteCandidates.length > 0) {
      const restricted = baseTargets.filter(p => this.day1VoteCandidates!.includes(p.id));
      if (restricted.length > 0) {
        targets = restricted;
      }
    }
    
    const target = targets[Math.floor(Math.random() * targets.length)];
    return target.id;
  }

  public nightAction(day: number, alivePlayers: Player[]): number | null {
    // 市長指定があればそれを優先して使う（使ったらクリア）
    try {
      const designated = (this as any).nextDesignateDivination;
      if (typeof designated === 'number') {
        try { (this as any).nextDesignateDivination = null; } catch (e) {}
        const tgt = alivePlayers.find(p => p.id === designated && p.isAlive() && p.id !== this.id);
        if (tgt) {
          try { this.nightActionHistory.push({ day, variable: 'designate', targetId: designated }); } catch (e) {}
          this.thoughtLog.push({ day, thought: `指定占い -> ${tgt.getDisplayName()}` });
          return designated;
        }
      }
    } catch (e) { /* ignore designate inspection errors */ }

    // 指定がない/デフォルト時: 自分が既に占ったプレイヤーを除いてランダム選択
    const alreadyDivined = new Set<number>(this.divinationResults.map(r => r.targetId));
    // Do not rely on announcedDivinationTargets; use divinationResults/fakeDivinationResults/nightActionHistory only
    try {
      const fdivs: Array<any> | undefined = (this as any).fakeDivinationResults;
      if (Array.isArray(fdivs)) fdivs.forEach(d => { if (d && typeof d.targetId === 'number') alreadyDivined.add(d.targetId); });
    } catch (e) { /* ignore */ }
    try {
      const nh: Array<any> = (this as any).nightActionHistory || [];
      nh.forEach(d => { if (d && typeof d.targetId === 'number') alreadyDivined.add(d.targetId); });
    } catch (e) { /* ignore */ }
    const candidates = alivePlayers.filter(p => p.id !== this.id && p.isAlive() && !alreadyDivined.has(p.id));

    // フォールバック: 未占い候補がいなければ、生存者から自分以外を選ぶ
    let pool = candidates.length > 0 ? candidates : alivePlayers.filter(p => p.id !== this.id && p.isAlive());
    if (pool.length === 0) return null;

    const chosen = pool[Math.floor(Math.random() * pool.length)];
    this.thoughtLog.push({ day, thought: `${this.formatPlayerName(chosen)}を占う` });
    try { console.log(`[DEBUG Seer.nightAction] seer=${this.id} day=${day} alreadyDivined=${Array.from(alreadyDivined)} pool=${pool.map(p=>p.id)} chosen=${chosen.id}`); } catch(e) {}
    return chosen.id;
  }
}

  /**
   * 霊能者クラス
   */
export class Medium extends Player {
  private mediumResults: Array<{day: number, targetId: number, result: MediumResult}> = [];

  constructor(id: number, name: string, character?: Character) {
    super(id, name, Role.MEDIUM, Team.VILLAGER, character);
  }

  /**
   * 霊能結果を記録
   */
  public addMediumResult(result: {day: number, targetId: number, result: MediumResult}): void {
    this.mediumResults.push(result);
  }

  public makeStatement(day: number, alivePlayers: Player[], userStatementPriority: number = 0): string {
    this.initializeSuspicionScores(alivePlayers);
    
    const statementCount = this.statementCountToday.get(day) || 0;
    
    // 初日は最大1回の発言に制限
    if (day === 1 && statementCount >= 1 && userStatementPriority === 0) {
      return '';
    }
    
    if (day === 1) {
      this.incrementStatementCount(day);
      return `${this.getDisplayName()}です。`;
    }
    
    // 2日目以降の自発的な霊能発言は無効化（AIによる自発COを行わない）
    this.incrementStatementCount(day);
    return '';
  }

  public vote(day: number, alivePlayers: Player[]): number {
    // ランダムに投票（ユーザーID=1は除外）
    const baseTargets = alivePlayers.filter(p => p.id !== this.id && p.id !== 1);
    if (baseTargets.length === 0) return this.id;
    let targets = baseTargets;
    if (day === 1 && this.day1VoteCandidates && this.day1VoteCandidates.length > 0) {
      const restricted = baseTargets.filter(p => this.day1VoteCandidates!.includes(p.id));
      if (restricted.length > 0) {
        targets = restricted;
      }
    }
    
    const target = targets[Math.floor(Math.random() * targets.length)];
    return target.id;
  }

  public nightAction(_day: number, _alivePlayers: Player[]): number | null {
    return null; // 霊能者は夜の能動的な行動なし
  }
}

/**
 * 狩人クラス
 */
export class Knight extends Player {
  private previousGuardTargetId: number | null = null;
  private guardHistory: Array<{day: number, targetId: number}> = [];

  constructor(id: number, name: string, character?: Character) {
    super(id, name, Role.KNIGHT, Team.VILLAGER, character);
  }

  public makeStatement(day: number, alivePlayers: Player[], userStatementPriority: number = 0): string {
    this.initializeSuspicionScores(alivePlayers);
    
    const statementCount = this.statementCountToday.get(day) || 0;
    
    // 初日は最大1回の発言に制限
    if (day === 1 && statementCount >= 1 && userStatementPriority === 0) {
      return '';
    }
    
    if (day === 1) {
      this.incrementStatementCount(day);
      return `${this.getDisplayName()}です。`;
    }
    
    this.incrementStatementCount(day);
    return '';
  }

  public vote(day: number, alivePlayers: Player[]): number {
    // ランダムに投票（ユーザーID=1は除外）
    const baseTargets = alivePlayers.filter(p => p.id !== this.id && p.id !== 1);
    if (baseTargets.length === 0) return this.id;
    let targets = baseTargets;
    if (day === 1 && this.day1VoteCandidates && this.day1VoteCandidates.length > 0) {
      const restricted = baseTargets.filter(p => this.day1VoteCandidates!.includes(p.id));
      if (restricted.length > 0) {
        targets = restricted;
      }
    }
    
    const target = targets[Math.floor(Math.random() * targets.length)];
    return target.id;
  }

  public nightAction(day: number, alivePlayers: Player[]): number | null {
    // 自分と前回護衛対象は除外
    const candidates = alivePlayers.filter(p => p.id !== this.id && p.id !== this.previousGuardTargetId);

    if (candidates.length === 0) return null;

    // 1) 進行（議論を進めている）を優先
    //    -> 発言回数が多い / 当日発言があるプレイヤーを進行候補とする
    const progressCandidates = candidates.filter(p => {
      const count = (p as any).statementCountToday?.get?.(day) || 0;
      return count > 0 || (p as any).hasSpokenToday === true;
    });

    // 2) 白確（占いで人間確定になった、もしくは直接フラグが立っている）を優先
    const whiteCandidates = candidates.filter(p => this.confirmedHumans.has(p.id) || (p as any).confirmedWhite === true);

    // 優先順: 進行かつ白確 > 白確 > 進行
    const both = candidates.filter(p => progressCandidates.includes(p) && whiteCandidates.includes(p));

    let chosen: Player | null = null;

    if (both.length > 0) {
      chosen = both[Math.floor(Math.random() * both.length)];
    } else if (whiteCandidates.length > 0) {
      chosen = whiteCandidates[Math.floor(Math.random() * whiteCandidates.length)];
    } else if (progressCandidates.length > 0) {
      // 発言回数の多い順で選ぶ（確率的に上位を選びやすくする）
      progressCandidates.sort((a: Player, b: Player) => {
        const ca = (a as any).statementCountToday?.get?.(day) || 0;
        const cb = (b as any).statementCountToday?.get?.(day) || 0;
        return cb - ca;
      });
      chosen = progressCandidates[0];
    }

    // 3) どれも該当しない場合は占い師CO / 霊能CO / 占いで白になった人を守る
    if (!chosen) {
      // 自分が受け取ったCO情報から占い師/霊能者COになったプレイヤーを抽出
      const coIds = new Set<number>();
      this.coInfoList.forEach(ci => {
        if (ci.claimedRole === Role.SEER || ci.claimedRole === Role.MEDIUM) {
          coIds.add(ci.playerId);
        }
      });

      const coCandidates = candidates.filter(p => coIds.has(p.id));
      if (coCandidates.length > 0) {
        chosen = coCandidates[Math.floor(Math.random() * coCandidates.length)];
      }
    }

    // 4) さらに該当がなければ、自身が受け取った占いの白（confirmedHumans）を守る
    if (!chosen) {
      const confirmed = candidates.filter(p => this.confirmedHumans.has(p.id));
      if (confirmed.length > 0) chosen = confirmed[Math.floor(Math.random() * confirmed.length)];
    }

    // 5) 最終フォールバック: 役職者優先（占い師/霊能者）またはランダム
    if (!chosen) {
      const roleTargets = candidates.filter(p => p.role === Role.SEER || p.role === Role.MEDIUM);
      if (roleTargets.length > 0 && Math.random() < 0.7) {
        chosen = roleTargets[Math.floor(Math.random() * roleTargets.length)];
      } else {
        chosen = candidates[Math.floor(Math.random() * candidates.length)];
      }
    }

    if (!chosen) return null;

    this.previousGuardTargetId = chosen.id;
    // 護衛メモを記録
    this.guardHistory.push({ day, targetId: chosen.id });
    this.thoughtLog.push({ day, thought: `${this.formatPlayerName(chosen)}を護衛` });
    return chosen.id;
  }
}

/**
 * 狂人クラス
 */
export class Madman extends Player {
  constructor(id: number, name: string, character?: Character) {
    super(id, name, Role.MADMAN, Team.WEREWOLF, character);
  }

  public makeStatement(day: number, alivePlayers: Player[], userStatementPriority: number = 0): string {
    this.initializeSuspicionScores(alivePlayers);
    
    const statementCount = this.statementCountToday.get(day) || 0;
    
    // 初日は最大1回の発言に制限
    if (day === 1 && statementCount >= 1 && userStatementPriority === 0) {
      return '';
    }
    
    if (day === 1) {
      this.incrementStatementCount(day);
      const statement = `${this.getDisplayName()}です。`;
      return statement;
    }
    
    this.incrementStatementCount(day);
    return this.generateMadmanStatement(day, alivePlayers);
  }

  private generateMadmanStatement(_day: number, alivePlayers: Player[]): string {
    // 村人陣営を疑って混乱させる（人狼をサポート）- 根拠付き
    const villagers = alivePlayers.filter(p => p.id !== this.id && p.team !== Team.WEREWOLF);
    
    if (villagers.length === 0) {
      return '状況がわかりません...。';
    }
    
    const target = villagers[Math.floor(Math.random() * villagers.length)];
    
    const statements = [''];

    this.addSuspicion(target.id, 1);

    return statements[Math.floor(Math.random() * statements.length)];
  }

  public vote(day: number, alivePlayers: Player[]): number {
    // 村人陣営をランダムに投票（人狼をサポート）（ユーザーID=1は除外）
    const baseVillagers = alivePlayers.filter(p => p.id !== this.id && p.id !== 1 && p.team !== Team.WEREWOLF);
    let villagers = baseVillagers;
    if (day === 1 && this.day1VoteCandidates && this.day1VoteCandidates.length > 0) {
      const restricted = baseVillagers.filter(p => this.day1VoteCandidates!.includes(p.id));
      if (restricted.length > 0) {
        villagers = restricted;
      }
    }
    
    if (villagers.length === 0) {
      const targets = alivePlayers.filter(p => p.id !== this.id && p.id !== 1);
      if (targets.length === 0) return this.id;
      return targets[Math.floor(Math.random() * targets.length)].id;
    }
    
    const target = villagers[Math.floor(Math.random() * villagers.length)];
    
    this.thoughtLog.push({
      day,
      thought: `${this.formatPlayerName(target)}に投票（村人陣営を混乱させる）`
    });
    
    return target.id;
  }

  public nightAction(_day: number, _alivePlayers: Player[]): number | null {
    return null; // 狂人は夜の行動なし
  }
}
