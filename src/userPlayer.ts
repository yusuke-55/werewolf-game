import { Player } from './player';
import { Role, Team } from './types';
import { Character } from './characters';

/**
 * ユーザープレイヤークラス
 */
export class UserPlayer extends Player {
  private isSpectator: boolean = false;
  private pendingVote: number | null = null;
  private pendingNightAction: number | null = null;

  constructor(id: number, name: string, role: Role, team: Team, character?: Character) {
    super(id, name, role, team, character);
    // ユーザープレイヤーは「あなた」という名前を保持
    this.name = name;
  }

  /**
   * ユーザーの表示名は登録名＋さん（ただし 'あなた' はそのまま）
   */
  public getDisplayName(): string {
    return this.name === 'あなた' ? 'あなた' : `${this.name}さん`;
  }

  /**
   * 観戦モードに設定
   */
  public setSpectatorMode(): void {
    this.isSpectator = true;
  }

  /**
   * 観戦モードかどうか
   */
  public isInSpectatorMode(): boolean {
    return this.isSpectator;
  }

  /**
   * ユーザーの発言（外部から設定）
   */
  public makeStatement(_day: number, _alivePlayers: Player[]): string {
    // ユーザーの発言は外部（UI）から入力されるため、ここでは空文字を返す
    // 実際の発言はイベント経由で処理される
    return '';
  }

  /**
   * ユーザーの投票を設定
   */
  public setPendingVote(targetId: number): void {
    this.pendingVote = targetId;
  }

  /**
   * ユーザーの投票を取得
   */
  public vote(_day: number, _alivePlayers: Player[]): number {
    if (this.pendingVote !== null) {
      const vote = this.pendingVote;
      this.pendingVote = null;
      return vote;
    }
    // ユーザーが投票しなかった場合は無投票（-1）
    return -1;
  }

  /**
   * ユーザーの夜行動を設定
   */
  public setPendingNightAction(targetId: number): void {
    this.pendingNightAction = targetId;
  }

  /**
   * ユーザーの夜行動を取得
   */
  public nightAction(_day: number, _alivePlayers: Player[]): number | null {
    if (this.pendingNightAction !== null) {
      const action = this.pendingNightAction;
      this.pendingNightAction = null;
      return action;
    }
    return null;
  }
}
