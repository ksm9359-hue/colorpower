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

type BalanceConfigV02 = {
  roundDurationSec: number;
  scorePerCatch: number;
  matchBonusScore: number;
  scoreDifficultyFactor: number;
  attachedLimit: number;
  spawnDelayBaseMs: number;
  spawnDelayMinMs: number;
  dropSpeedBase: number;
  dropSpeedMax: number;
  spawnCountBase: number;
  spawnCountMax: number;
};

const raw = balanceConfigJson as Partial<BalanceConfig & BalanceConfigV02>;

export const balanceConfig: BalanceConfig = {
  roundDurationSec: raw.roundDurationSec ?? 100,
  scorePerCatch: raw.scorePerCatch ?? 10,
  matchBonusScore: raw.matchBonusScore ?? 50,
  scoreDifficultyFactor: raw.scoreDifficultyFactor ?? 4,
  attachedLimit: raw.attachedLimit ?? 5,
  spawnDelayStartMs: raw.spawnDelayStartMs ?? raw.spawnDelayBaseMs ?? 760,
  spawnDelayMinMs: raw.spawnDelayMinMs ?? 260,
  spawnCurvePower: raw.spawnCurvePower ?? 1.95,
  dropSpeedStart: raw.dropSpeedStart ?? raw.dropSpeedBase ?? 1.0,
  dropSpeedMax: raw.dropSpeedMax ?? 7.2,
  speedCurvePower: raw.speedCurvePower ?? 1.65,
  spawnCountMin: raw.spawnCountMin ?? raw.spawnCountBase ?? 1,
  spawnCountMax: raw.spawnCountMax ?? 4,
  spawnCountCurvePower: raw.spawnCountCurvePower ?? 2.0,
};
