import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const rootDir = resolve(process.cwd());
const configPath = resolve(rootDir, 'balance-config.json');
const outputDir = resolve(rootDir, 'docs', 'balance-graphs');

const cfg = JSON.parse(await readFile(configPath, 'utf8'));

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const round = (value, digits = 2) => Number(value.toFixed(digits));

const at = (t) => {
  const p = clamp(t / cfg.roundDurationSec, 0, 1);
  const spawnDelay =
    cfg.spawnDelayStartMs -
    (cfg.spawnDelayStartMs - cfg.spawnDelayMinMs) * Math.pow(p, cfg.spawnCurvePower);
  const dropSpeed =
    cfg.dropSpeedStart + (cfg.dropSpeedMax - cfg.dropSpeedStart) * Math.pow(p, cfg.speedCurvePower);
  const spawnCountRaw =
    cfg.spawnCountMin + (cfg.spawnCountMax - cfg.spawnCountMin) * Math.pow(p, cfg.spawnCountCurvePower);
  const spawnCount = Math.floor(spawnCountRaw);
  const catchScore = cfg.scorePerCatch + Math.round((spawnCount - 1) * cfg.scoreDifficultyFactor);

  return {
    t,
    p: round(p, 3),
    spawnDelay: round(spawnDelay, 2),
    dropSpeed: round(dropSpeed, 3),
    spawnCount,
    catchScore,
  };
};

const sampleCount = 101;
const samples = Array.from({ length: sampleCount }, (_, i) => {
  const t = (cfg.roundDurationSec * i) / (sampleCount - 1);
  return at(t);
});

await mkdir(outputDir, { recursive: true });

const charts = [
  {
    filename: 'spawn-delay.svg',
    title: 'Spawn Delay Curve',
    yLabel: 'ms',
    color: '#38bdf8',
    getY: (d) => d.spawnDelay,
    yMin: cfg.spawnDelayMinMs,
    yMax: cfg.spawnDelayStartMs,
  },
  {
    filename: 'drop-speed.svg',
    title: 'Drop Speed Curve',
    yLabel: 'speed',
    color: '#22c55e',
    getY: (d) => d.dropSpeed,
    yMin: cfg.dropSpeedStart,
    yMax: cfg.dropSpeedMax,
  },
  {
    filename: 'spawn-count.svg',
    title: 'Spawn Count Curve',
    yLabel: 'count',
    color: '#f59e0b',
    getY: (d) => d.spawnCount,
    yMin: cfg.spawnCountMin,
    yMax: cfg.spawnCountMax,
  },
  {
    filename: 'catch-score.svg',
    title: 'Catch Score Curve',
    yLabel: 'score',
    color: '#a855f7',
    getY: (d) => d.catchScore,
    yMin: Math.min(...samples.map((d) => d.catchScore)),
    yMax: Math.max(...samples.map((d) => d.catchScore)),
  },
];

for (const chart of charts) {
  const svg = buildSvg({
    width: 860,
    height: 420,
    title: chart.title,
    yLabel: chart.yLabel,
    color: chart.color,
    points: samples.map((d) => [d.t, chart.getY(d)]),
    xMin: 0,
    xMax: cfg.roundDurationSec,
    yMin: chart.yMin,
    yMax: chart.yMax,
  });

  await writeFile(resolve(outputDir, chart.filename), svg, 'utf8');
}

const keyTimes = [0, 10, 25, 40, 50, 75, 100].map((t) => at(Math.min(t, cfg.roundDurationSec)));
const rows = keyTimes
  .map(
    (d) =>
      `| ${round(d.t, 0)} | ${d.p} | ${round(d.spawnDelay, 0)} | ${round(d.dropSpeed, 2)} | ${d.spawnCount} | ${d.catchScore} |`,
  )
  .join('\n');

const report = `# Balance Curve Snapshot

Generated from \`balance-config.json\`.

| t(sec) | p | spawnDelay(ms) | dropSpeed | spawnCount | catchScore |
|---:|---:|---:|---:|---:|---:|
${rows}
`;

await writeFile(resolve(outputDir, 'snapshot.md'), report, 'utf8');

console.log('Balance graphs generated at docs/balance-graphs');

function buildSvg({
  width,
  height,
  title,
  yLabel,
  color,
  points,
  xMin,
  xMax,
  yMin,
  yMax,
}) {
  const margin = { top: 44, right: 28, bottom: 42, left: 58 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const safeYMax = yMax === yMin ? yMin + 1 : yMax;

  const xToPx = (x) => margin.left + ((x - xMin) / (xMax - xMin)) * plotW;
  const yToPx = (y) => margin.top + plotH - ((y - yMin) / (safeYMax - yMin)) * plotH;

  const path = points
    .map(([x, y], idx) => `${idx === 0 ? 'M' : 'L'} ${xToPx(x).toFixed(2)} ${yToPx(y).toFixed(2)}`)
    .join(' ');

  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((r) => xMin + (xMax - xMin) * r);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((r) => yMin + (safeYMax - yMin) * r);

  const gridLines = [
    ...xTicks.map((x) => {
      const px = xToPx(x);
      return `<line x1="${px}" y1="${margin.top}" x2="${px}" y2="${margin.top + plotH}" stroke="#334155" stroke-width="1"/>`;
    }),
    ...yTicks.map((y) => {
      const py = yToPx(y);
      return `<line x1="${margin.left}" y1="${py}" x2="${margin.left + plotW}" y2="${py}" stroke="#334155" stroke-width="1"/>`;
    }),
  ].join('');

  const xLabels = xTicks
    .map((x) => {
      const px = xToPx(x);
      return `<text x="${px}" y="${height - 16}" fill="#cbd5e1" font-size="11" text-anchor="middle">${round(x, 0)}</text>`;
    })
    .join('');

  const yLabels = yTicks
    .map((y) => {
      const py = yToPx(y);
      return `<text x="${margin.left - 8}" y="${py + 4}" fill="#cbd5e1" font-size="11" text-anchor="end">${round(y, 2)}</text>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#020617"/>
  <text x="${width / 2}" y="24" fill="#f8fafc" font-size="18" text-anchor="middle">${title}</text>
  <text x="${width / 2}" y="${height - 2}" fill="#94a3b8" font-size="11" text-anchor="middle">time (sec)</text>
  <text x="16" y="${height / 2}" fill="#94a3b8" font-size="11" transform="rotate(-90 16 ${height / 2})" text-anchor="middle">${yLabel}</text>
  ${gridLines}
  <rect x="${margin.left}" y="${margin.top}" width="${plotW}" height="${plotH}" fill="none" stroke="#475569" stroke-width="1.2"/>
  <path d="${path}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
  ${xLabels}
  ${yLabels}
</svg>`;
}
