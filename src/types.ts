/**
 * 役職タイプ
 */
export enum Role {
  VILLAGER = 'VILLAGER',        // 村人
  WEREWOLF = 'WEREWOLF',        // 人狼
  SEER = 'SEER',                // 占い師
  MEDIUM = 'MEDIUM',            // 霊能者
  KNIGHT = 'KNIGHT',            // 狩人
  HUNTER = 'HUNTER',            // 狩人 (if used elsewhere)
  MADMAN = 'MADMAN',            // 狂人
}

/**
 * 陣営タイプ
 */
export enum Team {
  VILLAGER = 'VILLAGER',        // 村人陣営
  WEREWOLF = 'WEREWOLF',        // 人狼陣営
}

/**
 * プレイヤーの状態
 */
export enum PlayerStatus {
  ALIVE = 'ALIVE',              // 生存
  DEAD = 'DEAD',                // 死亡
}

/**
 * ゲームフェーズ
 */
export enum Phase {
  DAY = 'DAY',                  // 昼フェーズ
  NIGHT = 'NIGHT',              // 夜フェーズ
}

/**
 * 占い結果
 */
export enum DivinationResult {
  HUMAN = 'HUMAN',              // 人間
  WEREWOLF = 'WEREWOLF',        // 人狼
}

/**
 * 霊能結果
 */
export enum MediumResult {
  HUMAN = 'HUMAN',              // 人間
  WEREWOLF = 'WEREWOLF',        // 人狼
}

/**
 * 死因
 */
export enum DeathReason {
  EXECUTION = 'EXECUTION',      // 処刑
  ATTACK = 'ATTACK',            // 襲撃
}

/**
 * 発言の分類
 */
export enum StatementCategory {
  COUNTER_ARGUMENT = 'COUNTER_ARGUMENT',        // 反論 - 他人の発言への反対
  PAST_ACTION_MENTION = 'PAST_ACTION_MENTION',  // 過去行動言及 - 前日の投票や言動への言及
  QUESTION = 'QUESTION',                        // 質問 - 他人への質問
  INFORMATION_ORGANIZATION = 'INFORMATION_ORGANIZATION', // 情報整理 - 状況分析、新情報の提示
}

/**
 * 発言タイプ
 */
export interface Statement {
  day: number;
  playerId: number;
  playerName: string;
  content: string;
  category?: StatementCategory;                 // 発言の分類（オプション）
  reasoning?: string;                           // 発言の理由や根拠（オプション）
  key?: string;                                 // internal key for template/type (e.g. 'ask_reason')
}

/**
 * 投票記録
 */
export interface VoteRecord {
  day: number;
  voterId: number;
  targetId: number;
}

/**
 * 占い結果の記録
 */
export interface DivinationRecord {
  day: number;
  targetId: number;
  result: DivinationResult;
}

/**
 * 霊能結果の記録
 */
export interface MediumRecord {
  day: number;
  targetId: number;
  result: MediumResult;
}

/**
 * 夜の行動結果
 */
export interface NightActionResult {
  attackTargetId: number | null;        // 襲撃対象
  guardTargetId: number | null;         // 護衛対象
  divinationTargetId: number | null;    // 占い対象
  divinationResult: DivinationResult | null;
  attackedPlayerId: number | null;      // 実際に襲撃されたプレイヤー
  isGuardSuccess: boolean;              // 護衛成功
}

/**
 * ゲーム結果
 */
export interface GameResult {
  winner: Team;
  day: number;
  reason: string;
}

/**
 * CO検出結果のタイプ
 */
export enum COType {
  TRUE_CO = 'TRUE_CO',                  // 有効なCO（役職を明示的に宣言）
  CONTRADICTORY_CO = 'CONTRADICTORY_CO', // 矛盾CO（同一日に複数役職CO）
  NOT_CO = 'NOT_CO',                    // CO ではない
}

/**
 * CO（カミングアウト）情報
 */
export interface COInfo {
  playerId: number;
  playerName: string;
  claimedRole: Role;
  day: number;
  coType: COType;                       // CO検出のタイプ
}

/**
 * 投票理由
 */
export interface VoteReason {
  voterId: number;
  targetId: number;
  reason: string;
  day: number;
}
