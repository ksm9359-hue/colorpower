import balanceConfigJson from '../../balance-config.json' with { type: 'json' };

export type BalanceConfig = {
  roundDurationSec: number;
  scorePerCatch: number;
  matchBonusScore: number;
  scoreDifficultyFactor: number;
  attachedLimit: number;
  spawnDelayStartMs: number;
  spawnDelayMinMs: number;
  spawnCurvePower: number;
  dropSpeedStart: number;
  dropSpeedMax: number;
  speedCurvePower: number;
  spawnCountMin: number;
  spawnCountMax: number;
  spawnCountCurvePower: number;
};

export const balanceConfig = balanceConfigJson as BalanceConfig;
