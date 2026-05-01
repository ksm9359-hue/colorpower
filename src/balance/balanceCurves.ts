import type { BalanceConfig } from './balanceConfig';

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

export const normalizedTime = (elapsedSeconds: number, cfg: BalanceConfig): number =>
  clamp(elapsedSeconds / cfg.roundDurationSec, 0, 1);

export const spawnDelayMs = (elapsedSeconds: number, cfg: BalanceConfig): number => {
  const p = normalizedTime(elapsedSeconds, cfg);
  return (
    cfg.spawnDelayStartMs -
    (cfg.spawnDelayStartMs - cfg.spawnDelayMinMs) * Math.pow(p, cfg.spawnCurvePower)
  );
};

export const dropSpeed = (elapsedSeconds: number, cfg: BalanceConfig): number => {
  const p = normalizedTime(elapsedSeconds, cfg);
  return cfg.dropSpeedStart + (cfg.dropSpeedMax - cfg.dropSpeedStart) * Math.pow(p, cfg.speedCurvePower);
};

export const spawnCount = (elapsedSeconds: number, cfg: BalanceConfig): number => {
  const p = normalizedTime(elapsedSeconds, cfg);
  const raw =
    cfg.spawnCountMin + (cfg.spawnCountMax - cfg.spawnCountMin) * Math.pow(p, cfg.spawnCountCurvePower);
  return Math.floor(raw);
};

export const catchScore = (elapsedSeconds: number, cfg: BalanceConfig): number => {
  const count = spawnCount(elapsedSeconds, cfg);
  const difficultyOffset = Math.round((count - 1) * cfg.scoreDifficultyFactor);
  return cfg.scorePerCatch + difficultyOffset;
};
