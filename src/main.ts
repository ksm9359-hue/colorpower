import './style.css';
import Phaser from 'phaser';

type FallingDrop = Phaser.GameObjects.Rectangle & {
  colorIndex: number;
  speed: number;
};

class MainScene extends Phaser.Scene {
  private readonly dropColors = [0xef4444, 0x3b82f6, 0x22c55e, 0xf59e0b, 0xa855f7];
  private player!: Phaser.GameObjects.Rectangle;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private keyA!: Phaser.Input.Keyboard.Key;
  private keyD!: Phaser.Input.Keyboard.Key;
  private drops!: Phaser.GameObjects.Group;
  private attachedDropsVisual!: Phaser.GameObjects.Group;
  private scoreText!: Phaser.GameObjects.Text;
  private attachedText!: Phaser.GameObjects.Text;
  private colorsText!: Phaser.GameObjects.Text;
  private gameOverText!: Phaser.GameObjects.Text;
  private score = 0;
  private totalAttached = 0;
  private attachedByColor = [0, 0, 0, 0, 0];
  private attachedItems: number[] = [];
  private isGameOver = false;
  private startedAtMs = 0;
  private nextSpawnAtMs = 0;

  constructor() {
    super('main-scene');
  }

  create(): void {
    const width = this.scale.width;
    const height = this.scale.height;

    this.add.text(width / 2, 36, 'Dodge Rain', {
      fontSize: '34px',
      color: '#ffffff',
    }).setOrigin(0.5);

    this.add.text(width / 2, 68, 'A / D to move | Match 3 same colors', {
      fontSize: '16px',
      color: '#d1d5db',
    }).setOrigin(0.5);

    this.player = this.add.rectangle(width / 2, height - 42, 64, 22, 0x9ca3af);
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

    this.attachedText = this.add.text(16, 44, 'Attached: 0 / 5', {
      fontSize: '18px',
      color: '#f8fafc',
    });

    this.colorsText = this.add.text(16, 70, this.getColorStatusText(), {
      fontSize: '15px',
      color: '#cbd5e1',
    });

    this.gameOverText = this.add.text(width / 2, height / 2, '', {
      fontSize: '22px',
      color: '#f87171',
      align: 'center',
    }).setOrigin(0.5);

    this.nextSpawnAtMs = this.time.now + 760;
    this.input.keyboard!.on('keydown-SPACE', () => {
      if (this.isGameOver) {
        this.scene.restart();
      }
    });
  }

  update(): void {
    if (this.isGameOver) {
      return;
    }

    const body = this.player.body as Phaser.Physics.Arcade.Body;
    const moveSpeed = 360;
    body.setVelocityX(0);
    if (this.cursors.left.isDown || this.keyA.isDown) {
      body.setVelocityX(-moveSpeed);
    }
    if (this.cursors.right.isDown || this.keyD.isDown) {
      body.setVelocityX(moveSpeed);
    }

    const elapsedSeconds = (this.time.now - this.startedAtMs) / 1000;
    const nextDelay = Phaser.Math.Clamp(760 - elapsedSeconds * 18, 300, 760);
    if (this.time.now >= this.nextSpawnAtMs) {
      this.spawnDrop();
      this.nextSpawnAtMs = this.time.now + nextDelay;
    }

    this.drops.getChildren().forEach((dropObject) => {
      const drop = dropObject as FallingDrop;
      drop.y += drop.speed;

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

  private spawnDrop(): void {
    if (this.isGameOver) {
      return;
    }

    const x = Phaser.Math.Between(20, this.scale.width - 20);
    const colorIndex = Phaser.Math.Between(0, this.dropColors.length - 1);
    const elapsedSeconds = (this.time.now - this.startedAtMs) / 1000;
    const speed = Phaser.Math.Clamp(2.8 + elapsedSeconds * 0.08, 2.8, 7.2);
    const drop = this.add.rectangle(x, -20, 20, 20, this.dropColors[colorIndex]) as FallingDrop;
    drop.colorIndex = colorIndex;
    drop.speed = speed;
    this.drops.add(drop);
  }

  private collectDrop(colorIndex: number): void {
    this.totalAttached += 1;
    this.attachedByColor[colorIndex] += 1;
    this.attachedItems.push(colorIndex);
    this.score += 10;

    if (this.attachedByColor[colorIndex] >= 3) {
      this.attachedByColor[colorIndex] -= 3;
      this.totalAttached -= 3;
      this.removeThreeAttachedItems(colorIndex);
      this.score += 50;
      this.playMatchEffect(colorIndex);
    }

    this.scoreText.setText(`Score: ${this.score}`);
    this.attachedText.setText(`Attached: ${this.totalAttached} / 5`);
    this.colorsText.setText(this.getColorStatusText());
    this.refreshAttachedVisuals();

    if (this.totalAttached >= 5) {
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

    const bonusText = this.add.text(effectX, effectY - 14, '+50 BONUS!', {
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
      const visual = this.add.rectangle(0, 0, 14, 14, this.dropColors[colorIndex]);
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
      const visual = child as Phaser.GameObjects.Rectangle;
      const row = Math.floor(itemIndex / 5);
      const col = itemIndex % 5;
      const baseX = this.player.x - 28;
      const baseY = this.player.y - 24;
      visual.setPosition(baseX + col * 14, baseY - row * 14);
    });
  }

  private getColorStatusText(): string {
    return `R:${this.attachedByColor[0]}  B:${this.attachedByColor[1]}  G:${this.attachedByColor[2]}  Y:${this.attachedByColor[3]}  P:${this.attachedByColor[4]}`;
  }

  private endGame(): void {
    this.isGameOver = true;
    this.gameOverText.setText(`Game Over\nFinal Score: ${this.score}\nPress SPACE to restart`);
  }
}

document.querySelector<HTMLDivElement>('#app')!.innerHTML = '<div id="game-root"></div>';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 420,
  height: 640,
  backgroundColor: '#0f172a',
  parent: 'game-root',
  physics: {
    default: 'arcade',
    arcade: {
      debug: false,
    },
  },
  scene: [MainScene],
};

new Phaser.Game(config);
