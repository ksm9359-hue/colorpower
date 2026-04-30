import './style.css';
import Phaser from 'phaser';

class MainScene extends Phaser.Scene {
  private player!: Phaser.GameObjects.Rectangle;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private keyA!: Phaser.Input.Keyboard.Key;
  private keyD!: Phaser.Input.Keyboard.Key;
  private obstacles!: Phaser.GameObjects.Group;
  private scoreText!: Phaser.GameObjects.Text;
  private gameOverText!: Phaser.GameObjects.Text;
  private score = 0;
  private isGameOver = false;

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

    this.add.text(width / 2, 68, 'Left/Right or A/D to move', {
      fontSize: '16px',
      color: '#d1d5db',
    }).setOrigin(0.5);

    this.player = this.add.rectangle(width / 2, height - 42, 52, 20, 0x38bdf8);
    this.physics.add.existing(this.player);
    const playerBody = this.player.body as Phaser.Physics.Arcade.Body;
    playerBody.setCollideWorldBounds(true);

    this.obstacles = this.add.group();
    this.cursors = this.input.keyboard!.createCursorKeys();
    this.keyA = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.A);
    this.keyD = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.D);

    this.scoreText = this.add.text(16, 16, 'Score: 0', {
      fontSize: '20px',
      color: '#f8fafc',
    });

    this.gameOverText = this.add.text(width / 2, height / 2, '', {
      fontSize: '24px',
      color: '#f87171',
      align: 'center',
    }).setOrigin(0.5);

    this.time.addEvent({
      delay: 520,
      loop: true,
      callback: () => this.spawnObstacle(),
    });

    this.time.addEvent({
      delay: 1000,
      loop: true,
      callback: () => {
        if (!this.isGameOver) {
          this.score += 1;
          this.scoreText.setText(`Score: ${this.score}`);
        }
      },
    });

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

    this.obstacles.getChildren().forEach((obstacle) => {
      const rect = obstacle as Phaser.GameObjects.Rectangle;
      rect.y += 4.4;

      if (Phaser.Geom.Intersects.RectangleToRectangle(rect.getBounds(), this.player.getBounds())) {
        this.endGame();
      }

      if (rect.y > this.scale.height + 30) {
        rect.destroy();
      }
    });
  }

  private spawnObstacle(): void {
    if (this.isGameOver) {
      return;
    }

    const x = Phaser.Math.Between(20, this.scale.width - 20);
    const obstacle = this.add.rectangle(x, -20, 20, 20, 0xfacc15);
    this.obstacles.add(obstacle);
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
