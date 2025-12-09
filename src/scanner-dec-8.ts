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
 */
export const Scannable = createComponent("Scannable", {
  productId: { type: Types.String, default: "" },
  lastScanTime: { type: Types.Float32, default: -1 },
});

/**
 * Scanner system:
 *  - detects scannables within a radius
 *  - plays a sound + pulse effect on scan
 *  - shows a “Scanned” toast (XR)
 *  - shows a 60s countdown bar + mm:ss timer
 *  - shows a score HUD (“Scanned: N”)
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
  private timerRunning = true;

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

  // --- Toast panel ---
  private toastEntity: any | null = null;
  private toastTimer = 0;

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

    // Toast
    this.setupToastPanel();

    // Initialise timer
    this.timeRemaining = this.gameDurationSeconds;
    this.timerRunning = true;
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

  // ---------- Main update ----------

  update(delta: number, time: number) {
    // Timer
    if (this.timerRunning) {
      this.timeRemaining -= delta;
      if (this.timeRemaining <= 0) {
        this.timeRemaining = 0;
        this.timerRunning = false;
        // (Later: show round-complete UI here)
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

        if (!this.timerRunning && this.timeRemaining <= 0) {
          continue;
        }

        scannable.setValue(Scannable, "lastScanTime", time);

        const productId = scannable.getValue(Scannable, "productId") ?? "";
        console.log("[ScannerSystem] Scanned product:", productId);

        this.scannedCount += 1;
        if (
          this.scoreTextTexture &&
          this.scannedCount !== this.lastScoreValue
        ) {
          this.lastScoreValue = this.scannedCount;
          this.updateScoreTextTexture(this.scannedCount);
        }

        this.playScanSound();
        this.triggerScanPulse(scannerObj);
        this.showScanToast();
      }
    }
  }
}
