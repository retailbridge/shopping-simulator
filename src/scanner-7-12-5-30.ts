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
  // Optional: associate this scanner with a default product if you like
  productId: { type: Types.String, default: "" },
  // Optional per-zone radius override (meters)
  radius: { type: Types.Float32, default: 0.25 },
});

/**
 * Tag for objects that can be scanned (e.g., the plant, later the shoe).
 * Attach this to entities you want the scanner to detect.
 */
export const Scannable = createComponent("Scannable", {
  productId: { type: Types.String, default: "" },
  // Used to prevent the sound from firing every single frame
  lastScanTime: { type: Types.Float32, default: -1 },
  // NEW: whether this object has been counted for score in the current round
  scannedThisRound: { type: Types.Boolean, default: false },
});

/**
 * Scanner system:
 * - Checks distance between ScannerZone and Scannable entities.
 * - When within radius and cooldown has passed, triggers a scan event.
 * - Plays cashier sound for feedback.
 * - Adds a glow + pulse animation on the scanner surface.
 * - Shows a "Scanned" toast using scan-toast.uikitml in XR.
 * - Adds a world-space countdown bar + numeric timer above the scanner.
 * - Adds a world-space score HUD ("Scanned: N") near the timer.
 * - Adds onboarding & round-complete panels anchored above the scanner.
 * - Implements a simple round-based game loop.
 */
export class ScannerSystem extends createSystem(
  {
    scanners: { required: [ScannerZone] },
    scannables: { required: [Scannable] },
  },
  {
    // Fallback scan radius if a ScannerZone has no explicit radius set
    scanRadius: { type: Types.Float32, default: 0.25 },
    // Minimum time between scans of the same object (seconds)
    scanCooldown: { type: Types.Float32, default: 0.75 },
  },
) {
  private scannerPos!: Vector3;
  private scannablePos!: Vector3;

  private audioEntity: any | null = null;

  // --- Timer / round state ---
  private readonly gameDurationSeconds = 60; // 1-minute round
  private timeRemaining = this.gameDurationSeconds;
  private timerRunning = false;
  private hasRoundStarted = false; // becomes true once first scan starts the round
  private roundOver = false; // becomes true when time hits 0

  // --- Score state ---
  private scannedCount = 0;
  private lastScoreValue = -1;

  // --- World-space timer bar above scanner ---
  private timerBarEntity: any | null = null;
  private timerBarMaterial: MeshBasicMaterial | null = null;

  // --- World-space timer text (mm:ss) ---
  private timerTextCanvas: HTMLCanvasElement | null = null;
  private timerTextContext: CanvasRenderingContext2D | null = null;
  private timerTextTexture: CanvasTexture | null = null;
  private timerTextEntity: any | null = null;
  private lastTimerSeconds: number = -1;

  // --- World-space score text ("Scanned: N") ---
  private scoreTextCanvas: HTMLCanvasElement | null = null;
  private scoreTextContext: CanvasRenderingContext2D | null = null;
  private scoreTextTexture: CanvasTexture | null = null;
  private scoreTextEntity: any | null = null;

  // --- World-space toast panel ("Scanned ✓") ---
  private toastEntity: any | null = null;
  private toastTimer = 0; // seconds remaining for toast visibility

  // --- Onboarding & round-complete panels ---
  private onboardingPanelEntity: any | null = null;
  private summaryPanelEntity: any | null = null;

  // Animation config for scanner pulse
  private static readonly PULSE_DURATION = 0.25; // seconds
  private static readonly PULSE_SCALE = 1.15; // max scale during pulse

  init() {
    // Reusable vectors
    this.scannerPos = new Vector3();
    this.scannablePos = new Vector3();

    // Audio entity using cashier sound
    this.audioEntity = this.world
      .createTransformEntity()
      .addComponent(AudioSource, {
        src: "./audio/cashier.mp3",
        maxInstances: 3,
        playbackMode: PlaybackMode.FadeRestart,
      });

    // XR countdown bar above the scanner
    this.setupTimerBarEntity();

    // XR numeric timer text (mm:ss) above the bar
    this.setupTimerTextEntity();

    // XR score HUD ("Scanned: N") near the timer
    this.setupScoreTextEntity();

    // XR toast panel from scan-toast.uikitml
    this.setupToastPanel();

    // NEW: Onboarding + round-complete panels
    this.setupOnboardingPanel();
    this.setupSummaryPanel();

    // Round is idle at startup (timer not running until first scan)
    this.resetRoundState(false);
  }

  /**
   * Reset round state (score + timer + per-object flags).
   * If `startRunning` is true, the timer starts immediately.
   */
  private resetRoundState(startRunning: boolean) {
    this.timeRemaining = this.gameDurationSeconds;
    this.timerRunning = startRunning;
    this.hasRoundStarted = startRunning;
    this.roundOver = !startRunning;

    // Score
    this.scannedCount = 0;
    this.lastScoreValue = 0;
    this.updateScoreTextTexture(0);

    // Reset all scannables for the new round
    for (const entity of this.queries.scannables.entities) {
      entity.setValue(Scannable, "scannedThisRound", false);
      entity.setValue(Scannable, "lastScanTime", -1);
    }

    // Reset timer display
    this.lastTimerSeconds = Math.ceil(this.gameDurationSeconds);
    this.updateTimerTextTexture(this.gameDurationSeconds);
  }

  /**
   * Called when we want to begin a fresh round,
   * typically triggered by the first scan input.
   */
  private beginNewRound() {
    this.resetRoundState(true); // timer running
    this.hideOnboardingPanel();
    this.hideRoundComplete();
  }

  // ---------------------------------------------------------------------------
  //  WORLD-SPACE UI SETUP
  // ---------------------------------------------------------------------------

  /**
   * Creates the world-space timer bar entity visible in XR.
   */
  private setupTimerBarEntity() {
    // Geometry: 40cm wide, 6cm tall bar
    const barGeometry = new PlaneGeometry(0.4, 0.06);
    this.timerBarMaterial = new MeshBasicMaterial({
      color: 0x00ff66,
      transparent: true,
      opacity: 0.9,
      side: 2, // DoubleSide
    });

    const barMesh = new Mesh(barGeometry, this.timerBarMaterial);
    this.timerBarEntity = this.world.createTransformEntity(barMesh);
  }

  /**
   * Creates a small world-space text plane that shows the countdown (mm:ss).
   */
  private setupTimerTextEntity() {
    if (typeof document === "undefined") {
      // In non-browser env, skip; bar will still work
      return;
    }

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

    // Initialize with full duration
    this.updateTimerTextTexture(this.gameDurationSeconds);
    this.lastTimerSeconds = Math.ceil(this.gameDurationSeconds);
  }

  /**
   * Render mm:ss text into the timer text canvas.
   */
  private updateTimerTextTexture(seconds: number) {
    if (
      !this.timerTextCanvas ||
      !this.timerTextContext ||
      !this.timerTextTexture
    ) {
      return;
    }

    const canvas = this.timerTextCanvas;
    const ctx = this.timerTextContext;

    const total = Math.max(0, Math.floor(seconds));
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    const label = `${mins}:${secs.toString().padStart(2, "0")}`;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = "rgba(0, 0, 0, 0)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.font = "bold 42px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
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

  /**
   * Creates a small world-space text plane that shows the score ("Scanned: N").
   */
  private setupScoreTextEntity() {
    if (typeof document === "undefined") {
      return;
    }

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

    // Initialize with score 0
    this.updateScoreTextTexture(0);
    this.lastScoreValue = 0;
  }

  /**
   * Render "Scanned: N" into the score text canvas.
   */
  private updateScoreTextTexture(score: number) {
    if (
      !this.scoreTextCanvas ||
      !this.scoreTextContext ||
      !this.scoreTextTexture
    ) {
      return;
    }

    const canvas = this.scoreTextCanvas;
    const ctx = this.scoreTextContext;

    const label = `Scanned: ${score}`;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = "rgba(0, 0, 0, 0)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.font = "bold 40px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
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

  /**
   * Creates the world-space toast panel using scan-toast.uikitml.
   * The UI compiler should generate ./ui/scan-toast.json.
   */
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

  /**
   * Onboarding panel shown before the first round starts.
   */
  private setupOnboardingPanel() {
    this.onboardingPanelEntity = this.world
      .createTransformEntity()
      .addComponent(PanelUI, {
        config: "./ui/onboarding.json",
        maxHeight: 0.5,
        maxWidth: 0.8,
      });

    if (this.onboardingPanelEntity.object3D) {
      this.onboardingPanelEntity.object3D.visible = true;
    }
  }

  /**
   * Round-complete panel shown when the timer hits zero.
   */
  private setupSummaryPanel() {
    this.summaryPanelEntity = this.world
      .createTransformEntity()
      .addComponent(PanelUI, {
        config: "./ui/round-complete.json",
        maxHeight: 0.4,
        maxWidth: 0.7,
      });

    if (this.summaryPanelEntity.object3D) {
      this.summaryPanelEntity.object3D.visible = false;
    }
  }

  private hideOnboardingPanel() {
    if (this.onboardingPanelEntity && this.onboardingPanelEntity.object3D) {
      this.onboardingPanelEntity.object3D.visible = false;
    }
  }

  private showOnboardingPanel() {
    if (this.onboardingPanelEntity && this.onboardingPanelEntity.object3D) {
      this.onboardingPanelEntity.object3D.visible = true;
    }
  }

  private hideRoundComplete() {
    if (this.summaryPanelEntity && this.summaryPanelEntity.object3D) {
      this.summaryPanelEntity.object3D.visible = false;
    }
  }

  private showRoundComplete() {
    if (this.summaryPanelEntity && this.summaryPanelEntity.object3D) {
      this.summaryPanelEntity.object3D.visible = true;
    }
  }

  /**
   * Start (or restart) the timer.
   */
  private startTimer() {
    this.timerRunning = true;
  }

  /**
   * Stop the timer when the round ends.
   */
  private stopTimer() {
    this.timerRunning = false;
  }

  private playScanSound() {
    if (this.audioEntity) {
      AudioUtils.play(this.audioEntity);
    }
  }

  /**
   * Kicks off a brief glow + pulse animation on the scanner surface.
   * All state is stored in scanner.object3D.userData to avoid new components.
   */
  private triggerScanPulse(scannerObject3D: any) {
    if (!scannerObject3D) return;

    const userData = (scannerObject3D.userData =
      scannerObject3D.userData || {});
    userData.pulseTimer = ScannerSystem.PULSE_DURATION;
  }

  /**
   * Per-frame animation update for glow + pulse of the scanner pad.
   */
  private updateScannerAnimation(scannerObject3D: any, delta: number) {
    if (!scannerObject3D) return;

    const userData = (scannerObject3D.userData =
      scannerObject3D.userData || {});

    if (typeof userData.pulseTimer !== "number") {
      userData.pulseTimer = 0;
    }

    let pulseTimer: number = userData.pulseTimer;

    // If no active pulse, ensure scanner is in base state and exit
    if (pulseTimer <= 0) {
      scannerObject3D.scale.set(1, 1, 1);

      const material = scannerObject3D.material;
      if (material) {
        try {
          material.opacity = 0.35;
          if (material.color && typeof material.color.set === "function") {
            material.color.set(0x00ffcc);
          }
        } catch {
          // ignore material errors
        }
      }

      return;
    }

    // Advance timer
    pulseTimer -= delta;
    if (pulseTimer < 0) pulseTimer = 0;
    userData.pulseTimer = pulseTimer;

    // Normalized [0,1]
    const t = 1 - pulseTimer / ScannerSystem.PULSE_DURATION;
    const intensity = Math.sin(t * Math.PI); // 0 → 1 → 0

    // Scale pulse
    const scaleBase = 1.0;
    const scaleMax = ScannerSystem.PULSE_SCALE;
    const scale = scaleBase + (scaleMax - scaleBase) * intensity;
    scannerObject3D.scale.set(scale, scale, scale);

    // Glow / opacity tweak
    const material = scannerObject3D.material;
    if (material) {
      try {
        material.opacity = 0.35 + 0.45 * intensity;
        if (material.color && typeof material.color.set === "function") {
          material.color.set(0x00ff66);
        }
      } catch {
        // ignore material errors
      }
    }
  }

  /**
   * Update the world-space timer bar above the scanner for XR.
   * Shrinks over time and changes color as time runs out.
   * Also keeps the bar floating above the scanner and facing the camera.
   */
  private updateTimerBarVisual(scannerObject3D: any) {
    if (!this.timerBarEntity || !this.timerBarMaterial) return;

    const barObj = this.timerBarEntity.object3D;
    if (!barObj) return;

    // Position relative to scanner
    scannerObject3D.getWorldPosition(this.scannerPos);

    // Raise it above the pad
    barObj.position.copy(this.scannerPos);
    barObj.position.y += 0.35; // 35cm above pad

    const cam = this.world.camera;
    if (cam && cam.position) {
      barObj.lookAt(cam.position);
    }

    // Compute time ratio
    const ratio =
      this.gameDurationSeconds > 0
        ? this.timeRemaining / this.gameDurationSeconds
        : 0;
    const clamped = Math.max(0, Math.min(1, ratio));

    // Scale X from 1.0 → 0.1 as time goes to zero
    const minScale = 0.1;
    const maxScale = 1.0;
    const scaleX = minScale + (maxScale - minScale) * clamped;
    barObj.scale.set(scaleX, 1, 1);

    // Color: green → yellow → red as time runs out
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
      // ignore material errors
    }
  }

  /**
   * Position the timer text (mm:ss) above the bar.
   */
  private updateTimerTextPosition(scannerObject3D: any) {
    if (!this.timerTextEntity || !this.timerTextEntity.object3D) return;

    const textObj = this.timerTextEntity.object3D;

    scannerObject3D.getWorldPosition(this.scannerPos);
    textObj.position.copy(this.scannerPos);
    textObj.position.y += 0.42; // slightly above the bar

    const cam = this.world.camera;
    if (cam && cam.position) {
      textObj.lookAt(cam.position);
    }
  }

  /**
   * Position the score text ("Scanned: N") near the timer.
   */
  private updateScoreTextPosition(scannerObject3D: any) {
    if (!this.scoreTextEntity || !this.scoreTextEntity.object3D) return;

    const scoreObj = this.scoreTextEntity.object3D;

    scannerObject3D.getWorldPosition(this.scannerPos);
    scoreObj.position.copy(this.scannerPos);

    // Place it slightly below and clearly to the right of the timer cluster
    scoreObj.position.y += 0.30; // a bit below the timer text
    scoreObj.position.x += 0.30; // more to the right so it doesn’t overlap

    const cam = this.world.camera;
    if (cam && cam.position) {
      scoreObj.lookAt(cam.position);
    }
  }

  /**
   * Keep the onboarding panel anchored above / in front of the scanner.
   */
  private updateOnboardingPanelPosition(scannerObject3D: any) {
    if (!this.onboardingPanelEntity || !this.onboardingPanelEntity.object3D) {
      return;
    }
    const obj = this.onboardingPanelEntity.object3D;
    if (!obj.visible) return;

    scannerObject3D.getWorldPosition(this.scannerPos);
    obj.position.copy(this.scannerPos);
    obj.position.y += 0.6;
    obj.position.z -= 0.15; // nudge toward player

    const cam = this.world.camera;
    if (cam && cam.position) {
      obj.lookAt(cam.position);
    }
  }

  /**
   * Keep the round-complete panel anchored above the scanner.
   */
  private updateSummaryPanelPosition(scannerObject3D: any) {
    if (!this.summaryPanelEntity || !this.summaryPanelEntity.object3D) {
      return;
    }
    const obj = this.summaryPanelEntity.object3D;
    if (!obj.visible) return;

    scannerObject3D.getWorldPosition(this.scannerPos);
    obj.position.copy(this.scannerPos);
    obj.position.y += 0.6;
    obj.position.z -= 0.15;

    const cam = this.world.camera;
    if (cam && cam.position) {
      obj.lookAt(cam.position);
    }
  }

  /**
   * Update the world-space toast (scan-toast.uikitml) above the scanner.
   */
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

      // Position the toast above the scanner, slightly higher than the pad
      scannerObject3D.getWorldPosition(this.scannerPos);
      toastObj.position.copy(this.scannerPos);
      toastObj.position.y += 0.22; // 22cm above the pad

      const cam = this.world.camera;
      if (cam && cam.position) {
        toastObj.lookAt(cam.position);
      }
    }
  }

  /**
   * Trigger the toast to appear briefly.
   */
  private showScanToast() {
    if (!this.toastEntity || !this.toastEntity.object3D) return;

    this.toastTimer = 0.9; // seconds visible
    this.toastEntity.object3D.visible = true;
  }

  /**
   * Handle timer / round lifecycle per frame.
   */
  private updateRoundTimer(delta: number) {
    if (this.timerRunning) {
      this.timeRemaining -= delta;
      if (this.timeRemaining <= 0) {
        this.timeRemaining = 0;
        this.stopTimer();
        if (!this.roundOver) {
          this.roundOver = true;
          this.showRoundComplete();
        }
      }
    }

    // Update mm:ss text when whole seconds change
    const currentSeconds = Math.ceil(this.timeRemaining);
    if (
      this.timerTextTexture &&
      currentSeconds !== this.lastTimerSeconds &&
      currentSeconds >= 0
    ) {
      this.lastTimerSeconds = currentSeconds;
      this.updateTimerTextTexture(this.timeRemaining);
    }
  }

  // ---------------------------------------------------------------------------
  //  MAIN UPDATE
  // ---------------------------------------------------------------------------

  update(delta: number, time: number) {
    // --- TIMER UPDATE / ROUND LIFECYCLE ---
    this.updateRoundTimer(delta);

    const cooldown = this.config.scanCooldown.value;

    // For each scanner zone in the scene
    for (const scanner of this.queries.scanners.entities) {
      const scannerObj = scanner.object3D;
      if (!scannerObj) continue;

      // Slightly enlarge effective radius (~10%) for XR play
      const baseRadius =
        scanner.getValue(ScannerZone, "radius") ??
        this.config.scanRadius.value;
      const zoneRadius = baseRadius * 1.1;
      const radiusSq = zoneRadius * zoneRadius;

      // Always update scanner animation (even if nothing is being scanned)
      this.updateScannerAnimation(scannerObj, delta);

      // HUD + panel updates relative to this scanner
      this.updateTimerBarVisual(scannerObj);
      this.updateTimerTextPosition(scannerObj);
      this.updateScoreTextPosition(scannerObj);
      this.updateToastVisual(scannerObj, delta);
      this.updateOnboardingPanelPosition(scannerObj);
      this.updateSummaryPanelPosition(scannerObj);

      scannerObj.getWorldPosition(this.scannerPos);

      // Check all scannables against this scanner
      for (const scannable of this.queries.scannables.entities) {
        const scannableObj = scannable.object3D;
        if (!scannableObj) continue;

        scannableObj.getWorldPosition(this.scannablePos);

        const distSq = this.scannerPos.distanceToSquared(this.scannablePos);
        if (distSq > radiusSq) {
          continue;
        }

        // If round has ended, ignore scans until a new round is started
        // (new round starts when player scans again; handled below).
        if (this.roundOver && !this.timerRunning) {
          // Trigger a new round when player brings an item back to the scanner
          this.beginNewRound();
          // After beginNewRound, continue; the same frame will process the scan normally.
        }

        // If timer isn't running yet (pre-first-scan), start the first round now.
        if (!this.timerRunning && !this.hasRoundStarted) {
          this.beginNewRound();
        }

        const last = scannable.getValue(Scannable, "lastScanTime") ?? -1;
        if (last >= 0 && time - last < cooldown) {
          // Still in cooldown period; skip
          continue;
        }

        // If the round is over and timer not running, skip scoring (guard)
        if (!this.timerRunning && this.roundOver) {
          continue;
        }

        const alreadyScanned =
          scannable.getValue(Scannable, "scannedThisRound") ?? false;
        if (alreadyScanned) {
          // This item already counted in this round; ignore to prevent farming
          continue;
        }

        // Mark scan time and mark as scanned for this round
        scannable.setValue(Scannable, "lastScanTime", time);
        scannable.setValue(Scannable, "scannedThisRound", true);

        const productId = scannable.getValue(Scannable, "productId") ?? "";
        console.log("[ScannerSystem] Scanned product:", productId);

        // Increment score and update HUD (once per successful scan)
        this.scannedCount += 1;
        if (
          this.scoreTextTexture &&
          this.scannedCount !== this.lastScoreValue
        ) {
          this.lastScoreValue = this.scannedCount;
          this.updateScoreTextTexture(this.scannedCount);
        }

        // Play scan sound
        this.playScanSound();

        // Visual: glow + pulse on the scanner pad
        this.triggerScanPulse(scannerObj);

        // XR toast ("Scanned" panel)
        this.showScanToast();

        // Later:
        // - Track orders completed vs tasks
        // - Track how many of total items were scanned
      }
    }
  }
}
