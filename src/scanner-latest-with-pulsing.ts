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
 */
export const ScannerZone = createComponent("ScannerZone", {
  productId: { type: Types.String, default: "" },
});

/**
 * Objects that can be scanned.
 */
export const Scannable = createComponent("Scannable", {
  productId: { type: Types.String, default: "" },
  lastScanTime: { type: Types.Float32, default: -1 },
});

/**
 * Scanner system:
 * - Detects scannables inside radius
 * - Plays *cashier.mp3*
 * - Applies pulse animation
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

  init() {
    this.scannerPos = new Vector3();
    this.scannablePos = new Vector3();

    // 🔊 Updated sound: cashier.mp3
    this.audioEntity = this.world
      .createTransformEntity()
      .addComponent(AudioSource, {
        src: "./audio/cashier.mp3",
        maxInstances: 3,
        playbackMode: PlaybackMode.FadeRestart,
      });
  }

  private playScanSound() {
    if (this.audioEntity) {
      AudioUtils.play(this.audioEntity);
    }
  }

  private startPulseForScanner(scannerObj: any, time: number) {
    try {
      const mesh = scannerObj as any;
      const userData: any = mesh.userData || (mesh.userData = {});

      if (!userData.baseScale) {
        userData.baseScale = mesh.scale.clone();
      }

      userData.lastPulseTime = time;
    } catch (e) {
      console.warn("[ScannerSystem] startPulse failed:", e);
    }
  }

  private updateScannerPulse(scannerObj: any, time: number) {
    try {
      const mesh = scannerObj as any;
      const userData: any = mesh.userData;
      if (!userData || !userData.baseScale) return;

      const baseScale = userData.baseScale;
      const lastPulseTime = userData.lastPulseTime;

      if (typeof lastPulseTime !== "number") {
        mesh.scale.copy(baseScale);
        return;
      }

      const pulseDuration = 0.25;
      const elapsed = time - lastPulseTime;

      if (elapsed >= pulseDuration) {
        mesh.scale.copy(baseScale);
        return;
      }

      const t = 1 - elapsed / pulseDuration;
      const scaleFactor = 1 + 0.15 * t;

      mesh.scale.set(
        baseScale.x * scaleFactor,
        baseScale.y * scaleFactor,
        baseScale.z * scaleFactor,
      );
    } catch (e) {
      console.warn("[ScannerSystem] updatePulse failed:", e);
    }
  }

  update(delta: number, time: number) {
    const radius = this.config.scanRadius.value;
    const radiusSq = radius * radius;
    const cooldown = this.config.scanCooldown.value;

    for (const scanner of this.queries.scanners.entities) {
      const scannerObj = scanner.object3D;
      if (!scannerObj) continue;

      scannerObj.getWorldPosition(this.scannerPos);

      for (const scannable of this.queries.scannables.entities) {
        const scannableObj = scannable.object3D;
        if (!scannableObj) continue;

        scannableObj.getWorldPosition(this.scannablePos);

        const distSq = this.scannerPos.distanceToSquared(this.scannablePos);
        if (distSq > radiusSq) continue;

        const last = scannable.getValue(Scannable, "lastScanTime") ?? -1;
        if (last >= 0 && time - last < cooldown) continue;

        scannable.setValue(Scannable, "lastScanTime", time);

        const productId = scannable.getValue(Scannable, "productId") ?? "";
        console.log("[ScannerSystem] Scanned:", productId);

        // 🔊 Play cashier sound
        this.playScanSound();

        // ✨ Pulse animation
        this.startPulseForScanner(scannerObj, time);
      }

      // Update pulse every frame
      this.updateScannerPulse(scannerObj, time);
    }
  }
}
