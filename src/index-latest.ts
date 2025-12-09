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
} from "@iwsdk/core";

import {
  AudioSource,
  DistanceGrabbable,
  MovementMode,
  Interactable,
  PanelUI,
  PlaybackMode,
  ScreenSpace,
} from "@iwsdk/core";

import { EnvironmentType, LocomotionEnvironment } from "@iwsdk/core";
import { PanelSystem } from "./panel.js";
import { Robot } from "./robot.js";
import { RobotSystem } from "./robot.js";

// DoubleSide = 2 in three.js
const DOUBLE_SIDE = 2;

const assets: AssetManifest = {
  chimeSound: {
    url: "./audio/chime.mp3",
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
}).then((world) => {
  const { camera } = world;

  //
  // SPAWN POSITION — closer to the desk, facing it
  // Desk/plant are around z ≈ -1.8, so stand near the front.
  //
  camera.position.set(0.2, 1.6, -0.7);
  camera.lookAt(0.8, 1.0, -1.8);

  //
  // ENVIRONMENT
  //
  const { scene: envMesh } = AssetManager.getGLTF("environmentDesk")!;
  envMesh.rotateY(Math.PI);
  envMesh.position.set(0, -0.1, 0);
  world
    .createTransformEntity(envMesh)
    .addComponent(LocomotionEnvironment, { type: EnvironmentType.STATIC });

  //
  // FIRST PLANT
  //
  const { scene: plantMesh } = AssetManager.getGLTF("plantSansevieria")!;
  plantMesh.position.set(1.2, 0.85, -1.8);

  world
    .createTransformEntity(plantMesh)
    .addComponent(Interactable)
    .addComponent(DistanceGrabbable, {
      movementMode: MovementMode.MoveFromTarget,
    });

  //
  // SECOND PLANT (duplicate)
  //
  const secondPlantMesh = plantMesh.clone(true);
  secondPlantMesh.position.set(0.6, 0.85, -1.8);

  world
    .createTransformEntity(secondPlantMesh)
    .addComponent(Interactable)
    .addComponent(DistanceGrabbable, {
      movementMode: MovementMode.MoveFromTarget,
    });

  //
  // MAIN MENU PANEL (screen-space)
  //
  const menuPanelEntity = world
    .createTransformEntity()
    .addComponent(PanelUI, {
      config: "./ui/welcome.json",
      maxHeight: 0.8,
      maxWidth: 1.6,
    })
    .addComponent(Interactable)
    .addComponent(ScreenSpace, {
      top: "20px",
      left: "20px",
      height: "40%",
    });

  menuPanelEntity.object3D!.position.set(0, 1.29, -1.9);

  //
  // PRODUCT PANEL (world-space, behind right plant)
  //
  const productPanelEntity = world
    .createTransformEntity()
    .addComponent(PanelUI, {
      config: "./ui/welcome.json", // placeholder until plant-info.json exists
      maxHeight: 0.4,
      maxWidth: 0.6,
    })
    .addComponent(Interactable);

  if (productPanelEntity.object3D) {
    productPanelEntity.object3D.position.set(1.2, 1.5, -2.3);
    productPanelEntity.object3D.lookAt(0, 1.5, -3.0);
  }

  //
  // ROBOT
  //
  const { scene: robotMesh } = AssetManager.getGLTF("robot")!;
  robotMesh.position.set(-1.2, 0.95, -1.8);
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
  //  - 25% larger: 1.8 × 1.2
  //  - Static in world space
  //  - Double-sided
  //  - Horizontally flipped so text reads correctly
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

  // Place it higher and further back than the desk/plants
  logoBanner.position.set(0, 2.2, -3.8);

  // Face toward the center of the room
  logoBanner.rotation.set(0, Math.PI, 0);

  // Horizontal flip to correct reversed text
  logoBanner.scale.set(-1, 1, 1);

  world.createTransformEntity(logoBanner);

  //
  // SYSTEMS
  //
  world.registerSystem(PanelSystem).registerSystem(RobotSystem);
});
