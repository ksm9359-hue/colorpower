import './style.css';
import Phaser from 'phaser';
import { balanceConfig } from './balance/balanceConfig';
import { catchScore, dropSpeed, normalizedTime, spawnCount, spawnDelayMs } from './balance/balanceCurves';

type FallingDrop = Phaser.GameObjects.Image & {
  colorIndex: number;
  speed: number;
};

type RankingEntry = {
  name: string;
  score: number;
  createdAt?: number;
};

const RANKING_KEY = 'colorpower:ranking:v1';
const SUBMIT_GUARD_KEY = 'colorpower:submit-guard:v1';
const MAX_RANKING = 10;
const SCORE_MIN = 0;
const SCORE_MAX = 50000;
const SUBMIT_COOLDOWN_MS = 2500;
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
let sfxAudioContext: AudioContext | null = null;

function normalizeName(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) {
    return 'PLAYER';
  }
  return trimmed.slice(0, 10);
}

function loadLocalRanking(): RankingEntry[] {
  const raw = localStorage.getItem(RANKING_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as RankingEntry[];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed;
  } catch {
    return [];
  }
}

function sortRanking(entries: RankingEntry[]): RankingEntry[] {
  return [...entries].sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    return (a.createdAt ?? 0) - (b.createdAt ?? 0);
  });
}

function saveLocalRanking(entries: RankingEntry[]): void {
  localStorage.setItem(RANKING_KEY, JSON.stringify(sortRanking(entries).slice(0, MAX_RANKING)));
}

function upsertLocalRankingByName(entries: RankingEntry[], name: string, score: number): RankingEntry[] {
  const normalizedName = normalizeName(name);
  const targetIndex = entries.findIndex((entry) => entry.name === normalizedName);
  if (targetIndex === -1) {
    return [
      ...entries,
      {
        name: normalizedName,
        score,
        createdAt: Date.now(),
      },
    ];
  }

  const target = entries[targetIndex];
  if (score <= target.score) {
    return entries;
  }

  const next = [...entries];
  next[targetIndex] = {
    ...target,
    score,
  };
  return next;
}

function hasRemoteRankingConfig(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

function canSubmitScoreNow(name: string): boolean {
  const now = Date.now();
  const raw = localStorage.getItem(SUBMIT_GUARD_KEY);
  const state = raw ? (JSON.parse(raw) as Record<string, number>) : {};
  const lastAt = state[name] ?? 0;
  if (now - lastAt < SUBMIT_COOLDOWN_MS) {
    return false;
  }
  state[name] = now;
  localStorage.setItem(SUBMIT_GUARD_KEY, JSON.stringify(state));
  return true;
}

function createSupabaseHeaders(): HeadersInit {
  return {
    apikey: SUPABASE_ANON_KEY!,
    Authorization: `Bearer ${SUPABASE_ANON_KEY!}`,
    'Content-Type': 'application/json',
  };
}

async function fetchRemoteTopRanking(): Promise<RankingEntry[]> {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/scores?select=name,score,updated_at&order=score.desc,updated_at.asc&limit=${MAX_RANKING}`,
    { headers: createSupabaseHeaders() },
  );
  if (!response.ok) {
    throw new Error('Failed to load remote ranking');
  }
  const rows = (await response.json()) as Array<{ name: string; score: number; updated_at?: string }>;
  return rows.map((row) => ({ name: row.name, score: row.score }));
}

async function fetchRemotePlayerScore(name: string): Promise<number | null> {
  const encoded = encodeURIComponent(name);
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/scores?select=score&name=eq.${encoded}&limit=1`,
    { headers: createSupabaseHeaders() },
  );
  if (!response.ok) {
    throw new Error('Failed to load player score');
  }
  const rows = (await response.json()) as Array<{ score: number }>;
  return rows.length > 0 ? rows[0].score : null;
}

async function upsertRemoteRankingByName(name: string, score: number): Promise<void> {
  const currentScore = await fetchRemotePlayerScore(name);
  if (currentScore !== null && score <= currentScore) {
    return;
  }
  const response = await fetch(`${SUPABASE_URL}/rest/v1/scores?on_conflict=name`, {
    method: 'POST',
    headers: {
      ...createSupabaseHeaders(),
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify([{ name, score }]),
  });
  if (!response.ok) {
    throw new Error('Failed to update remote ranking');
  }
}

async function getRanking(): Promise<RankingEntry[]> {
  if (hasRemoteRankingConfig()) {
    try {
      return await fetchRemoteTopRanking();
    } catch {
      return loadLocalRanking();
    }
  }
  return loadLocalRanking();
}

async function submitScoreByName(name: string, score: number): Promise<RankingEntry[]> {
  const normalizedName = normalizeName(name);
  const normalizedScore = Math.floor(score);
  if (normalizedScore < SCORE_MIN || normalizedScore > SCORE_MAX) {
    return getRanking();
  }
  if (!canSubmitScoreNow(normalizedName)) {
    return getRanking();
  }

  if (hasRemoteRankingConfig()) {
    try {
      await upsertRemoteRankingByName(normalizedName, normalizedScore);
      return await fetchRemoteTopRanking();
    } catch {
      const localUpdated = upsertLocalRankingByName(loadLocalRanking(), normalizedName, normalizedScore);
      saveLocalRanking(localUpdated);
      return sortRanking(localUpdated).slice(0, MAX_RANKING);
    }
  }
  const localUpdated = upsertLocalRankingByName(loadLocalRanking(), normalizedName, normalizedScore);
  saveLocalRanking(localUpdated);
  return sortRanking(localUpdated).slice(0, MAX_RANKING);
}

function formatRanking(entries: RankingEntry[]): string {
  if (entries.length === 0) {
    return '1. --- 0';
  }
  return entries
    .slice(0, MAX_RANKING)
    .map((entry, index) => `${index + 1}. ${entry.name.padEnd(10, ' ')} ${entry.score}`)
    .join('\n');
}

function getSfxContext(): AudioContext | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const AudioCtx = window.AudioContext;
  if (!AudioCtx) {
    return null;
  }
  if (!sfxAudioContext) {
    sfxAudioContext = new AudioCtx();
  }
  return sfxAudioContext;
}

function playAttachSfx(): void {
  const ctx = getSfxContext();
  if (!ctx) {
    return;
  }
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(480, now);
  osc.frequency.exponentialRampToValueAtTime(360, now + 0.06);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.14, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.09);
}

function playMatchBonusSfx(): void {
  const ctx = getSfxContext();
  if (!ctx) {
    return;
  }
  const now = ctx.currentTime;
  const frequencies = [523.25, 659.25, 783.99];
  frequencies.forEach((freq, index) => {
    const start = now + index * 0.07;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.16, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.12);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.13);
  });
}

function playFailSfx(): void {
  const ctx = getSfxContext();
  if (!ctx) {
    return;
  }
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(220, now);
  osc.frequency.exponentialRampToValueAtTime(96, now + 0.32);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.2, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.36);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.38);
}

class ReadyScene extends Phaser.Scene {
  private nameInput!: Phaser.GameObjects.DOMElement;
  private infoPanel?: Phaser.GameObjects.Container;

  constructor() {
    super('ready-scene');
  }

  create(data: { playerName?: string } = {}): void {
    const width = this.scale.width;
    const defaultName = normalizeName(data.playerName ?? 'PLAYER');
    this.registry.set('playerName', defaultName);

    this.add.text(width / 2, 52, '내 똥 칼라파워!', { fontSize: '34px', color: '#f8fafc' }).setOrigin(0.5);

    this.add.text(42, 102, 'TOP 10 RANKING', { fontSize: '18px', color: '#fbbf24' });
    const rankingText = this.add.text(42, 130, '로딩 중...', {
      fontSize: '16px',
      color: '#e2e8f0',
      lineSpacing: 7,
      fontFamily: 'monospace',
    });
    void getRanking().then((ranking) => {
      rankingText.setText(formatRanking(ranking));
    });

    this.nameInput = this.add.dom(
      width / 2,
      470,
      'input',
      'width:260px;height:40px;border-radius:8px;border:1px solid #475569;padding:0 10px;background:#0f172a;color:#f8fafc;font-size:16px;',
      defaultName,
    );
    (this.nameInput.node as HTMLInputElement).placeholder = '플레이어 이름을 입력하세요';

    const startButton = this.add.dom(
      width / 2,
      525,
      'button',
      'width:260px;height:42px;border-radius:10px;border:1px solid #334155;background:#22c55e;color:#052e16;font-size:16px;font-weight:700;cursor:pointer;',
      '게임 시작',
    );

    startButton.addListener('click');
    startButton.on('click', () => {
      const element = this.nameInput.node as HTMLInputElement;
      const playerName = normalizeName(element.value);
      element.value = playerName;
      this.registry.set('playerName', playerName);
      this.scene.start('game-scene', { playerName });
    });

    const infoIcon = this.add
      .text(width - 28, 32, 'ⓘ', { fontSize: '28px', color: '#93c5fd' })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    infoIcon.on('pointerdown', () => {
      this.toggleInfoPopup();
    });
  }

  private toggleInfoPopup(): void {
    if (this.infoPanel) {
      this.infoPanel.destroy(true);
      this.infoPanel = undefined;
      return;
    }
    const width = this.scale.width;
    const panelBg = this.add.rectangle(width / 2, 300, 340, 120, 0x0b1220, 0.96).setStrokeStyle(2, 0x334155);
    const panelText = this.add
      .text(width / 2, 300, '같은 컬러를 3개 모아\n최고 점수를 달성하세요.', {
        fontSize: '20px',
        align: 'center',
        color: '#f8fafc',
      })
      .setOrigin(0.5);
    this.infoPanel = this.add.container(0, 0, [panelBg, panelText]);
  }
}

class GameScene extends Phaser.Scene {
  private readonly cfg = balanceConfig;
  private readonly bgmRateMin = 1.0;
  private readonly bgmRateMax = 1.35;
  private readonly bgmRateCurvePower = 1.9;
  private readonly dropColors = [0xef4444, 0x3b82f6, 0x22c55e, 0xf59e0b, 0xa855f7];
  private player!: Phaser.GameObjects.Rectangle;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private keyA!: Phaser.Input.Keyboard.Key;
  private keyD!: Phaser.Input.Keyboard.Key;
  private playerName = 'PLAYER';
  private drops!: Phaser.GameObjects.Group;
  private attachedDropsVisual!: Phaser.GameObjects.Group;
  private scoreText!: Phaser.GameObjects.Text;
  private score = 0;
  private totalAttached = 0;
  private attachedByColor = [0, 0, 0, 0, 0];
  private attachedItems: number[] = [];
  private isGameOver = false;
  private startedAtMs = 0;
  private nextSpawnAtMs = 0;
  private currentSpawnCount = 1;
  private touchStartX = 0;
  private touchDirection: -1 | 0 | 1 = 0;
  private bgm?: Phaser.Sound.BaseSound;

  constructor() {
    super('game-scene');
  }

  init(data: { playerName?: string } = {}): void {
    this.playerName = normalizeName(data.playerName ?? (this.registry.get('playerName') as string) ?? 'PLAYER');
  }

  preload(): void {
    if (!this.cache.audio.exists('bgm-main')) {
      this.load.audio('bgm-main', 'audio/bgm/main-theme.mp3');
    }
  }

  create(): void {
    this.score = 0;
    this.totalAttached = 0;
    this.attachedByColor = [0, 0, 0, 0, 0];
    this.attachedItems = [];
    this.isGameOver = false;
    this.nextSpawnAtMs = 0;
    this.currentSpawnCount = 1;
    this.touchDirection = 0;

    const height = this.scale.height;
    this.createDropTextures();

    this.player = this.add.rectangle(this.scale.width / 2, height - 42, 64, 22, 0x9ca3af);
    this.physics.add.existing(this.player);
    const playerBody = this.player.body as Phaser.Physics.Arcade.Body;
    playerBody.setCollideWorldBounds(true);

    this.drops = this.add.group();
    this.cursors = this.input.keyboard!.createCursorKeys();
    this.keyA = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.A);
    this.keyD = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.D);
    this.startedAtMs = this.time.now;
    this.attachedDropsVisual = this.add.group();

    this.scoreText = this.add.text(16, 16, 'Score: 0', {
      fontSize: '20px',
      color: '#f8fafc',
    });

    const topScoreText = this.add.text(16, 42, 'Rank #1: ...', {
      fontSize: '18px',
      color: '#cbd5e1',
    });
    void getRanking().then((ranking) => {
      const topScore = ranking[0]?.score ?? 0;
      topScoreText.setText(`Rank #1: ${topScore}`);
    });

    this.nextSpawnAtMs = this.time.now + spawnDelayMs(0, this.cfg);
    this.bgm = this.sound.add('bgm-main', {
      loop: true,
      volume: 0.42,
      rate: this.bgmRateMin,
    });
    this.sound.setRate(this.bgmRateMin);
    this.bgm.play();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.sound.setRate(1);
      if (this.bgm && this.bgm.isPlaying) {
        this.bgm.stop();
      }
      this.bgm?.destroy();
      this.bgm = undefined;
    });

    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      this.touchStartX = pointer.x;
      this.touchDirection = 0;
    });

    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (!pointer.isDown) {
        return;
      }

      const deltaX = pointer.x - this.touchStartX;
      if (deltaX > 8) {
        this.touchDirection = 1;
      } else if (deltaX < -8) {
        this.touchDirection = -1;
      } else {
        this.touchDirection = 0;
      }
    });

    this.input.on('pointerup', () => {
      this.touchDirection = 0;
    });
  }

  update(_time: number, delta: number): void {
    if (this.isGameOver) {
      return;
    }

    const body = this.player.body as Phaser.Physics.Arcade.Body;
    const moveSpeed = 360;
    body.setVelocityX(0);
    if (this.cursors.left.isDown || this.keyA.isDown || this.touchDirection === -1) {
      body.setVelocityX(-moveSpeed);
    }
    if (this.cursors.right.isDown || this.keyD.isDown || this.touchDirection === 1) {
      body.setVelocityX(moveSpeed);
    }

    const elapsedSeconds = (this.time.now - this.startedAtMs) / 1000;
    const progress = normalizedTime(elapsedSeconds, this.cfg);
    const bgmProgress = Math.pow(progress, this.bgmRateCurvePower);
    this.sound.setRate(Phaser.Math.Linear(this.bgmRateMin, this.bgmRateMax, bgmProgress));
    const nextDelay = spawnDelayMs(elapsedSeconds, this.cfg);
    this.currentSpawnCount = spawnCount(elapsedSeconds, this.cfg);
    if (this.time.now >= this.nextSpawnAtMs) {
      for (let i = 0; i < this.currentSpawnCount; i += 1) {
        this.spawnDrop(i);
      }
      this.nextSpawnAtMs = this.time.now + nextDelay;
    }

    const deltaFactor = delta / (1000 / 60);
    this.drops.getChildren().forEach((dropObject) => {
      const drop = dropObject as FallingDrop;
      drop.y += drop.speed * deltaFactor;

      if (Phaser.Geom.Intersects.RectangleToRectangle(drop.getBounds(), this.player.getBounds())) {
        this.collectDrop(drop.colorIndex);
        drop.destroy();
        return;
      }

      if (drop.y > this.scale.height + 30) {
        drop.destroy();
      }
    });

    this.updateAttachedVisualPositions();
  }

  private spawnDrop(indexInWave: number): void {
    if (this.isGameOver) {
      return;
    }

    const waveSpread = this.currentSpawnCount > 1 ? 14 * (this.currentSpawnCount - 1) : 0;
    const xBase = Phaser.Math.Between(20 + waveSpread, this.scale.width - 20 - waveSpread);
    const x = Phaser.Math.Clamp(xBase + indexInWave * 28 - waveSpread, 20, this.scale.width - 20);
    const colorIndex = Phaser.Math.Between(0, this.dropColors.length - 1);
    const elapsedSeconds = (this.time.now - this.startedAtMs) / 1000;
    const speed = dropSpeed(elapsedSeconds, this.cfg);
    const drop = this.add.image(x, -20, `drop-${colorIndex}`) as FallingDrop;
    drop.setDisplaySize(28, 28);
    drop.colorIndex = colorIndex;
    drop.speed = speed;
    this.drops.add(drop);
  }

  private collectDrop(colorIndex: number): void {
    this.totalAttached += 1;
    this.attachedByColor[colorIndex] += 1;
    this.attachedItems.push(colorIndex);
    playAttachSfx();
    const elapsedSeconds = (this.time.now - this.startedAtMs) / 1000;
    this.score += catchScore(elapsedSeconds, this.cfg);

    if (this.attachedByColor[colorIndex] >= 3) {
      this.attachedByColor[colorIndex] -= 3;
      this.totalAttached -= 3;
      this.removeThreeAttachedItems(colorIndex);
      this.score += this.cfg.matchBonusScore;
      playMatchBonusSfx();
      this.playMatchEffect(colorIndex);
    }

    this.scoreText.setText(`Score: ${this.score}`);
    this.refreshAttachedVisuals();

    if (this.totalAttached >= this.cfg.attachedLimit) {
      this.endGame();
    }
  }

  private removeThreeAttachedItems(colorIndex: number): void {
    let removed = 0;
    this.attachedItems = this.attachedItems.filter((itemColor) => {
      if (itemColor === colorIndex && removed < 3) {
        removed += 1;
        return false;
      }
      return true;
    });
  }

  private playMatchEffect(colorIndex: number): void {
    const effectX = this.player.x;
    const effectY = this.player.y - 50;

    const flash = this.add.circle(effectX, effectY, 12, this.dropColors[colorIndex], 0.85);
    this.tweens.add({
      targets: flash,
      scale: 3,
      alpha: 0,
      duration: 280,
      ease: 'Quad.easeOut',
      onComplete: () => flash.destroy(),
    });

    for (let i = 0; i < 8; i += 1) {
      const particle = this.add.rectangle(effectX, effectY, 6, 6, this.dropColors[colorIndex]);
      const angle = (Math.PI * 2 * i) / 8;
      const distance = 26 + Phaser.Math.Between(0, 16);
      const targetX = effectX + Math.cos(angle) * distance;
      const targetY = effectY + Math.sin(angle) * distance;

      this.tweens.add({
        targets: particle,
        x: targetX,
        y: targetY,
        angle: Phaser.Math.Between(-120, 120),
        alpha: 0,
        duration: 340,
        ease: 'Cubic.easeOut',
        onComplete: () => particle.destroy(),
      });
    }

    const bonusText = this.add.text(effectX, effectY - 14, `+${this.cfg.matchBonusScore} BONUS!`, {
      fontSize: '22px',
      color: '#fef08a',
      stroke: '#713f12',
      strokeThickness: 4,
      fontStyle: 'bold',
    }).setOrigin(0.5);

    this.tweens.add({
      targets: bonusText,
      y: effectY - 54,
      alpha: 0,
      scale: 1.2,
      duration: 620,
      ease: 'Sine.easeOut',
      onComplete: () => bonusText.destroy(),
    });
  }

  private refreshAttachedVisuals(): void {
    this.attachedDropsVisual.clear(true, true);

    this.attachedItems.forEach((colorIndex, itemIndex) => {
      const visual = this.add.image(0, 0, `drop-${colorIndex}`).setDisplaySize(14, 14);
      this.attachedDropsVisual.add(visual);

      const row = Math.floor(itemIndex / 5);
      const col = itemIndex % 5;
      const baseX = this.player.x - 28;
      const baseY = this.player.y - 24;
      visual.setPosition(baseX + col * 14, baseY - row * 14);
    });
  }

  private updateAttachedVisualPositions(): void {
    this.attachedDropsVisual.getChildren().forEach((child, itemIndex) => {
      const visual = child as Phaser.GameObjects.Image;
      const row = Math.floor(itemIndex / 5);
      const col = itemIndex % 5;
      const baseX = this.player.x - 28;
      const baseY = this.player.y - 24;
      visual.setPosition(baseX + col * 14, baseY - row * 14);
    });
  }

  private createDropTextures(): void {
    this.dropColors.forEach((color, index) => {
      const key = `drop-${index}`;
      if (this.textures.exists(key)) {
        return;
      }

      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return;
      }

      const fill = `#${color.toString(16).padStart(6, '0')}`;
      const shade = 'rgba(0, 0, 0, 0.18)';

      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(32, 10);
      ctx.bezierCurveTo(21, 16, 20, 22, 26, 27);
      ctx.bezierCurveTo(13, 30, 10, 40, 16, 47);
      ctx.bezierCurveTo(20, 52, 28, 54, 32, 54);
      ctx.bezierCurveTo(36, 54, 44, 52, 48, 47);
      ctx.bezierCurveTo(54, 40, 51, 30, 38, 27);
      ctx.bezierCurveTo(44, 22, 43, 16, 32, 10);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = shade;
      ctx.beginPath();
      ctx.ellipse(38, 40, 10, 6, 0.1, 0, Math.PI * 2);
      ctx.fill();

      this.textures.addCanvas(key, canvas);
    });
  }

  private endGame(): void {
    this.isGameOver = true;
    playFailSfx();
    this.scene.start('result-scene', {
      playerName: this.playerName,
      score: this.score,
    });
  }
}

class ResultScene extends Phaser.Scene {
  private playerName = 'PLAYER';
  private finalScore = 0;

  constructor() {
    super('result-scene');
  }

  init(data: { playerName?: string; score?: number } = {}): void {
    this.playerName = normalizeName(data.playerName ?? (this.registry.get('playerName') as string) ?? 'PLAYER');
    this.finalScore = data.score ?? 0;
  }

  create(): void {
    const width = this.scale.width;

    this.add.text(width / 2, 40, '게임 종료', { fontSize: '34px', color: '#f8fafc' }).setOrigin(0.5);
    const myResultText = this.add.text(width / 2, 86, `내 점수: ${this.finalScore} | 내 순위: 계산 중...`, {
      fontSize: '20px',
      color: '#fbbf24',
    }).setOrigin(0.5);

    this.add.text(42, 126, 'TOP 10 RANKING', { fontSize: '18px', color: '#fbbf24' });
    const rankingText = this.add.text(42, 154, '로딩 중...', {
      fontSize: '16px',
      color: '#e2e8f0',
      lineSpacing: 7,
      fontFamily: 'monospace',
    });
    void submitScoreByName(this.playerName, this.finalScore).then((top10) => {
      rankingText.setText(formatRanking(top10));
      const myRank = top10.findIndex((entry) => entry.name === this.playerName) + 1;
      const rankText = myRank > 0 ? `${myRank}위` : '10위 밖';
      myResultText.setText(`내 점수: ${this.finalScore} | 내 순위: ${rankText}`);
    });

    const confirmButton = this.add.dom(
      width / 2,
      540,
      'button',
      'width:260px;height:42px;border-radius:10px;border:1px solid #334155;background:#38bdf8;color:#082f49;font-size:16px;font-weight:700;cursor:pointer;',
      '확인 (준비 화면으로)',
    );

    confirmButton.addListener('click');
    confirmButton.on('click', () => {
      this.scene.start('ready-scene', { playerName: this.playerName });
    });
  }
}

document.querySelector<HTMLDivElement>('#app')!.innerHTML = '<div id="game-root"></div>';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 420,
  height: 640,
  backgroundColor: '#0f172a',
  parent: 'game-root',
  dom: {
    createContainer: true,
  },
  physics: {
    default: 'arcade',
    arcade: {
      debug: false,
    },
  },
  scene: [ReadyScene, GameScene, ResultScene],
};

new Phaser.Game(config);
