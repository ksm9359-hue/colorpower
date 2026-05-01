import './style.css';
import Phaser from 'phaser';
import { balanceConfig } from './balance/balanceConfig';
import { catchScore, dropSpeed, spawnCount, spawnDelayMs } from './balance/balanceCurves';
import balanceConfigRaw from '../balance-config.json' with { type: 'json' };

type FallingDrop = Phaser.GameObjects.Image & {
  colorIndex: number;
  speed: number;
  isBomb?: boolean;
  trailTickMs?: number;
};

type AttachedDrop = {
  colorIndex: number;
  isBomb: boolean;
};

type BombZone = {
  x: number;
  y: number;
  radius: number;
  expiresAtMs: number;
};

type RankingEntry = {
  name: string;
  score: number;
  createdAt?: number;
};

type PerkChoice = {
  id: string;
  label: string;
  apply: (scene: GameScene) => void;
};

type PerkToken = Phaser.GameObjects.Arc & {
  speed: number;
  perkId?: string;
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

function applyNeonText(text: Phaser.GameObjects.Text, color = '#67e8f9'): Phaser.GameObjects.Text {
  return text.setShadow(0, 0, color, 12, true, true);
}

function createNeonBackdrop(scene: Phaser.Scene): void {
  const { width, height } = scene.scale;
  scene.add.rectangle(width / 2, height / 2, width, height, 0x050816);
  scene.add.rectangle(width / 2, height / 2, width - 12, height - 12, 0x0a1024).setStrokeStyle(2, 0x22d3ee, 0.95);
  scene.add.rectangle(width / 2, height / 2, width - 22, height - 22, 0x070b1a).setStrokeStyle(1, 0xa855f7, 0.75);
}

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
  const getDisplayWidth = (value: string): number =>
    [...value].reduce((width, ch) => width + (/[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/.test(ch) ? 2 : 1), 0);
  const padEndDisplay = (value: string, targetWidth: number): string => {
    const currentWidth = getDisplayWidth(value);
    if (currentWidth >= targetWidth) {
      return value;
    }
    return value + ' '.repeat(targetWidth - currentWidth);
  };
  const maxNameWidth = entries
    .slice(0, MAX_RANKING)
    .reduce((max, entry) => Math.max(max, getDisplayWidth(entry.name)), 3);

  return entries
    .slice(0, MAX_RANKING)
    .map((entry, index) => {
      const nameColumn = padEndDisplay(entry.name, maxNameWidth + 2);
      const scoreColumn = entry.score.toString().padStart(6, ' ');
      return `${index + 1}. ${nameColumn}${scoreColumn}`;
    })
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

function playPerkPickupSfx(): void {
  const ctx = getSfxContext();
  if (!ctx) {
    return;
  }
  const now = ctx.currentTime;
  const notes = [659.25, 783.99, 987.77];
  notes.forEach((freq, index) => {
    const start = now + index * 0.05;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.14, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.11);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.12);
  });
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
    createNeonBackdrop(this);

    applyNeonText(
      this.add.text(width / 2, 82, '내 똥 칼라파워!', {
        fontSize: '34px',
        color: '#f8fafc',
        padding: { x: 0, y: 12 },
      }),
      '#a78bfa',
    ).setOrigin(0.5);

    applyNeonText(this.add.text(width / 2, 120, 'TOP 10 RANKING', { fontSize: '18px', color: '#facc15' }), '#facc15').setOrigin(
      0.5,
    );
    const rankingText = this.add.text(width / 2, 148, '로딩 중...', {
      fontSize: '16px',
      color: '#dbeafe',
      lineSpacing: 7,
      fontFamily: 'monospace',
      align: 'center',
    }).setOrigin(0.5, 0);
    applyNeonText(rankingText);
    void getRanking().then((ranking) => {
      rankingText.setText(formatRanking(ranking));
    });

    this.nameInput = this.add.dom(
      width / 2,
      470,
      'input',
      'width:260px;height:40px;border-radius:8px;border:1px solid #22d3ee;padding:0 10px;background:#0b1225;color:#f8fafc;font-size:16px;box-shadow:0 0 14px rgba(34,211,238,0.35);',
      defaultName,
    );
    (this.nameInput.node as HTMLInputElement).placeholder = '플레이어 이름을 입력하세요';

    const startButton = this.add.dom(
      width / 2,
      525,
      'button',
      'width:260px;height:42px;border-radius:10px;border:1px solid #22d3ee;background:#06b6d4;color:#062c38;font-size:16px;font-weight:700;cursor:pointer;box-shadow:0 0 14px rgba(34,211,238,0.45);',
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
      .text(width - 28, 32, '?', { fontSize: '30px', color: '#67e8f9' })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    applyNeonText(infoIcon);

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
    const panelBg = this.add.rectangle(width / 2, 332, 380, 170, 0x0b1220, 0.96).setStrokeStyle(2, 0x22d3ee);
    const panelText = this.add
      .text(
        width / 2,
        332,
        '1) 좌우로 이동해 컬러똥을 부착하고\n   점수를 올리세요.\n\n2) 같은 컬러 똥 3개를 부착하면\n   매칭하여 제거하고 점수 보너스를 획득합니다.',
        {
        fontSize: '14px',
        align: 'center',
        color: '#f8fafc',
        lineSpacing: 4,
      },
      )
      .setOrigin(0.5);
    applyNeonText(panelText, '#a78bfa');
    this.infoPanel = this.add.container(0, 0, [panelBg, panelText]);
  }
}

class GameScene extends Phaser.Scene {
  private readonly cfg = balanceConfig;
  private readonly roundCfg = balanceConfigRaw as Record<string, number | boolean>;
  private readonly bgmRateMin = 1.0;
  private readonly bgmRateMax = 1.35;
  private readonly dropColors = [0xef4444, 0x3b82f6, 0x22c55e, 0xf59e0b, 0xa855f7];
  private player!: Phaser.GameObjects.Rectangle;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private keyA!: Phaser.Input.Keyboard.Key;
  private keyD!: Phaser.Input.Keyboard.Key;
  private playerName = 'PLAYER';
  private drops!: Phaser.GameObjects.Group;
  private attachedDropsVisual!: Phaser.GameObjects.Group;
  private attachedCountText!: Phaser.GameObjects.Text;
  private scoreText!: Phaser.GameObjects.Text;
  private perkText!: Phaser.GameObjects.Text;
  private score = 0;
  private scoreDisplayValue = 0;
  private scoreTween?: Phaser.Tweens.Tween;
  private totalAttached = 0;
  private attachedByColor = [0, 0, 0, 0, 0];
  private attachedItems: AttachedDrop[] = [];
  private isGameOver = false;
  private startedAtMs = 0;
  private nextSpawnAtMs = 0;
  private currentSpawnCount = 1;
  private touchStartX = 0;
  private touchDirection: -1 | 0 | 1 = 0;
  private bgm?: Phaser.Sound.BaseSound;
  private moveSpeedBase = 250;
  private moveSpeedBonus = 0;
  private spawnDelayBonusMs = 0;
  private dropSpeedMultiplier = 1;
  private isPerkDropPhase = false;
  private perkMilestones = [250, 700, 1400, 2300, 3400, 4700, 6200, 7900];
  private nextPerkIndex = 0;
  private perkTokens: PerkToken[] = [];
  private perkLabels: Phaser.GameObjects.Text[] = [];
  private perkStacks: Record<string, number> = {};
  private perksTakenCount = 0;
  private bombUnlocked = false;
  private attachedLimitCurrent = 6;
  private matchBonusScoreCurrent = 100;
  private colorCatchBonusByType = [0, 0, 0, 0, 0];
  private colorMatchBonusByType = [0, 0, 0, 0, 0];
  private activePerkChoices: Array<PerkChoice & { maxStack: number }> = [];
  private activeBombZone?: BombZone;

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
    this.scoreDisplayValue = 0;
    this.totalAttached = 0;
    this.attachedByColor = [0, 0, 0, 0, 0];
    this.attachedItems = [];
    this.isGameOver = false;
    this.nextSpawnAtMs = 0;
    this.currentSpawnCount = 1;
    this.touchDirection = 0;
    this.isPerkDropPhase = false;
    this.nextPerkIndex = 0;
    this.perkTokens = [];
    this.perkLabels = [];
    this.perkStacks = {};
    this.perksTakenCount = 0;
    this.bombUnlocked = false;
    this.attachedLimitCurrent = this.cfg.attachedLimit;
    this.matchBonusScoreCurrent = this.cfg.matchBonusScore;
    this.colorCatchBonusByType = [0, 0, 0, 0, 0];
    this.colorMatchBonusByType = [0, 0, 0, 0, 0];
    this.activePerkChoices = [];
    this.activeBombZone = undefined;
    this.moveSpeedBonus = 0;
    this.spawnDelayBonusMs = 0;
    this.dropSpeedMultiplier = 1;
    createNeonBackdrop(this);

    const height = this.scale.height;
    this.createDropTextures();

    this.player = this.add
      .rectangle(this.scale.width / 2, height - 42, 64, 22, 0x22d3ee, 0.95)
      .setStrokeStyle(2, 0xa78bfa, 1);
    this.physics.add.existing(this.player);
    const playerBody = this.player.body as Phaser.Physics.Arcade.Body;
    playerBody.setCollideWorldBounds(true);

    this.drops = this.add.group();
    this.attachedCountText = this.add
      .text(this.player.x, this.player.y, `0/${this.attachedLimitCurrent}`, {
        fontSize: '13px',
        color: '#f8fafc',
        backgroundColor: '#0b1225',
        padding: { x: 4, y: 2 },
        align: 'center',
      })
      .setOrigin(0.5, 0.5);
    applyNeonText(this.attachedCountText, '#22d3ee');
    this.cursors = this.input.keyboard!.createCursorKeys();
    this.keyA = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.A);
    this.keyD = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.D);
    this.attachedDropsVisual = this.add.group();
    this.startedAtMs = this.time.now;

    this.scoreText = this.add.text(16, 16, 'Score: 0', {
      fontSize: '20px',
      color: '#67e8f9',
    });
    applyNeonText(this.scoreText, '#22d3ee');

    const topScoreText = this.add.text(16, 42, 'Rank #1: ...', {
      fontSize: '18px',
      color: '#dbeafe',
    });
    applyNeonText(topScoreText, '#a78bfa');
    void getRanking().then((ranking) => {
      const topScore = ranking[0]?.score ?? 0;
      topScoreText.setText(`Rank #1: ${topScore}`);
    });

    this.perkText = this.add.text(16, 68, `Next Perk: ${this.getNextPerkMilestone()}`, {
      fontSize: '18px',
      color: '#a5f3fc',
    });
    applyNeonText(this.perkText, '#22d3ee');

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
    const moveSpeed = this.moveSpeedBase + this.moveSpeedBonus;
    body.setVelocityX(0);
    if (this.cursors.left.isDown || this.keyA.isDown || this.touchDirection === -1) {
      body.setVelocityX(-moveSpeed);
    }
    if (this.cursors.right.isDown || this.keyD.isDown || this.touchDirection === 1) {
      body.setVelocityX(moveSpeed);
    }

    this.attachedCountText
      .setText(`${this.totalAttached}/${this.attachedLimitCurrent}`)
      .setPosition(this.player.x, this.player.y);

    if (this.isPerkDropPhase) {
      this.updatePerkDropPhase(delta);
      this.updateAttachedVisualPositions();
      return;
    }

    const elapsedSeconds = (this.time.now - this.startedAtMs) / 1000;
    const baseDropSpeed = dropSpeed(elapsedSeconds, this.cfg);
    const effectiveDropSpeed = baseDropSpeed * this.dropSpeedMultiplier;
    this.sound.setRate(this.getBgmRateForDropSpeed(effectiveDropSpeed));

    const nextDelay = Math.max(180, spawnDelayMs(elapsedSeconds, this.cfg) + this.spawnDelayBonusMs);
    this.currentSpawnCount = spawnCount(elapsedSeconds, this.cfg);
    if (this.time.now >= this.nextSpawnAtMs) {
      for (let i = 0; i < this.currentSpawnCount; i += 1) {
        this.spawnDrop(i, effectiveDropSpeed);
      }
      this.nextSpawnAtMs = this.time.now + nextDelay;
    }

    const deltaFactor = Phaser.Math.Clamp(delta / (1000 / 60), 0.6, 1.8);
    this.drops.getChildren().forEach((dropObject) => {
      const drop = dropObject as FallingDrop;
      drop.y += drop.speed * deltaFactor;
      if (drop.isBomb) {
        // Give bombs a subtle spin so they stand out.
        drop.angle += 4.2 * deltaFactor;
        drop.trailTickMs = (drop.trailTickMs ?? 0) - delta;
        if ((drop.trailTickMs ?? 0) <= 0) {
          drop.trailTickMs = 55;
          const tail = this.add.circle(drop.x, drop.y + 14, 6, this.dropColors[drop.colorIndex], 0.45);
          tail.setBlendMode(Phaser.BlendModes.ADD);
          this.tweens.add({
            targets: tail,
            y: drop.y + 26,
            scale: 0.35,
            alpha: 0,
            duration: 220,
            ease: 'Sine.easeOut',
            onComplete: () => tail.destroy(),
          });
        }
      }

      if (Phaser.Geom.Intersects.RectangleToRectangle(drop.getBounds(), this.player.getBounds())) {
        this.collectDrop(drop, elapsedSeconds);
        drop.destroy();
        return;
      }

      if (drop.y > this.scale.height + 30) {
        drop.destroy();
      }
    });

    this.applyBombZoneDamage(this.time.now);
    this.updateAttachedVisualPositions();
  }

  private spawnDrop(indexInWave: number, speed: number): void {
    if (this.isGameOver) {
      return;
    }

    const waveSpread = this.currentSpawnCount > 1 ? 14 * (this.currentSpawnCount - 1) : 0;
    const xBase = Phaser.Math.Between(20 + waveSpread, this.scale.width - 20 - waveSpread);
    const x = Phaser.Math.Clamp(xBase + indexInWave * 28 - waveSpread, 20, this.scale.width - 20);
    const bombChance = Number(this.roundCfg.bombSpawnChance ?? 0.06);
    const shouldSpawnBomb = this.bombUnlocked && Math.random() < bombChance;
    const colorIndex = Phaser.Math.Between(0, this.dropColors.length - 1);
    const dropKey = shouldSpawnBomb ? `drop-bomb-${colorIndex}` : `drop-${colorIndex}`;
    const drop = this.add.image(x, -20, dropKey) as FallingDrop;
    drop.setDisplaySize(shouldSpawnBomb ? 34 : 28, shouldSpawnBomb ? 34 : 28);
    drop.colorIndex = colorIndex;
    drop.isBomb = shouldSpawnBomb;
    drop.speed = speed;
    if (shouldSpawnBomb) {
      drop.alpha = 0.92;
      drop.trailTickMs = 0;
      drop.setBlendMode(Phaser.BlendModes.ADD);
      this.tweens.add({
        targets: drop,
        alpha: 0.5,
        duration: 170,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
      this.tweens.add({
        targets: drop,
        scaleX: 1.12,
        scaleY: 1.12,
        duration: 190,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }
    this.drops.add(drop);
  }

  private collectDrop(drop: FallingDrop, elapsedSeconds: number): void {
    const colorIndex = drop.colorIndex;
    this.totalAttached += 1;
    this.attachedByColor[colorIndex] += 1;
    this.attachedItems.push({ colorIndex, isBomb: Boolean(drop.isBomb) });
    playAttachSfx();
    this.score += catchScore(elapsedSeconds, this.cfg) + this.colorCatchBonusByType[colorIndex];

    if (this.attachedByColor[colorIndex] >= 3) {
      this.attachedByColor[colorIndex] -= 3;
      this.totalAttached -= 3;
      const removedItems = this.removeThreeAttachedItems(colorIndex);
      const matchBonus = this.matchBonusScoreCurrent + this.colorMatchBonusByType[colorIndex];
      this.score += matchBonus;
      playMatchBonusSfx();
      this.playMatchEffect(colorIndex, matchBonus);
      if (removedItems.some((item) => item.isBomb)) {
        this.collectBombDrop();
      }
    }

    this.animateScoreTextTo(this.score);
    this.refreshAttachedVisuals();

    if (this.totalAttached >= this.attachedLimitCurrent) {
      this.endGame();
      return;
    }

    if (this.score >= this.getNextPerkMilestone()) {
      this.enterPerkDropPhase();
    }
  }

  private collectBombDrop(): void {
    const centerX = this.player.x;
    const centerY = this.player.y;
    const radius = Number(this.roundCfg.bombExplosionRadius ?? 132);
    const afterglowMs = Number(this.roundCfg.bombAfterglowMs ?? 520);

    const immediateCleared = this.clearDropsInRadius(centerX, centerY, radius) + this.clearAttachedInRadius(centerX, centerY, radius);
    this.addBombScore(immediateCleared);
    this.refreshAttachedVisuals();
    this.activeBombZone = {
      x: centerX,
      y: centerY,
      radius,
      expiresAtMs: this.time.now + afterglowMs,
    };
    playMatchBonusSfx();
    this.playBombEffect(radius, afterglowMs);
  }

  private applyBombZoneDamage(nowMs: number): void {
    if (!this.activeBombZone) {
      return;
    }
    if (nowMs > this.activeBombZone.expiresAtMs) {
      this.activeBombZone = undefined;
      return;
    }

    const { x, y, radius } = this.activeBombZone;
    const cleared = this.clearDropsInRadius(x, y, radius) + this.clearAttachedInRadius(x, y, radius);
    if (cleared > 0) {
      this.addBombScore(cleared);
      this.refreshAttachedVisuals();
    }
  }

  private clearDropsInRadius(centerX: number, centerY: number, radius: number): number {
    let cleared = 0;
    this.drops.getChildren().forEach((dropObject) => {
      const drop = dropObject as FallingDrop;
      if (!drop.active) {
        return;
      }
      const distance = Phaser.Math.Distance.Between(centerX, centerY, drop.x, drop.y);
      if (distance <= radius) {
        cleared += 1;
        drop.destroy();
      }
    });
    return cleared;
  }

  private clearAttachedInRadius(centerX: number, centerY: number, radius: number): number {
    let cleared = 0;
    const kept: AttachedDrop[] = [];
    this.attachedItems.forEach((item, index) => {
      const point = this.getAttachedItemPosition(index);
      const distance = Phaser.Math.Distance.Between(centerX, centerY, point.x, point.y);
      if (distance <= radius) {
        cleared += 1;
        this.attachedByColor[item.colorIndex] = Math.max(0, this.attachedByColor[item.colorIndex] - 1);
      } else {
        kept.push(item);
      }
    });
    this.attachedItems = kept;
    this.totalAttached = kept.length;
    return cleared;
  }

  private addBombScore(clearedTotal: number): void {
    if (clearedTotal <= 0) {
      return;
    }
    const bonusFactor = Number(this.roundCfg.bombClearScoreFactor ?? 6);
    this.score += Math.round(clearedTotal * bonusFactor);
    this.animateScoreTextTo(this.score);
  }

  private animateScoreTextTo(targetScore: number): void {
    this.scoreTween?.remove();
    const from = this.scoreDisplayValue;
    this.scoreTween = this.tweens.addCounter({
      from,
      to: targetScore,
      duration: 180,
      ease: 'Cubic.easeOut',
      onUpdate: (tween) => {
        this.scoreDisplayValue = Math.floor(tween.getValue() ?? targetScore);
        this.scoreText.setText(`Score: ${this.scoreDisplayValue}`);
      },
      onComplete: () => {
        this.scoreDisplayValue = targetScore;
        this.scoreText.setText(`Score: ${targetScore}`);
      },
    });

    this.tweens.killTweensOf(this.scoreText);
    this.scoreText.setScale(1);
    this.tweens.add({
      targets: this.scoreText,
      scaleX: 1.12,
      scaleY: 1.12,
      duration: 80,
      yoyo: true,
      ease: 'Quad.easeOut',
    });
  }

  private removeThreeAttachedItems(colorIndex: number): AttachedDrop[] {
    let removed = 0;
    const removedItems: AttachedDrop[] = [];
    this.attachedItems = this.attachedItems.filter((item) => {
      if (item.colorIndex === colorIndex && removed < 3) {
        removed += 1;
        removedItems.push(item);
        return false;
      }
      return true;
    });
    return removedItems;
  }

  private playMatchEffect(colorIndex: number, bonusScore: number): void {
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

    const bonusText = this.add.text(effectX, effectY - 14, `+${bonusScore} BONUS!`, {
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

  private playBombEffect(radius: number, lingerMs: number): void {
    const effectX = this.player.x;
    const effectY = this.player.y;
    const flash = this.add.circle(effectX, effectY, 18, 0xf472b6, 0.9);
    this.tweens.add({
      targets: flash,
      scale: 5,
      alpha: 0,
      duration: 320,
      ease: 'Quad.easeOut',
      onComplete: () => flash.destroy(),
    });

    const ring = this.add.circle(effectX, effectY, 12, 0x000000, 0).setStrokeStyle(3, 0xf9a8d4, 0.95);
    ring.setBlendMode(Phaser.BlendModes.ADD);
    this.tweens.add({
      targets: ring,
      radius,
      alpha: 0,
      duration: 260,
      ease: 'Cubic.easeOut',
      onComplete: () => ring.destroy(),
    });

    const residue = this.add.circle(effectX, effectY, radius * 0.55, 0xf472b6, 0.12);
    residue.setBlendMode(Phaser.BlendModes.ADD);
    this.tweens.add({
      targets: residue,
      alpha: 0.02,
      scale: 1.1,
      duration: lingerMs,
      ease: 'Sine.easeOut',
      onComplete: () => residue.destroy(),
    });
  }

  private playPerkPickupEffect(x: number, y: number): void {
    const ring = this.add.circle(x, y, 14, 0x22d3ee, 0.3).setStrokeStyle(2, 0xa78bfa, 0.95);
    this.tweens.add({
      targets: ring,
      scale: 3.2,
      alpha: 0,
      duration: 260,
      ease: 'Quad.easeOut',
      onComplete: () => ring.destroy(),
    });

    const text = this.add
      .text(x, y - 24, 'PERK!', {
        fontSize: '18px',
        color: '#e9d5ff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);
    applyNeonText(text, '#a78bfa');
    this.tweens.add({
      targets: text,
      y: y - 54,
      alpha: 0,
      duration: 420,
      ease: 'Sine.easeOut',
      onComplete: () => text.destroy(),
    });
  }

  private refreshAttachedVisuals(): void {
    this.attachedDropsVisual.clear(true, true);

    this.attachedItems.forEach((item, itemIndex) => {
      const key = item.isBomb ? `drop-bomb-${item.colorIndex}` : `drop-${item.colorIndex}`;
      const visual = this.add.image(0, 0, key).setDisplaySize(14, 14);
      this.attachedDropsVisual.add(visual);

      const row = Math.floor(itemIndex / 5);
      const col = itemIndex % 5;
      const baseX = this.player.x - this.player.displayWidth / 2 + 4;
      const baseY = this.player.y - 24;
      visual.setPosition(baseX + col * 14, baseY - row * 14);
    });
  }

  private updateAttachedVisualPositions(): void {
    this.attachedDropsVisual.getChildren().forEach((child, itemIndex) => {
      const visual = child as Phaser.GameObjects.Image;
      const row = Math.floor(itemIndex / 5);
      const col = itemIndex % 5;
      const baseX = this.player.x - this.player.displayWidth / 2 + 4;
      const baseY = this.player.y - 24;
      visual.setPosition(baseX + col * 14, baseY - row * 14);
    });
  }

  private getAttachedItemPosition(itemIndex: number): { x: number; y: number } {
    const row = Math.floor(itemIndex / 5);
    const col = itemIndex % 5;
    const baseX = this.player.x - this.player.displayWidth / 2 + 4;
    const baseY = this.player.y - 24;
    return {
      x: baseX + col * 14,
      y: baseY - row * 14,
    };
  }

  private expandPlayerSymmetric(widthDelta: number): void {
    const nextWidth = Phaser.Math.Clamp(this.player.displayWidth + widthDelta, 64, 152);
    this.player.setSize(nextWidth, this.player.displayHeight);
    const body = this.player.body as Phaser.Physics.Arcade.Body;
    body.setSize(nextWidth, this.player.displayHeight, true);
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
      const glow = `#${(color | 0x202020).toString(16).padStart(6, '0')}`;

      ctx.shadowBlur = 10;
      ctx.shadowColor = glow;

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
      ctx.shadowBlur = 0;

      this.textures.addCanvas(key, canvas);
    });

    this.dropColors.forEach((color, index) => {
      const key = `drop-bomb-${index}`;
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

      const bombColor = `#${color.toString(16).padStart(6, '0')}`;
      const tailGradient = ctx.createLinearGradient(32, 0, 32, 34);
      tailGradient.addColorStop(0, 'rgba(196, 181, 253, 0.98)');
      tailGradient.addColorStop(0.45, 'rgba(56, 189, 248, 0.72)');
      tailGradient.addColorStop(1, 'rgba(56, 189, 248, 0)');

      // Tail beam to improve vertical readability during fall.
      ctx.fillStyle = tailGradient;
      ctx.beginPath();
      ctx.moveTo(32, 0);
      ctx.lineTo(21, 34);
      ctx.lineTo(43, 34);
      ctx.closePath();
      ctx.fill();

      ctx.globalAlpha = 0.82;
      ctx.strokeStyle = '#c4b5fd';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(32, 2);
      ctx.lineTo(32, 32);
      ctx.stroke();
      ctx.globalAlpha = 1;

      ctx.shadowBlur = 18;
      ctx.shadowColor = bombColor;
      ctx.fillStyle = bombColor;
      ctx.beginPath();
      ctx.arc(32, 34, 16, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.strokeStyle = '#f8fafc';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(32, 34, 16, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(29, 12, 6, 10);
      ctx.beginPath();
      ctx.moveTo(32, 12);
      ctx.lineTo(42, 6);
      ctx.strokeStyle = '#f8fafc';
      ctx.lineWidth = 2;
      ctx.stroke();

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

  private enterPerkDropPhase(): void {
    this.isPerkDropPhase = true;
    this.nextPerkIndex += 1;
    this.perkText.setText(`Next Perk: ${this.getNextPerkMilestone()}`);
    this.touchDirection = 0;
    this.activePerkChoices = [];
    const body = this.player.body as Phaser.Physics.Arcade.Body;
    body.setVelocityX(0);
    this.drops.clear(true, true);
    this.spawnPerkDrops();
  }

  private spawnPerkDrops(): void {
    const pool = this.getPerkPool();
    const mustShowBombChoice = !this.bombUnlocked && this.perksTakenCount >= 2;
    let choices = Phaser.Utils.Array.Shuffle(pool).slice(0, 2);
    if (mustShowBombChoice) {
      const bombPerk = pool.find((perk) => perk.id === 'bomb-item-unlock');
      if (bombPerk) {
        const nonBombChoice = choices.find((choice) => choice.id !== 'bomb-item-unlock');
        choices = [bombPerk, nonBombChoice ?? bombPerk];
      }
    }
    this.activePerkChoices = choices;
    if (choices.length === 0) {
      this.isPerkDropPhase = false;
      this.nextSpawnAtMs = this.time.now + 300;
      return;
    }
    const positions: Array<{ x: number; side: 'left' | 'right' }> = [
      { x: this.scale.width * 0.25, side: 'left' },
      { x: this.scale.width * 0.75, side: 'right' },
    ];

    choices.forEach((choice, idx) => {
      const perkDrop = this.add.circle(positions[idx].x, -30, 20, 0x38bdf8) as PerkToken;
      perkDrop.setStrokeStyle(2, 0xf0abfc, 0.95);
      perkDrop.speed = Number(this.roundCfg.perkDropFallSpeed ?? 1.7);
      perkDrop.perkId = choice.id;
      this.perkTokens.push(perkDrop);
      const labelColor = this.getPerkLabelColor(choice.id);

      const label = this.add
        .text(perkDrop.x, perkDrop.y - 34, choice.label, {
          fontSize: '14px',
          color: labelColor,
          backgroundColor: '#0b1225',
          padding: { x: 6, y: 2 },
          align: 'center',
        })
        .setOrigin(0.5);
      applyNeonText(label, labelColor);
      this.perkLabels.push(label);
    });
  }

  private getPerkLabelColor(perkId: string): string {
    const colorMap: Record<number, string> = {
      0: '#f87171',
      1: '#60a5fa',
      2: '#4ade80',
      3: '#facc15',
      4: '#c084fc',
    };
    if (perkId.startsWith('color-catch-bonus-') || perkId.startsWith('color-match-bonus-')) {
      const lastToken = perkId.split('-').at(-1);
      const colorIndex = Number(lastToken);
      return colorMap[colorIndex] ?? '#e2e8f0';
    }
    return '#e2e8f0';
  }

  private updatePerkDropPhase(delta: number): void {
    const deltaFactor = Phaser.Math.Clamp(delta / (1000 / 60), 0.6, 1.8);

    this.perkTokens.forEach((token, idx) => {
      if (token.active) {
        token.y += token.speed * deltaFactor;
        this.perkLabels[idx]?.setPosition(token.x, token.y - 34);
        if (token.y > this.scale.height + 28) {
          token.y = -30;
        }
      }
    });

    const selected = this.perkTokens.find((token) =>
      token.active ? Phaser.Geom.Intersects.RectangleToRectangle(token.getBounds(), this.player.getBounds()) : false,
    );

    if (!selected || !selected.perkId) {
      return;
    }

    const perk = this.activePerkChoices.find((item) => item.id === selected.perkId);
    if (perk) {
      this.applyPerk(perk);
      playPerkPickupSfx();
      this.playPerkPickupEffect(selected.x, selected.y);
    }

    this.perkTokens.forEach((token) => token.destroy());
    this.perkLabels.forEach((label) => label.destroy());
    this.perkTokens = [];
    this.perkLabels = [];
    this.activePerkChoices = [];
    this.isPerkDropPhase = false;
    this.nextSpawnAtMs = this.time.now + 450;
  }

  private getBgmRateForDropSpeed(currentDropSpeed: number): number {
    const minSpeed = Number(this.roundCfg.dropSpeedBase ?? this.cfg.dropSpeedStart ?? 1.0);
    const maxSpeed = Number(this.roundCfg.dropSpeedMax ?? this.cfg.dropSpeedMax ?? 7.5);
    if (maxSpeed <= minSpeed) {
      return this.bgmRateMin;
    }
    const normalized = Phaser.Math.Clamp((currentDropSpeed - minSpeed) / (maxSpeed - minSpeed), 0, 1);
    return Phaser.Math.Linear(this.bgmRateMin, this.bgmRateMax, normalized);
  }

  private getPerkPool(): Array<PerkChoice & { maxStack: number }> {
    const colorNames = ['빨강', '파랑', '초록', '노랑', '보라'];
    const catchBoostColor = Phaser.Math.Between(0, this.dropColors.length - 1);
    const matchBoostColor = Phaser.Math.Between(0, this.dropColors.length - 1);
    const all: Array<PerkChoice & { maxStack: number }> = [
      {
        id: 'expand-width',
        label: '받침판 확장',
        maxStack: Number(this.roundCfg.perkExpandPlayerMaxStack ?? 2),
        apply: (scene) => {
          scene.expandPlayerSymmetric(12);
        },
      },
      {
        id: 'attached-limit-up',
        label: '받침판 용량 +1',
        maxStack: Number(this.roundCfg.perkAttachLimitMaxStack ?? 2),
        apply: (scene) => {
          scene.attachedLimitCurrent = Math.min(8, scene.attachedLimitCurrent + 1);
        },
      },
      {
        id: 'move-speed-up',
        label: '받침판 속도 UP',
        maxStack: Number(this.roundCfg.perkMoveSpeedMaxStack ?? 3),
        apply: (scene) => {
          scene.moveSpeedBonus += 45;
        },
      },
      {
        id: 'spawn-slower-permanent',
        label: '똥 생성 속도 Down',
        maxStack: Number(this.roundCfg.perkSpawnDelayNerfMaxStack ?? 3),
        apply: (scene) => {
          scene.spawnDelayBonusMs += 30;
        },
      },
      {
        id: 'drop-slower-permanent',
        label: '똥 낙하 속도 Down',
        maxStack: Number(this.roundCfg.perkDropSpeedNerfMaxStack ?? 3),
        apply: (scene) => {
          scene.dropSpeedMultiplier *= 0.93;
        },
      },
      {
        id: 'match-bonus',
        label: '모든 똥 3매칭 점수 UP',
        maxStack: Number(this.roundCfg.perkColorScoreBonusMaxStack ?? 4),
        apply: (scene) => {
          scene.matchBonusScoreCurrent += 20;
        },
      },
      {
        id: `color-catch-bonus-${catchBoostColor}`,
        label: `${colorNames[catchBoostColor]} 부착 점수 +4`,
        maxStack: 4,
        apply: (scene) => {
          scene.colorCatchBonusByType[catchBoostColor] += 4;
        },
      },
      {
        id: `color-match-bonus-${matchBoostColor}`,
        label: `${colorNames[matchBoostColor]} 매칭 보너스 +40`,
        maxStack: 3,
        apply: (scene) => {
          scene.colorMatchBonusByType[matchBoostColor] += 40;
        },
      },
      {
        id: 'bomb-item-unlock',
        label: '폭탄 아이템 등장',
        maxStack: Number(this.roundCfg.perkBombRoundMaxStack ?? 1),
        apply: (scene) => {
          scene.bombUnlocked = true;
        },
      },
    ];
    return all.filter((perk) => (this.perkStacks[perk.id] ?? 0) < perk.maxStack);
  }

  private applyPerk(perk: PerkChoice & { maxStack: number }): void {
    perk.apply(this);
    this.perkStacks[perk.id] = (this.perkStacks[perk.id] ?? 0) + 1;
    this.perksTakenCount += 1;
  }

  private getNextPerkMilestone(): number {
    if (this.nextPerkIndex < this.perkMilestones.length) {
      return this.perkMilestones[this.nextPerkIndex];
    }
    const last = this.perkMilestones[this.perkMilestones.length - 1] ?? 7900;
    return last + (this.nextPerkIndex - this.perkMilestones.length + 1) * 1800;
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
    createNeonBackdrop(this);

    applyNeonText(this.add.text(width / 2, 40, '게임 종료', { fontSize: '34px', color: '#f8fafc' }), '#f472b6').setOrigin(
      0.5,
    );
    const myResultText = this.add.text(width / 2, 86, `내 점수: ${this.finalScore} | 내 순위: 계산 중...`, {
      fontSize: '20px',
      color: '#facc15',
      fontFamily: '"Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    }).setOrigin(0.5);

    applyNeonText(this.add.text(width / 2, 126, 'TOP 10 RANKING', { fontSize: '18px', color: '#facc15' }), '#facc15').setOrigin(
      0.5,
    );
    const rankingText = this.add.text(width / 2, 154, '로딩 중...', {
      fontSize: '16px',
      color: '#dbeafe',
      lineSpacing: 7,
      fontFamily: '"Consolas", "Courier New", monospace',
      align: 'center',
    }).setOrigin(0.5, 0);
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
      'width:260px;height:42px;border-radius:10px;border:1px solid #a78bfa;background:#a855f7;color:#f5f3ff;font-size:16px;font-weight:700;cursor:pointer;box-shadow:0 0 14px rgba(168,85,247,0.45);',
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
  backgroundColor: '#050816',
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
