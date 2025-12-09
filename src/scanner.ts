// src/scanner.ts
import {
  AudioSource,
  AudioUtils,
  PlaybackMode,
  Types,
  Vector3,
  createComponent,
  createSystem,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  PanelUI,
  Interactable,
  DistanceGrabbable,
  MovementMode,
  AssetManager,
} from "@iwsdk/core";
import { CanvasTexture } from "three";

/**
 * Zone that represents the scanner area.
 * Place this entity near your scanner surface in index.ts.
 */
export const ScannerZone = createComponent("ScannerZone", {
  productId: { type: Types.String, default: "" },
  radius: { type: Types.Float32, default: 0.25 },
});

/**
 * Tag for objects that can be scanned.
 * NOTE: includes homeX/homeY/homeZ so we can respawn at the desk slot,
 * not in the player's hand.
 */
export const Scannable = createComponent("Scannable", {
  productId: { type: Types.String, default: "" },
  lastScanTime: { type: Types.Float32, default: -1 },
  homeX: { type: Types.Float32, default: 0 },
  homeY: { type: Types.Float32, default: 0 },
  homeZ: { type: Types.Float32, default: 0 },
});

export class ScannerSystem extends createSystem(
  {
    scanners: { required: [ScannerZone] },
    scannables: { required: [Scannable] },
  },
  {
    scanRadius: { type: Types.Float32, default: 0.25 },
    scanCooldown: { type: Types.Float32, default: 0.75 },
  },
) {
  private scannerPos!: Vector3;
  private scannablePos!: Vector3;

  private audioEntity: any | null = null;            // cashier
  private winAudioEntity: any | null = null;         // youwin.mp3
  private loseAudioEntity: any | null = null;        // youlose.mp3
  private timerWarningAudioEntity: any | null = null;

  // --- Timer state (game round) ---
  private readonly gameDurationSeconds = 30; // 30-second round
  private timeRemaining = this.gameDurationSeconds;
  private timerRunning = false; // starts only after first scan
  private gameStarted = false;
  private roundEnded = false;

  // --- Score / cart state ---
  private scannedCount = 0;
  private lastScoreValue = -1;
  private totalCartValue = 0;
  private lastTotalValue = -1;
  private readonly goalCartValue = 150; // Level 1 goal: $150

  // --- Timer bar ---
  private timerBarEntity: any | null = null;
  private timerBarMaterial: MeshBasicMaterial | null = null;

  // --- Timer text (mm:ss) ---
  private timerTextCanvas: HTMLCanvasElement | null = null;
  private timerTextContext: CanvasRenderingContext2D | null = null;
  private timerTextTexture: CanvasTexture | null = null;
  private timerTextEntity: any | null = null;
  private lastTimerSeconds: number = -1;

  // --- Score text (items + total + goal progress) ---
  private scoreTextCanvas: HTMLCanvasElement | null = null;
  private scoreTextContext: CanvasRenderingContext2D | null = null;
  private scoreTextTexture: CanvasTexture | null = null;
  private scoreTextEntity: any | null = null;

  // --- Scan toast (canvas-based, no JSON text) ---
  private toastEntity: any | null = null;
  private toastTimer = 0;
  private toastCanvas: HTMLCanvasElement | null = null;
  private toastContext: CanvasRenderingContext2D | null = null;
  private toastTexture: CanvasTexture | null = null;

  // --- Round-complete panel (PanelUI, optional) ---
  private roundPanelEntity: any | null = null;
  private roundShown = false;

  // --- Round-complete message (canvas-based, guaranteed visible) ---
  private roundMessageEntity: any | null = null;
  private roundMessageCanvas: HTMLCanvasElement | null = null;
  private roundMessageContext: CanvasRenderingContext2D | null = null;
  private roundMessageTexture: CanvasTexture | null = null;

  // --- Onboarding hint (canvas panel in front of user) ---
  private onboardingEntity: any | null = null;
  private onboardingCanvas: HTMLCanvasElement | null = null;
  private onboardingContext: CanvasRenderingContext2D | null = null;
  private onboardingTexture: CanvasTexture | null = null;
  private onboardingVisible = true;     // visible on first load, hidden after first scan
  private onboardingAnchored = false;   // once anchored in front of user, it stays static

  // --- Product catalog for respawns ---
  private productCatalog = [
    { productId: "redApple", assetKey: "redApple", scale: 0.28 },
    { productId: "pear", assetKey: "pear", scale: 0.10 },
    {
      productId: "cerealCocoaCritters",
      assetKey: "cerealCocoaCritters",
      scale: 0.010,
    },
    { productId: "goldBar", assetKey: "goldBar", scale: 0.42 },
    { productId: "shoe", assetKey: "shoe", scale: 1.3 },
    { productId: "industrialShoe", assetKey: "industrialShoe", scale: 1.5 },
    { productId: "chickenFriedRice", assetKey: "chickenFriedRice", scale: 0.013 },
    { productId: "chickenStrips", assetKey: "chickenStrips", scale: 1.25 },
    { productId: "fleeceJacket", assetKey: "fleeceJacket", scale: 0.36 },
    { productId: "glasses", assetKey: "glasses", scale: 0.02 },
    { productId: "presentBox", assetKey: "presentBox", scale: 0.18 },
  ];

  // --- Product info: names + prices (Gold Bar at 29.99) ---
  private productInfo: Record<string, { name: string; price: number }> = {
    redApple: { name: "Red Apple", price: 0.99 },
    pear: { name: "Fresh Pear", price: 1.09 },
    cerealCocoaCritters: { name: "Cocoa Critters Cereal", price: 4.99 },
    goldBar: { name: "Gold Bar (Display)", price: 29.99 },
    shoe: { name: "Running Shoe", price: 59.99 },
    industrialShoe: { name: "Industrial Work Boot", price: 89.99 },
    chickenFriedRice: { name: "Frozen Chicken Fried Rice", price: 7.49 },
    chickenStrips: { name: "Crispy Chicken Strips", price: 8.99 },
    fleeceJacket: { name: "Fleece Jacket", price: 39.99 },
    glasses: { name: "Fashion Glasses", price: 19.99 },
    presentBox: { name: "Gift Box", price: 5.99 },
  };

  private static readonly PULSE_DURATION = 0.25;
  private static readonly PULSE_SCALE = 1.15;

  // 10-second warning flag
  private timerWarningPlayed = false;

  init() {
    this.scannerPos = new Vector3();
    this.scannablePos = new Vector3();

    // Cashier beep on scan
    this.audioEntity = this.world
      .createTransformEntity()
      .addComponent(AudioSource, {
        src: "./audio/cashier.mp3",
        maxInstances: 3,
        playbackMode: PlaybackMode.FadeRestart,
      });

    // Win sound on successful round
    this.winAudioEntity = this.world
      .createTransformEntity()
      .addComponent(AudioSource, {
        src: "./audio/youwin.mp3",
        maxInstances: 1,
        playbackMode: PlaybackMode.FadeRestart,
      });

    // Lose sound on failed round
    this.loseAudioEntity = this.world
      .createTransformEntity()
      .addComponent(AudioSource, {
        src: "./audio/youlose.mp3",
        maxInstances: 1,
        playbackMode: PlaybackMode.FadeRestart,
      });

    // Timer warning when 10 seconds remain
    this.timerWarningAudioEntity = this.world
      .createTransformEntity()
      .addComponent(AudioSource, {
        src: "./audio/timer.mp3",
        maxInstances: 1,
        playbackMode: PlaybackMode.FadeRestart,
      });

    this.setupTimerBarEntity();
    this.setupTimerTextEntity();
    this.setupScoreTextEntity();
    this.setupToastPanel(); // canvas toast
    this.setupRoundCompletePanel();
    this.setupRoundMessageEntity();
    this.setupOnboardingPanel(); // onboarding hint in front of user

    this.timeRemaining = this.gameDurationSeconds;
    this.timerRunning = false;
    this.gameStarted = false;
    this.roundEnded = false;
    this.roundShown = false;
    this.timerWarningPlayed = false;

    this.scannedCount = 0;
    this.totalCartValue = 0;
    this.lastScoreValue = 0;
    this.lastTotalValue = 0;
    this.onboardingVisible = true;
    this.onboardingAnchored = false;
  }

  // ---------- HUD creation ----------

  private setupTimerBarEntity() {
    const barGeometry = new PlaneGeometry(0.4, 0.06);
    this.timerBarMaterial = new MeshBasicMaterial({
      color: 0x00ff66,
      transparent: true,
      opacity: 0.9,
      side: 2,
    });

    const barMesh = new Mesh(barGeometry, this.timerBarMaterial);
    this.timerBarEntity = this.world.createTransformEntity(barMesh);
  }

  private setupTimerTextEntity() {
    if (typeof document === "undefined") return;

    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    this.timerTextCanvas = canvas;
    this.timerTextContext = ctx;

    const texture = new CanvasTexture(canvas);
    texture.needsUpdate = true;
    this.timerTextTexture = texture;

    const geo = new PlaneGeometry(0.22, 0.08);
    const mat = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 1.0,
      side: 2,
    });

    const mesh = new Mesh(geo, mat);
    this.timerTextEntity = this.world.createTransformEntity(mesh);

    this.updateTimerTextTexture(this.gameDurationSeconds);
    this.lastTimerSeconds = Math.ceil(this.gameDurationSeconds);
  }

  private setupScoreTextEntity() {
    if (typeof document === "undefined") return;

    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 128; // taller for 2 lines (score + goal progress)
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    this.scoreTextCanvas = canvas;
    this.scoreTextContext = ctx;

    const texture = new CanvasTexture(canvas);
    texture.needsUpdate = true;
    this.scoreTextTexture = texture;

    const geo = new PlaneGeometry(0.40, 0.11);
    const mat = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 1.0,
      side: 2,
    });

    const mesh = new Mesh(geo, mat);
    this.scoreTextEntity = this.world.createTransformEntity(mesh);

    this.updateScoreTextTexture(0, 0);
    this.lastScoreValue = 0;
    this.lastTotalValue = 0;
  }

  /**
   * Canvas-based toast: green pill with white text.
   * No dependency on scan-toast.json text.
   */
  private setupToastPanel() {
    if (typeof document === "undefined") return;

    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    this.toastCanvas = canvas;
    this.toastContext = ctx;

    const texture = new CanvasTexture(canvas);
    texture.needsUpdate = true;
    this.toastTexture = texture;

    // Roughly 0.4m wide, 0.1m tall
    const geo = new PlaneGeometry(0.4, 0.10);
    const mat = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 1.0,
      side: 2,
    });

    const mesh = new Mesh(geo, mat);
    this.toastEntity = this.world.createTransformEntity(mesh);

    if (this.toastEntity.object3D) {
      this.toastEntity.object3D.visible = false;
    }
  }

  private setupRoundCompletePanel() {
    this.roundPanelEntity = this.world
      .createTransformEntity()
      .addComponent(PanelUI, {
        config: "./ui/round-complete.json",
        maxHeight: 0.6,
        maxWidth: 0.8,
      });

    const obj = this.roundPanelEntity.object3D;
    if (obj) {
      obj.visible = false;
      obj.position.set(0, 1.6, 0.2);
    }
  }

  private setupRoundMessageEntity() {
    if (typeof document === "undefined") return;

    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 240;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    this.roundMessageCanvas = canvas;
    this.roundMessageContext = ctx;

    const texture = new CanvasTexture(canvas);
    texture.needsUpdate = true;
    this.roundMessageTexture = texture;

    const geo = new PlaneGeometry(0.7, 0.30);
    const mat = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 1.0,
      side: 2,
    });

    const mesh = new Mesh(geo, mat);
    this.roundMessageEntity = this.world.createTransformEntity(mesh);

    if (this.roundMessageEntity.object3D) {
      this.roundMessageEntity.object3D.visible = false;
    }
  }

  private setupOnboardingPanel() {
    if (typeof document === "undefined") return;

    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 256;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    this.onboardingCanvas = canvas;
    this.onboardingContext = ctx;

    const texture = new CanvasTexture(canvas);
    texture.needsUpdate = true;
    this.onboardingTexture = texture;

    const geo = new PlaneGeometry(0.8, 0.32);
    const mat = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 1.0,
      side: 2,
    });

    const mesh = new Mesh(geo, mat);
    this.onboardingEntity = this.world.createTransformEntity(mesh);

    this.onboardingVisible = true;
    this.onboardingAnchored = false;
    this.drawOnboardingMessage();

    if (this.onboardingEntity.object3D) {
      this.onboardingEntity.object3D.visible = true;
    }
  }

  // ---------- HUD updates ----------

  private updateTimerTextTexture(seconds: number) {
    if (
      !this.timerTextCanvas ||
      !this.timerTextContext ||
      !this.timerTextTexture
    )
      return;

    const canvas = this.timerTextCanvas;
    const ctx = this.timerTextContext;

    const total = Math.max(0, Math.floor(seconds));
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    const label = `${mins}:${secs.toString().padStart(2, "0")}`;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(0, 0, 0, 0)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.font =
      "bold 42px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    ctx.shadowColor = "rgba(0, 0, 0, 0.7)";
    ctx.shadowBlur = 6;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 2;

    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, canvas.width / 2, canvas.height / 2);

    this.timerTextTexture.needsUpdate = true;
  }

  private updateScoreTextTexture(count: number, total: number) {
    if (
      !this.scoreTextCanvas ||
      !this.scoreTextContext ||
      !this.scoreTextTexture
    )
      return;

    const canvas = this.scoreTextCanvas;
    const ctx = this.scoreTextContext;

    const remaining = Math.max(0, this.goalCartValue - total);
    const hitGoal = total >= this.goalCartValue;

    const mainLine = `Scanned: ${count} | Total: $${total.toFixed(2)}`;
    const statusLine = hitGoal
      ? "GOAL REACHED!"
      : `Need: $${remaining.toFixed(2)} more`;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(0, 0, 0, 0)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0, 0, 0, 0.7)";
    ctx.shadowBlur = 6;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 2;

    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;

    // First line: score
    ctx.font =
      "bold 32px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(mainLine, centerX, centerY - 16);

    // Second line: goal + status
    ctx.font =
      "normal 26px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.fillText(
      `Goal: $${this.goalCartValue.toFixed(2)} — ${statusLine}`,
      centerX,
      centerY + 16,
    );

    this.scoreTextTexture.needsUpdate = true;
  }

  private updateRoundMessageTexture(score: number, total: number) {
    if (
      !this.roundMessageCanvas ||
      !this.roundMessageContext ||
      !this.roundMessageTexture
    )
      return;

    const canvas = this.roundMessageCanvas;
    const ctx = this.roundMessageContext;

    const hitGoal = total >= this.goalCartValue;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(0, 0, 0, 0)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    ctx.shadowColor = "rgba(0, 0, 0, 0.7)";
    ctx.shadowBlur = 6;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 2;

    const centerX = canvas.width / 2;
    const baseY = canvas.height / 2;

    // --- BLUE ROUNDED BACKGROUND (NEW) --- // UPDATED
    const radius = 40;
    const paddingX = 40;
    const paddingY = 30;
    const x = paddingX;
    const y = paddingY;
    const w = canvas.width - paddingX * 2;
    const h = canvas.height - paddingY * 2;

    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();

    ctx.fillStyle = "rgba(0, 80, 180, 0.94)";
    ctx.fill();

    // --- TEXT --- //
    ctx.font =
      "bold 44px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.fillText("Time's up!", centerX, baseY - 70);

    ctx.font =
      "bold 34px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.fillText(
      `You scanned ${score} item${score === 1 ? "" : "s"}.`,
      centerX,
      baseY - 30,
    );

    ctx.font =
      "bold 30px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.fillText(
      `Cart total: $${total.toFixed(2)} (Goal: $${this.goalCartValue.toFixed(
        2,
      )})`,
      centerX,
      baseY + 10,
    );

    ctx.font =
      "normal 28px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.fillText(
      hitGoal
        ? "You win! Start scanning to play again."
        : `You missed the goal. Try again to hit $${this.goalCartValue.toFixed(
            2,
          )}.`,
      centerX,
      baseY + 50,
    );

    this.roundMessageTexture.needsUpdate = true;
  }

  private drawOnboardingMessage() {
    if (
      !this.onboardingCanvas ||
      !this.onboardingContext ||
      !this.onboardingTexture
    )
      return;

    const canvas = this.onboardingCanvas;
    const ctx = this.onboardingContext;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(0, 0, 0, 0)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    ctx.shadowColor = "rgba(0, 0, 0, 0.7)";
    ctx.shadowBlur = 6;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 2;

    const centerX = canvas.width / 2;
    const baseY = canvas.height / 2;

    ctx.font =
      "bold 32px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(
      "Grab an item and move it over",
      centerX,
      baseY - 40,
    );

    ctx.font =
      "bold 32px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.fillText(
      "the green pad to scan it.",
      centerX,
      baseY,
    );

    ctx.font =
      "normal 28px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.fillText(
      "You have 30 seconds. Hit $150 to win.",
      centerX,
      baseY + 40,
    );

    this.onboardingTexture.needsUpdate = true;
  }

  private updateTimerBarVisual(scannerObject3D: any) {
    if (!this.timerBarEntity || !this.timerBarMaterial) return;

    const barObj = this.timerBarEntity.object3D;
    if (!barObj) return;

    scannerObject3D.getWorldPosition(this.scannerPos);
    barObj.position.copy(this.scannerPos);
    barObj.position.y += 0.35;

    const cam = this.world.camera;
    if (cam && cam.position) {
      barObj.lookAt(cam.position);
    }

    const ratio =
      this.gameDurationSeconds > 0
        ? this.timeRemaining / this.gameDurationSeconds
        : 0;
    const clamped = Math.max(0, Math.min(1, ratio));

    const minScale = 0.1;
    const maxScale = 1.0;
    const scaleX = minScale + (maxScale - minScale) * clamped;
    barObj.scale.set(scaleX, 1, 1);

    try {
      if (clamped > 0.66) {
        this.timerBarMaterial.color.set(0x00ff66);
      } else if (clamped > 0.33) {
        this.timerBarMaterial.color.set(0xffcc33);
      } else {
        this.timerBarMaterial.color.set(0xff5555);
      }
      this.timerBarMaterial.opacity = clamped > 0 ? 0.9 : 0.0;
    } catch {
      // ignore
    }
  }

  private updateTimerTextPosition(scannerObject3D: any) {
    if (!this.timerTextEntity || !this.timerTextEntity.object3D) return;

    const textObj = this.timerTextEntity.object3D;
    scannerObject3D.getWorldPosition(this.scannerPos);
    textObj.position.copy(this.scannerPos);
    textObj.position.y += 0.42;

    const cam = this.world.camera;
    if (cam && cam.position) {
      textObj.lookAt(cam.position);
    }
  }

  private updateScoreTextPosition(scannerObject3D: any) {
    if (!this.scoreTextEntity || !this.scoreTextEntity.object3D) return;

    const scoreObj = this.scoreTextEntity.object3D;
    scannerObject3D.getWorldPosition(this.scannerPos);
    scoreObj.position.copy(this.scannerPos);

    scoreObj.position.y += 0.3;
    scoreObj.position.x += 0.3;

    const cam = this.world.camera;
    if (cam && cam.position) {
      scoreObj.lookAt(cam.position);
    }
  }

  private updateToastVisual(scannerObject3D: any, delta: number) {
    if (!this.toastEntity || !this.toastEntity.object3D) return;

    const toastObj = this.toastEntity.object3D;

    if (this.toastTimer > 0) {
      this.toastTimer -= delta;
      if (this.toastTimer <= 0) {
        this.toastTimer = 0;
        toastObj.visible = false;
        return;
      }

      scannerObject3D.getWorldPosition(this.scannerPos);
      toastObj.position.copy(this.scannerPos);
      toastObj.position.y += 0.22;

      const cam = this.world.camera;
      if (cam && cam.position) {
        toastObj.lookAt(cam.position);
      }
    }
  }

  private updateOnboardingVisual() {
    if (!this.onboardingEntity || !this.onboardingEntity.object3D) return;

    const obj = this.onboardingEntity.object3D;

    if (!this.onboardingVisible) {
      obj.visible = false;
      return;
    }

    if (this.onboardingAnchored) {
      // Already anchored in world space; keep visible but do not follow head
      obj.visible = true;
      return;
    }

    const cam: any = this.world.camera;
    if (!cam || !cam.position) return;

    const forward = new Vector3();
    if (typeof cam.getWorldDirection === "function") {
      cam.getWorldDirection(forward);
    } else {
      forward.set(0, 0, -1);
    }
    forward.normalize();

    const dist = 1.4; // 1.4m in front of user
    const pos = cam.position.clone().add(forward.multiplyScalar(dist));
    pos.y = cam.position.y - 0.05; // slightly below eye level
    obj.position.copy(pos);

    obj.lookAt(cam.position);
    obj.visible = true;

    // From now on, do not move with the head; it's anchored
    this.onboardingAnchored = true;
  }

  // ---------- Toast helpers ----------

  // Build "Red Apple — $0.99"
  private getProductLabel(productId: string): string {
    const info = this.productInfo[productId];
    if (!info) return "Item scanned";
    return `${info.name} — $${info.price.toFixed(2)}`;
  }

  private drawToast(label: string) {
    if (!this.toastCanvas || !this.toastContext || !this.toastTexture) return;

    const canvas = this.toastCanvas;
    const ctx = this.toastContext;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Transparent background
    ctx.fillStyle = "rgba(0, 0, 0, 0)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Green pill
    const radius = 48;
    const paddingX = 32;
    const paddingY = 24;
    const x = paddingX;
    const y = paddingY;
    const w = canvas.width - paddingX * 2;
    const h = canvas.height - paddingY * 2;

    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();

    ctx.fillStyle = "rgba(0, 140, 0, 0.92)";
    ctx.fill();

    // Text
    ctx.font =
      "600 32px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = 6;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 2;

    ctx.fillText(label, canvas.width / 2, canvas.height / 2);

    this.toastTexture.needsUpdate = true;
  }

  private showScanToast(label: string) {
    if (!this.toastEntity || !this.toastEntity.object3D) return;

    this.drawToast(label);

    this.toastTimer = 0.9;
    this.toastEntity.object3D.visible = true;
  }

  // ---------- Scanner visuals ----------

  private triggerScanPulse(scannerObject3D: any) {
    if (!scannerObject3D) return;
    const userData = (scannerObject3D.userData =
      scannerObject3D.userData || {});
    userData.pulseTimer = ScannerSystem.PULSE_DURATION;
  }

  private updateScannerAnimation(scannerObject3D: any, delta: number) {
    if (!scannerObject3D) return;

    const userData = (scannerObject3D.userData =
      scannerObject3D.userData || {});

    if (typeof userData.pulseTimer !== "number") {
      userData.pulseTimer = 0;
    }

    let pulseTimer: number = userData.pulseTimer;

    if (pulseTimer <= 0) {
      scannerObject3D.scale.set(1, 1, 1);
      const material = scannerObject3D.material;
      if (material) {
        try {
          material.opacity = 0.35;
          if (material.color && typeof material.color.set === "function") {
            material.color.set(0x00ffcc);
          }
        } catch {}
      }
      return;
    }

    pulseTimer -= delta;
    if (pulseTimer < 0) pulseTimer = 0;
    userData.pulseTimer = pulseTimer;

    const t = 1 - pulseTimer / ScannerSystem.PULSE_DURATION;
    const intensity = Math.sin(t * Math.PI);

    const scaleBase = 1.0;
    const scaleMax = ScannerSystem.PULSE_SCALE;
    const scale = scaleBase + (scaleMax - scaleBase) * intensity;
    scannerObject3D.scale.set(scale, scale, scale);

    const material = scannerObject3D.material;
    if (material) {
      try {
        material.opacity = 0.35 + 0.45 * intensity;
        if (material.color && typeof material.color.set === "function") {
          material.color.set(0x00ff66);
        }
      } catch {}
    }
  }

  // ---------- Audio helpers ----------

  private playScanSound() {
    if (this.audioEntity) {
      AudioUtils.play(this.audioEntity);
    }
  }

  private playWinSound() {
    if (this.winAudioEntity) {
      AudioUtils.play(this.winAudioEntity);
    }
  }

  private playLoseSound() {
    if (this.loseAudioEntity) {
      AudioUtils.play(this.loseAudioEntity);
    }
  }

  private playTimerWarningSound() {
    if (this.timerWarningAudioEntity) {
      AudioUtils.play(this.timerWarningAudioEntity);
    }
  }

  // ---------- Product spawn helper ----------

  private spawnRandomProductAt(homeX: number, homeY: number, homeZ: number) {
    if (!this.productCatalog.length) return;

    const idx = Math.floor(Math.random() * this.productCatalog.length);
    const def = this.productCatalog[idx];

    const gltf = AssetManager.getGLTF(def.assetKey);
    if (!gltf) {
      console.warn("[ScannerSystem] Missing GLTF for assetKey:", def.assetKey);
      return;
    }

    const mesh = gltf.scene.clone(true);
    mesh.position.set(homeX, homeY, homeZ);
    mesh.scale.setScalar(def.scale);

    this.world
      .createTransformEntity(mesh)
      .addComponent(Interactable)
      .addComponent(DistanceGrabbable, {
        movementMode: MovementMode.MoveFromTarget,
      })
      .addComponent(Scannable, {
        productId: def.productId,
        lastScanTime: -1,
        homeX,
        homeY,
        homeZ,
      });
  }

  // ---------- Round state helpers ----------

  private resetRound() {
    this.timeRemaining = this.gameDurationSeconds;
    this.timerRunning = false;
    this.gameStarted = false;
    this.roundEnded = false;
    this.roundShown = false;
    this.timerWarningPlayed = false;

    this.scannedCount = 0;
    this.totalCartValue = 0;
    this.lastScoreValue = 0;
    this.lastTotalValue = 0;

    if (this.scoreTextTexture) {
      this.updateScoreTextTexture(0, 0);
    }

    if (this.timerTextTexture) {
      this.updateTimerTextTexture(this.gameDurationSeconds);
      this.lastTimerSeconds = Math.ceil(this.gameDurationSeconds);
    }

    if (this.roundPanelEntity?.object3D) {
      this.roundPanelEntity.object3D.visible = false;
    }
    if (this.roundMessageEntity?.object3D) {
      this.roundMessageEntity.object3D.visible = false;
    }

    // Do not re-show onboarding on subsequent rounds
  }

  // ---------- Round complete handling ----------

  private showRoundComplete() {
    if (this.roundShown) return;
    this.roundShown = true;
    this.roundEnded = true;

    // Anchor directly in front of the user's camera
    const cam = this.world.camera as any;
    const forward = new Vector3();
    let anchorPos: Vector3 | null = null;

    if (cam && cam.position) {
      if (typeof cam.getWorldDirection === "function") {
        cam.getWorldDirection(forward);
      } else {
        forward.set(0, 0, -1);
      }
      forward.normalize();

      const dist = 1.0; // UPDATED: bring panel/message closer than POS
      anchorPos = cam.position.clone().add(forward.multiplyScalar(dist));
      anchorPos.y = cam.position.y + 0.05; // slightly above eye level
    } else {
      // Fallback to scanner / default
      for (const scanner of this.queries.scanners.entities) {
        const scannerObj = scanner.object3D;
        if (!scannerObj) continue;
        anchorPos = anchorPos ?? new Vector3();
        scannerObj.getWorldPosition(anchorPos);
        break;
      }
      if (!anchorPos) {
        anchorPos = new Vector3(0, 1.6, 0.2);
      }
    }

    const hitGoal = this.totalCartValue >= this.goalCartValue;

    // Play win/lose sound once per round (game over)
    if (hitGoal) {
      this.playWinSound();
    } else {
      this.playLoseSound();
    }

    const camObj = this.world.camera;

    if (this.roundPanelEntity && this.roundPanelEntity.object3D) {
      const obj = this.roundPanelEntity.object3D;

      obj.position.copy(anchorPos);
      if (camObj && camObj.position) {
        obj.lookAt(camObj.position);
      }

      obj.visible = true;

      try {
        const panel = this.roundPanelEntity.getComponent(PanelUI) as any;
        const doc = panel?.uiDocument;
        const scoreEl = doc?.getElementById?.("roundScore");
        if (scoreEl && typeof scoreEl.setProps === "function") {
          scoreEl.setProps({
            value: `Items: ${this.scannedCount} | Total: $${this.totalCartValue.toFixed(
              2,
            )} (Goal: $${this.goalCartValue.toFixed(2)})`,
          });
        }
      } catch {
        // ignore
      }
    }

    if (
      this.roundMessageEntity &&
      this.roundMessageEntity.object3D &&
      this.roundMessageTexture
    ) {
      this.updateRoundMessageTexture(this.scannedCount, this.totalCartValue);

      const msgObj = this.roundMessageEntity.object3D;

      msgObj.position.copy(anchorPos);
      msgObj.position.y += 0.30; // slightly above the panel

      if (camObj && camObj.position) {
        msgObj.lookAt(camObj.position);
      }

      msgObj.visible = true;
    }
  }

  // ---------- Main update ----------

  update(delta: number, time: number) {
    // Timer
    if (this.timerRunning) {
      const prevTime = this.timeRemaining;
      this.timeRemaining -= delta;

      // 10-second warning (play once when crossing from >10 to <=10)
      if (
        !this.timerWarningPlayed &&
        prevTime > 10 &&
        this.timeRemaining <= 10 &&
        this.timeRemaining > 0
      ) {
        this.playTimerWarningSound();
        this.timerWarningPlayed = true;
      }

      if (this.timeRemaining <= 0) {
        this.timeRemaining = 0;
        this.timerRunning = false;
        this.showRoundComplete();
      }
    }

    const currentSeconds = Math.ceil(this.timeRemaining);
    if (
      this.timerTextTexture &&
      currentSeconds !== this.lastTimerSeconds &&
      currentSeconds >= 0
    ) {
      this.lastTimerSeconds = currentSeconds;
      this.updateTimerTextTexture(this.timeRemaining);
    }

    // Keep onboarding hint anchored once in front of the user until hidden
    this.updateOnboardingVisual();

    const cooldown = this.config.scanCooldown.value;

    // Track which entities have been scanned this frame
    const scannedThisFrame = new Set<any>();

    // Collect respawns to do AFTER iteration
    const respawns: {
      homeX: number;
      homeY: number;
      homeZ: number;
      entity: any;
    }[] = [];

    for (const scanner of this.queries.scanners.entities) {
      const scannerObj = scanner.object3D;
      if (!scannerObj) continue;

      const baseRadius =
        scanner.getValue(ScannerZone, "radius") ??
        this.config.scanRadius.value;
      const zoneRadius = baseRadius * 1.1;
      const radiusSq = zoneRadius * zoneRadius;

      this.updateScannerAnimation(scannerObj, delta);
      this.updateTimerBarVisual(scannerObj);
      this.updateTimerTextPosition(scannerObj);
      this.updateScoreTextPosition(scannerObj);
      this.updateToastVisual(scannerObj, delta);

      scannerObj.getWorldPosition(this.scannerPos);

      for (const scannable of this.queries.scannables.entities) {
        if (scannedThisFrame.has(scannable)) continue;

        const scannableObj = scannable.object3D;
        if (!scannableObj) continue;

        // Skip any items that have already been scanned out
        const soUd = (scannableObj as any).userData || {};
        if (soUd.scannedOut) continue;

        scannableObj.getWorldPosition(this.scannablePos);
        const distSq = this.scannerPos.distanceToSquared(this.scannablePos);
        if (distSq > radiusSq) continue;

        const last = scannable.getValue(Scannable, "lastScanTime") ?? -1;
        if (last >= 0 && time - last < cooldown) continue;

        // If the round is over, a scan restarts it
        if (!this.timerRunning && this.timeRemaining <= 0) {
          if (this.roundEnded) {
            this.resetRound();
          } else {
            continue;
          }
        }

        if (!this.gameStarted) {
          this.gameStarted = true;
          this.timerRunning = true;

          // First scan hides onboarding panel
          this.onboardingVisible = false;
          if (this.onboardingEntity?.object3D) {
            this.onboardingEntity.object3D.visible = false;
          }
        }

        scannable.setValue(Scannable, "lastScanTime", time);

        const productId = scannable.getValue(Scannable, "productId") ?? "";
        console.log("[ScannerSystem] Scanned product:", productId);

        scannedThisFrame.add(scannable);

        // Update score
        this.scannedCount += 1;

        // Update cart total
        const info = this.productInfo[productId];
        if (info) {
          this.totalCartValue += info.price;
        }

        if (
          this.scoreTextTexture &&
          (this.scannedCount !== this.lastScoreValue ||
            this.totalCartValue !== this.lastTotalValue)
        ) {
          this.lastScoreValue = this.scannedCount;
          this.lastTotalValue = this.totalCartValue;
          this.updateScoreTextTexture(this.scannedCount, this.totalCartValue);
        }

        // Build and show product label in toast
        const label = this.getProductLabel(productId);
        this.playScanSound();
        this.triggerScanPulse(scannerObj);
        this.showScanToast(label);

        const homeX =
          scannable.getValue(Scannable, "homeX") ?? this.scannerPos.x;
        const homeY =
          scannable.getValue(Scannable, "homeY") ?? this.scannerPos.y;
        const homeZ =
          scannable.getValue(Scannable, "homeZ") ?? this.scannerPos.z;

        if (scannableObj) {
          scannableObj.visible = false;
          scannableObj.position.set(0, -999, 0);

          // Mark this mesh as permanently scanned out
          (scannableObj as any).userData = {
            ...(scannableObj as any).userData,
            scannedOut: true,
          };
        }

        respawns.push({ homeX, homeY, homeZ, entity: scannable });

        // Only one scannable per scanner per frame
        break;
      }
    }

    // Spawn new products – de-duplicate by home slot so only one spawn per slot per frame
    if (respawns.length > 0) {
      const usedSlots = new Set<string>();

      for (const r of respawns) {
        const key = `${r.homeX.toFixed(3)}|${r.homeY.toFixed(
          3,
        )}|${r.homeZ.toFixed(3)}`;
        if (usedSlots.has(key)) {
          continue;
        }
        usedSlots.add(key);
        this.spawnRandomProductAt(r.homeX, r.homeY, r.homeZ);
      }
    }
  }
}
