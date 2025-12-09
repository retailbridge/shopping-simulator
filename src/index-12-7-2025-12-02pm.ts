// src/index.ts
import {
  AssetManifest,
  AssetType,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SessionMode,
  SRGBColorSpace,
  AssetManager,
  World,
  EnvironmentType,
  LocomotionEnvironment,
  Interactable,
  DistanceGrabbable,
  MovementMode,
  AudioSource,
  PlaybackMode,
  PanelUI,
} from "@iwsdk/core";

import { PanelSystem } from "./panel.js";
import { Robot, RobotSystem } from "./robot.js";
import { ScannerZone, Scannable, ScannerSystem } from "./scanner.js";

// DoubleSide = 2 in three.js
const DOUBLE_SIDE = 2;

// Move the whole desk cluster closer to XR origin
const DESK_Z_OFFSET = 1.3;

const assets: AssetManifest = {
  // Robot sound
  chimeSound: {
    url: "./audio/chime.mp3",
    type: AssetType.Audio,
    priority: "background",
  },

  // 🔊 Cashier beep used by ScannerSystem (scanner.ts will create its own AudioSource)
  cashierSound: {
    url: "./audio/cashier.mp3",
    type: AssetType.Audio,
    priority: "background",
  },

  webxr: {
    url: "./textures/webxr.png",
    type: AssetType.Texture,
    priority: "critical",
  },
  environmentDesk: {
    url: "./gltf/environmentDesk/environmentDesk.gltf",
    type: AssetType.GLTF,
    priority: "critical",
  },
  plantSansevieria: {
    url: "./gltf/plantSansevieria/plantSansevieria.gltf",
    type: AssetType.GLTF,
    priority: "critical",
  },
  robot: {
    url: "./gltf/robot/robot.gltf",
    type: AssetType.GLTF,
    priority: "critical",
  },

  // ✅ NEW: example product model – red apple
  // NOTE: adjust the URL if your actual file name is different.
  redApple: {
    url: "./gltf/red-apple/model.gltf",
    type: AssetType.GLTF,
    priority: "normal",
  },
};

World.create(document.getElementById("scene-container") as HTMLDivElement, {
  assets,
  xr: {
    sessionMode: SessionMode.ImmersiveVR,
    offer: "always",
    features: { handTracking: { required: true }, layers: false },
  },
  features: {
    locomotion: { useWorker: true },
    grabbing: true,
    physics: false,
    sceneUnderstanding: false,
  },
})
  .then((world) => {
    // Expose world for your splash index.html logic
    (globalThis as any).SHOP_WORLD = world;
    window.dispatchEvent(new CustomEvent("world-ready"));

    const { camera } = world;

    // Desktop / non-XR view only (XR head pose overrides this)
    camera.position.set(-4, 1.5, -6);
    camera.rotateY(-Math.PI * 0.75);

    // Register components + systems
    world
      .registerComponent(ScannerZone)
      .registerComponent(Scannable)
      .registerComponent(Robot)
      .registerSystem(PanelSystem)
      .registerSystem(RobotSystem)
      .registerSystem(ScannerSystem);

    //
    // ENVIRONMENT
    //
    const { scene: envMesh } = AssetManager.getGLTF("environmentDesk")!;
    envMesh.rotateY(Math.PI);
    envMesh.position.set(0, -0.1, DESK_Z_OFFSET);
    world
      .createTransformEntity(envMesh)
      .addComponent(LocomotionEnvironment, { type: EnvironmentType.STATIC });

    // Convenience: desk “front edge” Z in world space
    const deskFrontZ = -1.8 + DESK_Z_OFFSET; // originally -1.8, shifted forward

    //
    // PLANTS – front + left, and marked as Scannable
    //
    const { scene: plantMesh } = AssetManager.getGLTF("plantSansevieria")!;

    // Primary plant: directly in front of player
    plantMesh.position.set(0, 0.85, deskFrontZ);

    const plantEntity = world
      .createTransformEntity(plantMesh)
      .addComponent(Interactable)
      .addComponent(DistanceGrabbable, {
        movementMode: MovementMode.MoveFromTarget,
      })
      .addComponent(Scannable, {
        productId: "plantSansevieria",
      });

    // Second plant: to the left side
    const secondPlantMesh = plantMesh.clone(true);
    secondPlantMesh.position.set(-0.6, 0.85, deskFrontZ);

    const secondPlantEntity = world
      .createTransformEntity(secondPlantMesh)
      .addComponent(Interactable)
      .addComponent(DistanceGrabbable, {
        movementMode: MovementMode.MoveFromTarget,
      })
      .addComponent(Scannable, {
        productId: "plantSansevieria",
      });

    //
    // ✅ NEW PRODUCT – Red Apple on the desk (Scannable)
    //
    const appleGLTF = AssetManager.getGLTF("redApple");
    if (appleGLTF) {
      const appleMesh = appleGLTF.scene.clone(true);

      // Place it front-right on the desk, near the scanner
      appleMesh.position.set(0.3, 0.87, deskFrontZ);
      appleMesh.scale.setScalar(0.3); // adjust as needed based on model size

      world
        .createTransformEntity(appleMesh)
        .addComponent(Interactable)
        .addComponent(DistanceGrabbable, {
          movementMode: MovementMode.MoveFromTarget,
        })
        .addComponent(Scannable, {
          // Match this to your products.ts entry (e.g., "red_apple")
          productId: "redApple",
        });
    } else {
      console.warn(
        "[index] redApple GLTF not found – check the URL in assets.redApple.url",
      );
    }

    //
    // SCANNER ZONE – to the right
    //
    const scannerGeometry = new PlaneGeometry(0.3, 0.3);
    const scannerMaterial = new MeshBasicMaterial({
      color: 0x00ffcc,
      transparent: true,
      opacity: 0.35,
    });
    const scannerMesh = new Mesh(scannerGeometry, scannerMaterial);

    // Lay it flat on the desk
    scannerMesh.rotation.x = -Math.PI / 2;
    // Right side of the front plant
    scannerMesh.position.set(0.6, 0.86, deskFrontZ);

    world
      .createTransformEntity(scannerMesh)
      .addComponent(ScannerZone, {
        radius: 0.25,
      });

    //
    // MENU PANEL – world-space (welcome panel)
    //
    const menuPanelEntity = world
      .createTransformEntity()
      .addComponent(PanelUI, {
        config: "./ui/welcome.json",
        maxHeight: 0.5,
        maxWidth: 0.8,
      })
      .addComponent(Interactable);

    if (menuPanelEntity.object3D) {
      menuPanelEntity.object3D.position.set(-0.5, 1.4, -0.6);
      menuPanelEntity.object3D.lookAt(0, 1.4, 0);

      const menuBack = new Mesh(
        new PlaneGeometry(0.8, 0.5),
        new MeshBasicMaterial({
          color: 0x222222,
          transparent: true,
          opacity: 0.9,
        }),
      );
      menuBack.position.set(0, 0, -0.01);
      menuPanelEntity.object3D.add(menuBack);
    }

    //
    // PRODUCT PANEL – uses ui/product.json (driven by ScannerSystem)
    //
    const productPanelEntity = world
      .createTransformEntity()
      .addComponent(PanelUI, {
        config: "./ui/product.json",
        maxHeight: 0.4,
        maxWidth: 0.6,
      })
      .addComponent(Interactable);

    if (productPanelEntity.object3D) {
      // Just behind the front plant
      productPanelEntity.object3D.position.set(0, 1.5, deskFrontZ - 0.5);
      productPanelEntity.object3D.lookAt(0, 1.5, 0);
    }

    //
    // ROBOT – left side of desk
    //
    const { scene: robotMesh } = AssetManager.getGLTF("robot")!;
    robotMesh.position.set(-1.2, 0.95, deskFrontZ);
    robotMesh.scale.setScalar(0.5);

    world
      .createTransformEntity(robotMesh)
      .addComponent(Interactable)
      .addComponent(Robot)
      .addComponent(AudioSource, {
        src: "./audio/chime.mp3",
        maxInstances: 3,
        playbackMode: PlaybackMode.FadeRestart,
      });

    //
    // XR SHOPPING SIMULATOR BANNER
    //
    const webxrLogoTexture = AssetManager.getTexture("webxr")!;
    webxrLogoTexture.colorSpace = SRGBColorSpace;

    const bannerWidth = 1.8;
    const bannerHeight = 1.2;

    const logoBanner = new Mesh(
      new PlaneGeometry(bannerWidth, bannerHeight),
      new MeshBasicMaterial({
        map: webxrLogoTexture,
        transparent: true,
        side: DOUBLE_SIDE,
      }),
    );

    logoBanner.position.set(0, 2.2, -5.0 + DESK_Z_OFFSET);
    logoBanner.rotation.set(0, Math.PI, 0);
    logoBanner.scale.set(-1, 1, 1);

    world.createTransformEntity(logoBanner);
  })
  .catch((err) => {
    console.error("[WORLD] Failed to create world", err);
  });
