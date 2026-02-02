import { Game } from './game';

/**
 * メインエントリーポイント
 */
async function main() {
  const forced = process.env.FORCE_FORMATION && ['2-1','2-2','3-1'].includes(process.env.FORCE_FORMATION) ? (process.env.FORCE_FORMATION as '2-1'|'2-2'|'3-1') : undefined;
  const game = new Game({ forcedFormation: forced });
  game.initialize();
  await game.run();
}

main().catch(error => {
  console.error('エラーが発生しました:', error);
  process.exit(1);
});
