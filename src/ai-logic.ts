import { Player } from './player';
import { Statement, VoteRecord } from './types';

/**
 * AI思考ロジックを提供するユーティリティクラス
 * 今後、より高度な推論ロジックを実装する際に拡張する
 */
export class AILogic {
  /**
   * 疑わしいプレイヤーを分析
   * @param statements 発言ログ
   * @param voteHistory 投票履歴
   * @param alivePlayers 生存プレイヤー
   * @returns 疑わしさのスコアマップ（プレイヤーID → スコア）
   */
  public static analyzeSuspicion(
    _statements: Statement[],
    voteHistory: VoteRecord[],
    alivePlayers: Player[]
  ): Map<number, number> {
    const suspicionScores = new Map<number, number>();

    // 初期化
    alivePlayers.forEach(p => {
      suspicionScores.set(p.id, 0);
    });

    // 投票傾向から分析
    // 多く投票されている人は疑われている
    voteHistory.forEach(vote => {
      const currentScore = suspicionScores.get(vote.targetId) || 0;
      suspicionScores.set(vote.targetId, currentScore + 1);
    });

    return suspicionScores;
  }

  /**
   * ランダムにプレイヤーを選択（重み付き）
   * @param alivePlayers 生存プレイヤー
   * @param excludeIds 除外するプレイヤーID
   * @param weights 重みマップ（プレイヤーID → 重み）
   * @returns 選択されたプレイヤーID
   */
  public static selectPlayerWeighted(
    alivePlayers: Player[],
    excludeIds: number[],
    weights?: Map<number, number>
  ): number | null {
    const candidates = alivePlayers.filter(p => !excludeIds.includes(p.id));
    
    if (candidates.length === 0) {
      return null;
    }

    if (!weights) {
      // 重みなしの場合はランダム
      return candidates[Math.floor(Math.random() * candidates.length)].id;
    }

    // 重み付きランダム選択
    const totalWeight = candidates.reduce((sum, p) => {
      return sum + (weights.get(p.id) || 1);
    }, 0);

    let random = Math.random() * totalWeight;
    
    for (const candidate of candidates) {
      const weight = weights.get(candidate.id) || 1;
      random -= weight;
      if (random <= 0) {
        return candidate.id;
      }
    }

    return candidates[0].id;
  }

  /**
   * 発言から特定のキーワードを含む回数をカウント
   * @param statements 発言ログ
   * @param playerId プレイヤーID
   * @param keywords キーワードリスト
   * @returns カウント数
   */
  public static countKeywords(
    statements: Statement[],
    playerId: number,
    keywords: string[]
  ): number {
    const playerStatements = statements.filter(s => s.playerId === playerId);
    
    let count = 0;
    playerStatements.forEach(statement => {
      keywords.forEach(keyword => {
        if (statement.content.includes(keyword)) {
          count++;
        }
      });
    });

    return count;
  }

  /**
   * 単純な推論: 発言が少ない人は疑わしい
   * @param statements 発言ログ
   * @param alivePlayers 生存プレイヤー
   * @returns 疑わしさのスコアマップ
   */
  public static analyzeByStatementFrequency(
    statements: Statement[],
    alivePlayers: Player[]
  ): Map<number, number> {
    const scores = new Map<number, number>();
    const statementCounts = new Map<number, number>();

    // 発言回数を集計
    statements.forEach(s => {
      statementCounts.set(s.playerId, (statementCounts.get(s.playerId) || 0) + 1);
    });

    // 平均を計算
    const counts = Array.from(statementCounts.values());
    const average = counts.reduce((a, b) => a + b, 0) / counts.length;

    // 平均より少ない人にスコアを付ける
    alivePlayers.forEach(p => {
      const count = statementCounts.get(p.id) || 0;
      if (count < average) {
        scores.set(p.id, average - count);
      } else {
        scores.set(p.id, 0);
      }
    });

    return scores;
  }

  /**
   * ランダムな発言を生成するヘルパー
   * @param templates 発言テンプレートリスト
   * @returns 選択された発言
   */
  public static generateRandomStatement(templates: string[]): string {
    return templates[Math.floor(Math.random() * templates.length)];
  }
}
