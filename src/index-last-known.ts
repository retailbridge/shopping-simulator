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

  // Cashier beep used by ScannerSystem (scanner.ts creates its own AudioSource)
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

  // Kept in case you reuse the plant later
  plantSansevieria: {
    url: "./gltf/plantSansevieria/plantSansevieria.gltf",
    type: AssetType.GLTF,
    priority: "normal",
  },

  robot: {
    url: "./gltf/robot/robot.gltf",
    type: AssetType.GLTF,
    priority: "critical",
  },

  // Product models (folders as in /public/gltf/*/model.gltf)
  redApple: {
    url: "./gltf/red-apple/model.gltf",
    type: AssetType.GLTF,
    priority: "normal",
  },
  pear: {
    url: "./gltf/pear/model.gltf",
    type: AssetType.GLTF,
    priority: "normal",
  },
  cerealCocoaCritters: {
    url: "./gltf/cereal-cocoa-critters/model.gltf",
    type: AssetType.GLTF,
    priority: "normal",
  },
  chickenFriedRice: {
    url: "./gltf/chicken-fried-rice/model.gltf",
    type: AssetType.GLTF,
    priority: "normal",
  },
  chickenStrips: {
    url: "./gltf/chicken-strips/model.gltf",
    type: AssetType.GLTF,
    priority: "normal",
  },
  fleeceJacket: {
    url: "./gltf/fleece-jacket/model.gltf",
    type: AssetType.GLTF,
    priority: "normal",
  },
  glasses: {
    url: "./gltf/glasses/model.gltf",
    type: AssetType.GLTF,
    priority: "normal",
  },
  goldBar: {
    url: "./gltf/gold-bar/model.gltf",
    type: AssetType.GLTF,
    priority: "normal",
  },
  industrialShoe: {
    url: "./gltf/industrial-shoe/model.gltf",
    type: AssetType.GLTF,
    priority: "normal",
  },
  presentBox: {
    url: "./gltf/present-box/model.gltf",
    type: AssetType.GLTF,
    priority: "normal",
  },
  shoe: {
    url: "./gltf/shoe/model.gltf",
    type: AssetType.GLTF,
    priority: "normal",
  },
};

// Simple config for products we can spawn on the desk
type ProductConfig = {
  assetKey: string;   // key in `assets` / AssetManager
  productId: string;  // ID used in Scannable + products.ts
  scale: number;      // uniform scale factor for mesh
};

// Tuned scales: you already adjusted apple, pear, cereal.
// Others are reasonable guesses and can be tweaked.
const PRODUCT_POOL: ProductConfig[] = [
  { assetKey: "redApple", productId: "redApple", scale: 0.28 },
  { assetKey: "pear", productId: "pear", scale: 0.10 },
  {
    assetKey: "cerealCocoaCritters",
    productId: "cerealCocoaCritters",
    scale: 0.010,
  },
  { assetKey: "goldBar", productId: "goldBar", scale: 0.42 },
  { assetKey: "shoe", productId: "shoe", scale: 1.3 },
  { assetKey: "industrialShoe", productId: "industrialShoe", scale: 1.50 },
  { assetKey: "chickenFriedRice", productId: "chickenFriedRice", scale: 0.013 },
  { assetKey: "chickenStrips", productId: "chickenStrips", scale: 1.25 },
  { assetKey: "fleeceJacket", productId: "fleeceJacket", scale: 0.36 },
  { assetKey: "glasses", productId: "glasses", scale: 0.02 },
  { assetKey: "presentBox", productId: "presentBox", scale: 0.18 },
];

// Three fixed desk slots (front row) – Z is filled in with deskFrontZ later
// Slightly adjusted so rightmost slot sits a bit further from the scanner.
const DESK_SLOTS = [
  { x: -0.25, y: 0.87, dz: -0.05 }, // left
  { x:  0.10, y: 0.87, dz: -0.05 }, // center
  { x:  0.40, y: 0.90, dz: -0.10 }, // right (slightly further back)
];

// Helper: pick N distinct random products from the pool
function pickRandomProducts(pool: ProductConfig[], count: number): ProductConfig[] {
  const copy = [...pool];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy.slice(0, Math.min(count, copy.length));
}

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
    // Expose world for splash/index.html logic
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
    // Helper: spawn a scannable product on the desk
    //
    function spawnProduct(
      assetKey: string,
      productId: string,
      x: number,
      y: number,
      z: number,
      scale: number,
    ) {
      const gltf = AssetManager.getGLTF(assetKey);
      if (!gltf) {
        console.warn("[index] Missing asset:", assetKey);
        return;
      }

      const mesh = gltf.scene.clone(true);
      mesh.position.set(x, y, z);
      mesh.scale.setScalar(scale);

      world
        .createTransformEntity(mesh)
        .addComponent(Interactable)
        .addComponent(DistanceGrabbable, {
          movementMode: MovementMode.MoveFromTarget,
        })
        .addComponent(Scannable, {
          productId, // Should match src/data/products.ts IDs
          homeX: x,
          homeY: y,
          homeZ: z,
        });
    }

    //
    // RANDOMIZED PRODUCTS ON DESK
    //
    const selectedProducts = pickRandomProducts(PRODUCT_POOL, DESK_SLOTS.length);

    selectedProducts.forEach((config, index) => {
      const slot = DESK_SLOTS[index];
      spawnProduct(
        config.assetKey,
        config.productId,
        slot.x,
        slot.y,
        deskFrontZ + slot.dz,
        config.scale,
      );
    });

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
    // Bring it slightly closer and slightly less far to the right
    scannerMesh.position.set(0.7, 0.86, deskFrontZ + 0.05);

    world
      .createTransformEntity(scannerMesh)
      .addComponent(ScannerZone, {
        radius: 0.20, // slightly smaller to reduce accidental triggers
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
      menuPanelEntity.object3D.position.set(-0.6, 1.25, -0.9);
      menuPanelEntity.object3D.lookAt(0, 1.25, 0);

      const menuBack = new Mesh(
        new PlaneGeometry(0.9, 0.55),
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
      // Just behind the products
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
