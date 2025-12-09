// src/scanner.ts

import {
  AudioSource,
  AudioUtils,
  PlaybackMode,
  Types,
  Vector3,
  createComponent,
  createSystem,
} from "@iwsdk/core";

/**
 * Zone that represents the scanner area.
 * Place this entity near your scanner surface in index.ts.
 */
export const ScannerZone = createComponent("ScannerZone", {
  // Optional: associate this scanner with a default product if you like
  productId: { type: Types.String, default: "" },
});

/**
 * Tag for objects that can be scanned (e.g., the plant, later the shoe).
 * Attach this to entities you want the scanner to detect.
 */
export const Scannable = createComponent("Scannable", {
  productId: { type: Types.String, default: "" },
  // Used to prevent the sound from firing every single frame
  lastScanTime: { type: Types.Float32, default: -1 },
});

/**
 * Scanner system:
 * - Checks distance between ScannerZone and Scannable entities.
 * - When within radius and cooldown has passed, triggers a scan event.
 * - Plays the existing chime sound for feedback.
 */
export class ScannerSystem extends createSystem(
  {
    scanners: { required: [ScannerZone] },
    scannables: { required: [Scannable] },
  },
  {
    // How close a scannable must be to count as "scanned" (meters)
    scanRadius: { type: Types.Float32, default: 0.25 },
    // Minimum time between scans of the same object (seconds)
    scanCooldown: { type: Types.Float32, default: 0.75 },
  },
) {
  private scannerPos!: Vector3;
  private scannablePos!: Vector3;
  private audioEntity: any | null = null;

  init() {
    // Reusable vectors
    this.scannerPos = new Vector3();
    this.scannablePos = new Vector3();

    // Create a dedicated audio entity using the existing chime sound.
    // This reuses the same file path you already use for the robot.
    this.audioEntity = this.world
      .createTransformEntity()
      .addComponent(AudioSource, {
        src: "./audio/chime.mp3",
        maxInstances: 3,
        playbackMode: PlaybackMode.FadeRestart,
      });
  }

  private playScanSound() {
    if (this.audioEntity) {
      AudioUtils.play(this.audioEntity);
    }
  }

  update(delta: number, time: number) {
    const radius = this.config.scanRadius.value;
    const radiusSq = radius * radius;
    const cooldown = this.config.scanCooldown.value;

    // For each scanner zone in the scene
    for (const scanner of this.queries.scanners.entities) {
      const scannerObj = scanner.object3D;
      if (!scannerObj) continue;

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

        const last = scannable.getValue(Scannable, "lastScanTime") ?? -1;
        if (last >= 0 && time - last < cooldown) {
          // Still in cooldown period; skip
          continue;
        }

        // Mark scan time
        scannable.setValue(Scannable, "lastScanTime", time);

        const productId = scannable.getValue(Scannable, "productId") ?? "";
        console.log("[ScannerSystem] Scanned product:", productId);

        // Play scan chime
        this.playScanSound();

        // Later: here is where you will hook into the product UI panel
        // and update it with product name/price/etc based on productId.
      }
    }
  }
}
