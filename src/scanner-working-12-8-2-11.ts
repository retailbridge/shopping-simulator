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

/**
 * Scanner system:
 *  - detects scannables within a radius
 *  - plays a sound + pulse effect on scan
 *  - shows a “Scanned” toast (XR)
 *  - shows a 60s countdown bar + mm:ss timer
 *  - shows a score HUD (“Scanned: N”)
 *  - when an item is scanned, it is hidden and a new random item spawns
 *    back at its original desk slot
 *  - timer starts on the first scan
 *  - when timer ends, scanning stops and a round-complete toast is shown
 *  - scanning an item after time-up restarts the round
 */
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

  private audioEntity: any | null = null;

  // --- Timer state (game round) ---
  private readonly gameDurationSeconds = 60; // 1 minute round
  private timeRemaining = this.gameDurationSeconds;
  private timerRunning = false; // starts only after first scan
  private gameStarted = false;
  private roundEnded = false;

  // --- Score state ---
  private scannedCount = 0;
  private lastScoreValue = -1;

  // --- Timer bar ---
  private timerBarEntity: any | null = null;
  private timerBarMaterial: MeshBasicMaterial | null = null;

  // --- Timer text (mm:ss) ---
  private timerTextCanvas: HTMLCanvasElement | null = null;
  private timerTextContext: CanvasRenderingContext2D | null = null;
  private timerTextTexture: CanvasTexture | null = null;
  private timerTextEntity: any | null = null;
  private lastTimerSeconds: number = -1;

  // --- Score text ---
  private scoreTextCanvas: HTMLCanvasElement | null = null;
  private scoreTextContext: CanvasRenderingContext2D | null = null;
  private scoreTextTexture: CanvasTexture | null = null;
  private scoreTextEntity: any | null = null;

  // --- Scan toast panel ---
  private toastEntity: any | null = null;
  private toastTimer = 0;

  // --- Round-complete panel (PanelUI, optional) ---
  private roundPanelEntity: any | null = null;
  private roundShown = false;

  // --- Round-complete message (canvas-based, guaranteed visible) ---
  private roundMessageEntity: any | null = null;
  private roundMessageCanvas: HTMLCanvasElement | null = null;
  private roundMessageContext: CanvasRenderingContext2D | null = null;
  private roundMessageTexture: CanvasTexture | null = null;

  // --- Product catalog for respawns (Level 1 core loop) ---
  // Scales should mirror PRODUCT_POOL in index.ts for consistency.
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

  private static readonly PULSE_DURATION = 0.25;
  private static readonly PULSE_SCALE = 1.15;

  init() {
    this.scannerPos = new Vector3();
    this.scannablePos = new Vector3();

    // Audio
    this.audioEntity = this.world
      .createTransformEntity()
      .addComponent(AudioSource, {
        src: "./audio/cashier.mp3",
        maxInstances: 3,
        playbackMode: PlaybackMode.FadeRestart,
      });

    // Timer HUD
    this.setupTimerBarEntity();
    this.setupTimerTextEntity();

    // Score HUD
    this.setupScoreTextEntity();

    // Scan toast
    this.setupToastPanel();

    // Round-complete panel (PanelUI – optional)
    this.setupRoundCompletePanel();

    // Round-complete canvas message
    this.setupRoundMessageEntity();

    // Initialise timer and round state
    this.timeRemaining = this.gameDurationSeconds;
    this.timerRunning = false;
    this.gameStarted = false;
    this.roundEnded = false;
    this.roundShown = false;
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
    canvas.height = 96;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    this.scoreTextCanvas = canvas;
    this.scoreTextContext = ctx;

    const texture = new CanvasTexture(canvas);
    texture.needsUpdate = true;
    this.scoreTextTexture = texture;

    const geo = new PlaneGeometry(0.32, 0.09);
    const mat = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 1.0,
      side: 2,
    });

    const mesh = new Mesh(geo, mat);
    this.scoreTextEntity = this.world.createTransformEntity(mesh);

    this.updateScoreTextTexture(0);
    this.lastScoreValue = 0;
  }

  private setupToastPanel() {
    this.toastEntity = this.world
      .createTransformEntity()
      .addComponent(PanelUI, {
        config: "./ui/scan-toast.json",
        maxHeight: 0.12,
        maxWidth: 0.4,
      });

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
      obj.visible = false; // hidden until round ends
      obj.position.set(0, 1.6, 0.2);
    }
  }

  private setupRoundMessageEntity() {
    if (typeof document === "undefined") return;

    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 192;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    this.roundMessageCanvas = canvas;
    this.roundMessageContext = ctx;

    const texture = new CanvasTexture(canvas);
    texture.needsUpdate = true;
    this.roundMessageTexture = texture;

    const geo = new PlaneGeometry(0.6, 0.25);
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

  private updateScoreTextTexture(score: number) {
    if (
      !this.scoreTextCanvas ||
      !this.scoreTextContext ||
      !this.scoreTextTexture
    )
      return;

    const canvas = this.scoreTextCanvas;
    const ctx = this.scoreTextContext;

    const label = `Scanned: ${score}`;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(0, 0, 0, 0)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.font =
      "bold 40px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    ctx.shadowColor = "rgba(0, 0, 0, 0.7)";
    ctx.shadowBlur = 6;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 2;

    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, canvas.width / 2, canvas.height / 2);

    this.scoreTextTexture.needsUpdate = true;
  }

  private updateRoundMessageTexture(score: number) {
    if (
      !this.roundMessageCanvas ||
      !this.roundMessageContext ||
      !this.roundMessageTexture
    )
      return;

    const canvas = this.roundMessageCanvas;
    const ctx = this.roundMessageContext;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(0, 0, 0, 0)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    ctx.shadowColor = "rgba(0, 0, 0, 0.7)";
    ctx.shadowBlur = 6;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 2;

    // Line 1: Time's up!
    ctx.font =
      "bold 44px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.fillText("Time's up!", canvas.width / 2, canvas.height / 2 - 40);

    // Line 2: score
    ctx.font =
      "bold 36px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.fillText(
      `You scanned ${score} item${score === 1 ? "" : "s"}.`,
      canvas.width / 2,
      canvas.height / 2,
    );

    // Line 3: hint
    ctx.font =
      "normal 30px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.fillText(
      "Scan another item to play again.",
      canvas.width / 2,
      canvas.height / 2 + 40,
    );

    this.roundMessageTexture.needsUpdate = true;
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

  private showScanToast() {
    if (!this.toastEntity || !this.toastEntity.object3D) return;
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

  private playScanSound() {
    if (this.audioEntity) {
      AudioUtils.play(this.audioEntity);
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
    // Reset timer
    this.timeRemaining = this.gameDurationSeconds;
    this.timerRunning = false;
    this.gameStarted = false;
    this.roundEnded = false;
    this.roundShown = false;

    // Reset score
    this.scannedCount = 0;
    this.lastScoreValue = -1;
    if (this.scoreTextTexture) {
      this.updateScoreTextTexture(0);
      this.lastScoreValue = 0;
    }

    // Reset timer text
    if (this.timerTextTexture) {
      this.updateTimerTextTexture(this.gameDurationSeconds);
      this.lastTimerSeconds = Math.ceil(this.gameDurationSeconds);
    }

    // Hide round UI
    if (this.roundPanelEntity?.object3D) {
      this.roundPanelEntity.object3D.visible = false;
    }
    if (this.roundMessageEntity?.object3D) {
      this.roundMessageEntity.object3D.visible = false;
    }
  }

  // ---------- Round complete handling ----------

  private showRoundComplete() {
    if (this.roundShown) return;
    this.roundShown = true;
    this.roundEnded = true;

    // Anchor position: above the first scanner we find
    let anchorPos: Vector3 | null = null;
    for (const scanner of this.queries.scanners.entities) {
      const scannerObj = scanner.object3D;
      if (!scannerObj) continue;

      anchorPos = anchorPos ?? new Vector3();
      scannerObj.getWorldPosition(anchorPos);
      break;
    }

    const cam = this.world.camera;

    // Optional PanelUI (if your JSON works)
    if (this.roundPanelEntity && this.roundPanelEntity.object3D) {
      const obj = this.roundPanelEntity.object3D;

      if (anchorPos) {
        obj.position.copy(anchorPos);
        obj.position.y += 0.45;
      } else {
        obj.position.set(0, 1.6, 0.2);
      }

      if (cam && cam.position) {
        obj.lookAt(cam.position);
      }

      obj.visible = true;

      try {
        const panel = this.roundPanelEntity.getComponent(PanelUI) as any;
        const doc = panel?.uiDocument;
        const scoreEl = doc?.getElementById?.("roundScore");
        if (scoreEl && typeof scoreEl.setProps === "function") {
          scoreEl.setProps({
            value: `You scanned ${this.scannedCount} items`,
          });
        }
      } catch {
        // ignore
      }
    }

    // Canvas-based message (independent of PanelUI – always works)
    if (
      this.roundMessageEntity &&
      this.roundMessageEntity.object3D &&
      this.roundMessageTexture
    ) {
      this.updateRoundMessageTexture(this.scannedCount);

      const msgObj = this.roundMessageEntity.object3D;

      if (anchorPos) {
        msgObj.position.copy(anchorPos);
        msgObj.position.y += 0.65; // slightly above scanner
      } else {
        msgObj.position.set(0, 1.7, 0.2);
      }

      if (cam && cam.position) {
        msgObj.lookAt(cam.position);
      }

      msgObj.visible = true;
    }
  }

  // ---------- Main update ----------

  update(delta: number, time: number) {
    // Timer
    if (this.timerRunning) {
      this.timeRemaining -= delta;
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

    const cooldown = this.config.scanCooldown.value;

    // Collect respawns to do AFTER iteration (avoid mutating queries mid-loop)
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
        const scannableObj = scannable.object3D;
        if (!scannableObj) continue;

        scannableObj.getWorldPosition(this.scannablePos);
        const distSq = this.scannerPos.distanceToSquared(this.scannablePos);
        if (distSq > radiusSq) continue;

        const last = scannable.getValue(Scannable, "lastScanTime") ?? -1;
        if (last >= 0 && time - last < cooldown) continue;

        // If the round is over, allow this scan to restart the round
        if (!this.timerRunning && this.timeRemaining <= 0) {
          if (this.roundEnded) {
            this.resetRound();
            // fall through so this same scan counts as the first scan of the new round
          } else {
            continue;
          }
        }

        // First ever successful scan in the current round: start the round timer
        if (!this.gameStarted) {
          this.gameStarted = true;
          this.timerRunning = true;
        }

        scannable.setValue(Scannable, "lastScanTime", time);

        const productId = scannable.getValue(Scannable, "productId") ?? "";
        console.log("[ScannerSystem] Scanned product:", productId);

        // Increment score + HUD
        this.scannedCount += 1;
        if (
          this.scoreTextTexture &&
          this.scannedCount !== this.lastScoreValue
        ) {
          this.lastScoreValue = this.scannedCount;
          this.updateScoreTextTexture(this.scannedCount);
        }

        // Feedback
        this.playScanSound();
        this.triggerScanPulse(scannerObj);
        this.showScanToast();

        // Read the original desk-home position for this slot
        const homeX =
          scannable.getValue(Scannable, "homeX") ?? this.scannerPos.x;
        const homeY =
          scannable.getValue(Scannable, "homeY") ?? this.scannerPos.y;
        const homeZ =
          scannable.getValue(Scannable, "homeZ") ?? this.scannerPos.z;

        // Hide this scanned object and move it far away
        if (scannableObj) {
          scannableObj.visible = false;
          scannableObj.position.set(0, -999, 0);
        }

        // Queue a respawn back at the desk slot
        respawns.push({ homeX, homeY, homeZ, entity: scannable });
      }
    }

    // Spawn new products after we've finished iterating over queries
    if (respawns.length > 0) {
      for (const r of respawns) {
        this.spawnRandomProductAt(r.homeX, r.homeY, r.homeZ);
      }
    }
  }
}
