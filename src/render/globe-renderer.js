import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { cellToNestedId } from "../core/healpix-nested.js";
import { faceUvToVector, healpixVectorToDisplayVector, lonLatToVector, vectorToLonLat } from "../core/projection.js";
import { decodeSample } from "../data/tile-codec.js";
import { decodeQuantizedTileWasm } from "../data/wasm-decoder.js";
import {
  cellFromFaceUv,
  sourceCropForTarget,
  tileBounds,
  tileFromCell,
  tileGridSize,
  tileKey
} from "../core/tile-address.js";
import { clampOrder, detailOrderForBasePixels } from "./lod.js";
import {
  addTileToSelection,
  addTilesAlongLine,
  createTileSelection,
  isTileSelectionPointer
} from "./region-selection.js";
import { sampleTileValue } from "./tile-visual.js";

const PATCH_SEGMENTS = 18;
const GLOBE_RADIUS = 1.004;
const GLOBE_LOD_FACE_FACTOR = 1.45;
const GLOBE_MAX_DETAIL_DISTANCE_FACTOR = 1.04;
const MAX_GLOBE_VISIBLE_TILES = 1100;
const TILE_BOUNDING_RADIUS_SCALE = 1.12;
const SURFACE_DRAG_GAIN = 1.35;
const MIN_ROTATE_SPEED = 0.006;
const MAX_ROTATE_SPEED = 0.55;
const NEAR_ZOOM_SPEED = 0.42;
const FAR_ZOOM_SPEED = 0.78;
const NEAR_DAMPING = 0.32;
const FAR_DAMPING = 0.08;
const RELIEF_LAYER_PATTERN = /(elevation|height|terrain|topo|dem)/i;

const GLOBE_VERTEX_SHADER = `
out vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const GLOBE_FRAGMENT_SHADER_BODY = `
uniform bool uHasData;
uniform vec4 uCrop;
uniform vec2 uTexelSize;
uniform float uMin;
uniform float uMax;
uniform float uSymlogConstant;
uniform float uValueScale;
uniform float uValueOffset;
uniform float uNoData;
uniform int uScaleMode;
uniform int uColormap;
uniform int uDataType;
uniform bool uRelief;
uniform bool uGrid;
uniform bool uHasNoData;

in vec2 vUv;
out vec4 outColor;

__SAMPLE_ENCODED_VALUE__

float saturate(float value) {
  return clamp(value, 0.0, 1.0);
}

bool validValue(float value) {
  return value == value && abs(value) < 1.0e30;
}

float symlogTransform(float value, float constantValue) {
  float c = max(abs(constantValue), 1.0e-12);
  return sign(value) * log(1.0 + abs(value) / c);
}

float normalizedValue(float value) {
  if (!(uMax > uMin)) {
    return 0.5;
  }
  if (uScaleMode == 1) {
    float safeMin = max(uMin, 1.1920929e-7);
    float safeValue = max(value, safeMin);
    float denom = log(uMax) - log(safeMin);
    return denom == 0.0 ? 0.5 : saturate((log(safeValue) - log(safeMin)) / denom);
  }
  if (uScaleMode == 2) {
    float lo = symlogTransform(uMin, uSymlogConstant);
    float hi = symlogTransform(uMax, uSymlogConstant);
    return hi == lo ? 0.5 : saturate((symlogTransform(value, uSymlogConstant) - lo) / (hi - lo));
  }
  return saturate((value - uMin) / (uMax - uMin));
}

vec3 interpolateColor(vec3 a, vec3 b, float f) {
  return mix(a, b, saturate(f));
}

vec3 viridis(float t) {
  t = saturate(t);
  if (t <= 0.13) return interpolateColor(vec3(68.0, 1.0, 84.0), vec3(71.0, 44.0, 122.0), t / 0.13) / 255.0;
  if (t <= 0.25) return interpolateColor(vec3(71.0, 44.0, 122.0), vec3(59.0, 82.0, 139.0), (t - 0.13) / 0.12) / 255.0;
  if (t <= 0.38) return interpolateColor(vec3(59.0, 82.0, 139.0), vec3(44.0, 113.0, 142.0), (t - 0.25) / 0.13) / 255.0;
  if (t <= 0.5) return interpolateColor(vec3(44.0, 113.0, 142.0), vec3(33.0, 145.0, 140.0), (t - 0.38) / 0.12) / 255.0;
  if (t <= 0.63) return interpolateColor(vec3(33.0, 145.0, 140.0), vec3(39.0, 173.0, 129.0), (t - 0.5) / 0.13) / 255.0;
  if (t <= 0.75) return interpolateColor(vec3(39.0, 173.0, 129.0), vec3(92.0, 200.0, 99.0), (t - 0.63) / 0.12) / 255.0;
  if (t <= 0.88) return interpolateColor(vec3(92.0, 200.0, 99.0), vec3(170.0, 220.0, 50.0), (t - 0.75) / 0.13) / 255.0;
  return interpolateColor(vec3(170.0, 220.0, 50.0), vec3(253.0, 231.0, 37.0), (t - 0.88) / 0.12) / 255.0;
}

vec3 magma(float t) {
  t = saturate(t);
  if (t <= 0.14) return interpolateColor(vec3(0.0, 0.0, 4.0), vec3(31.0, 17.0, 81.0), t / 0.14) / 255.0;
  if (t <= 0.28) return interpolateColor(vec3(31.0, 17.0, 81.0), vec3(81.0, 18.0, 124.0), (t - 0.14) / 0.14) / 255.0;
  if (t <= 0.42) return interpolateColor(vec3(81.0, 18.0, 124.0), vec3(130.0, 37.0, 129.0), (t - 0.28) / 0.14) / 255.0;
  if (t <= 0.56) return interpolateColor(vec3(130.0, 37.0, 129.0), vec3(181.0, 54.0, 122.0), (t - 0.42) / 0.14) / 255.0;
  if (t <= 0.7) return interpolateColor(vec3(181.0, 54.0, 122.0), vec3(229.0, 80.0, 100.0), (t - 0.56) / 0.14) / 255.0;
  if (t <= 0.84) return interpolateColor(vec3(229.0, 80.0, 100.0), vec3(252.0, 137.0, 97.0), (t - 0.7) / 0.14) / 255.0;
  return interpolateColor(vec3(252.0, 137.0, 97.0), vec3(252.0, 253.0, 191.0), (t - 0.84) / 0.16) / 255.0;
}

vec3 balance(float t) {
  t = saturate(t);
  if (t <= 0.18) return interpolateColor(vec3(49.0, 54.0, 149.0), vec3(69.0, 117.0, 180.0), t / 0.18) / 255.0;
  if (t <= 0.36) return interpolateColor(vec3(69.0, 117.0, 180.0), vec3(171.0, 217.0, 233.0), (t - 0.18) / 0.18) / 255.0;
  if (t <= 0.5) return interpolateColor(vec3(171.0, 217.0, 233.0), vec3(246.0, 246.0, 238.0), (t - 0.36) / 0.14) / 255.0;
  if (t <= 0.64) return interpolateColor(vec3(246.0, 246.0, 238.0), vec3(253.0, 174.0, 97.0), (t - 0.5) / 0.14) / 255.0;
  if (t <= 0.82) return interpolateColor(vec3(253.0, 174.0, 97.0), vec3(215.0, 48.0, 39.0), (t - 0.64) / 0.18) / 255.0;
  return interpolateColor(vec3(215.0, 48.0, 39.0), vec3(120.0, 20.0, 36.0), (t - 0.82) / 0.18) / 255.0;
}

vec3 turbo(float t) {
  float x = saturate(t);
  float r = 34.61 + x * (1172.33 + x * (-10793.56 + x * (33300.12 + x * (-38394.49 + x * 14825.05))));
  float g = 23.31 + x * (557.33 + x * (1225.33 + x * (-3574.96 + x * (1073.77 + x * 707.56))));
  float b = 27.2 + x * (3211.1 + x * (-15327.97 + x * (27814.0 + x * (-22569.18 + x * 6838.66))));
  return clamp(vec3(r, g, b), 0.0, 255.0) / 255.0;
}

vec3 colormap(float t) {
  if (uColormap == 1) return magma(t);
  if (uColormap == 2) return balance(t);
  if (uColormap == 3) return turbo(t);
  return viridis(t);
}

bool validEncodedValue(float encoded) {
  if (!validValue(encoded)) {
    return false;
  }
  if (uHasNoData && abs(encoded - uNoData) < 0.5) {
    return false;
  }
  return true;
}

float decodeEncodedValue(float encoded) {
  if (uDataType == 0) {
    return encoded;
  }
  return encoded * uValueScale + uValueOffset;
}

float sampleValue(vec2 uv) {
  float encoded = sampleEncodedValue(uv);
  return validEncodedValue(encoded) ? decodeEncodedValue(encoded) : 1.0e31;
}

float reliefShade(vec2 uv, float center) {
  vec2 lo = uCrop.xy;
  vec2 hi = uCrop.xy + uCrop.zw;
  float left = sampleValue(clamp(uv - vec2(uTexelSize.x, 0.0), lo, hi));
  float right = sampleValue(clamp(uv + vec2(uTexelSize.x, 0.0), lo, hi));
  float up = sampleValue(clamp(uv - vec2(0.0, uTexelSize.y), lo, hi));
  float down = sampleValue(clamp(uv + vec2(0.0, uTexelSize.y), lo, hi));
  left = validValue(left) && left < 1.0e30 ? left : center;
  right = validValue(right) && right < 1.0e30 ? right : center;
  up = validValue(up) && up < 1.0e30 ? up : center;
  down = validValue(down) && down < 1.0e30 ? down : center;
  float dzdx = (right - left) * 0.5 * 0.006;
  float dzdy = (down - up) * 0.5 * 0.006;
  vec3 normal = normalize(vec3(-dzdx, -dzdy, 1.0));
  vec3 lightDirection = normalize(vec3(-0.45, -0.55, 0.72));
  float light = dot(normal, lightDirection);
  return clamp(0.78 + light * 0.34, 0.58, 1.18);
}

void main() {
  if (!uHasData) {
    outColor = vec4(0.169, 0.176, 0.188, 1.0);
    return;
  }

  vec2 dataUv = uCrop.xy + vUv * uCrop.zw;
  float encoded = sampleEncodedValue(dataUv);
  if (!validEncodedValue(encoded)) {
    outColor = vec4(0.161, 0.169, 0.176, 1.0);
    return;
  }
  float value = decodeEncodedValue(encoded);

  vec3 color = colormap(normalizedValue(value));
  if (uRelief) {
    color *= reliefShade(dataUv, value);
  }
  if (uGrid) {
    float edge = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
    float line = 1.0 - smoothstep(0.0, 0.006, edge);
    color = mix(color, vec3(1.0), line * 0.18);
  }
  outColor = vec4(color, 1.0);
}
`;

export class GlobeRenderer {
  constructor({ canvas, manifest, scheduler, state, onHover, onSelect = () => {} }) {
    this.canvas = canvas;
    this.manifest = manifest;
    this.scheduler = scheduler;
    this.state = state;
    this.onHover = onHover;
    this.onSelect = onSelect;
    this.meshes = new Map();
    this.textures = new Map();
    this.tileSphereCache = new Map();
    this.visibleTiles = null;
    this.renderStats = emptyRenderStats();
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.pointerDown = null;
    this.tileSelection = null;
    this.selectedTiles = new Map();
    this.selectionMeshes = new Map();
    this.hovered = null;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x202326, 1);
    this.textureSupport = scalarTextureSupport(this.renderer.getContext());

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x202326);
    this.selectionMaterial = new THREE.MeshBasicMaterial({
      color: 0x78d6ea,
      depthTest: true,
      depthWrite: false,
      opacity: 0.28,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      side: THREE.DoubleSide,
      transparent: true
    });

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(3.2, 2.15, 1.7);
    this.camera.lookAt(0, 0, 0);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minDistance = 1.045;
    this.controls.maxDistance = 6.5;
    this.controls.zoomToCursor = true;
    this.updateInteractionScale();

    const ambient = new THREE.AmbientLight(0xffffff, 1.25);
    this.scene.add(ambient);
    this.blankTextures = createBlankTextures();

    canvas.addEventListener("pointerdown", (event) => {
      if (isTileSelectionPointer(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.canvas.setPointerCapture(event.pointerId);
        this.clearSelectedTiles();
        this.tileSelection = {
          pointerId: event.pointerId,
          last: { x: event.clientX, y: event.clientY }
        };
        addTileToSelection(this.selectedTiles, this.tileAt(event.clientX, event.clientY));
        this.syncSelectionMeshes();
        return;
      }
      this.pointerDown = { x: event.clientX, y: event.clientY };
      this.updateInteractionScale();
    }, { capture: true });
    canvas.addEventListener("pointerup", (event) => this.onPointerUp(event), { capture: true });
    canvas.addEventListener("pointercancel", () => {
      this.tileSelection = null;
      this.pointerDown = null;
    }, { capture: true });
    canvas.addEventListener("pointermove", (event) => {
      if (this.tileSelection) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const current = { x: event.clientX, y: event.clientY };
        addTilesAlongLine({
          tiles: this.selectedTiles,
          start: this.tileSelection.last,
          end: current,
          tileAt: (clientX, clientY) => this.tileAt(clientX, clientY)
        });
        this.tileSelection.last = current;
        this.syncSelectionMeshes();
        return;
      }
      this.updateInteractionScale();
    }, { capture: true });
    canvas.addEventListener("wheel", () => this.updateInteractionScale(), { capture: true, passive: true });
    canvas.addEventListener("pointermove", (event) => this.onPointerMove(event));
    canvas.addEventListener("click", (event) => this.onClick(event));
    canvas.addEventListener("pointerleave", () => {
      if (this.tileSelection) {
        return;
      }
      this.hovered = null;
      this.onHover(null);
    });
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  resetView() {
    this.camera.position.set(3.2, 2.15, 1.7);
    this.controls.target.set(0, 0, 0);
    this.updateInteractionScale();
    this.controls.update();
  }

  focusLonLat(lon, lat, distance = null) {
    const currentDistance = this.camera.position.distanceTo(this.controls.target);
    const targetDistance = Number.isFinite(Number(distance))
      ? Math.max(this.controls.minDistance, Math.min(this.controls.maxDistance, Number(distance)))
      : currentDistance;
    const direction = displayVector(lonLatToVector(lon, lat));
    this.controls.target.set(0, 0, 0);
    this.camera.position.copy(direction.multiplyScalar(targetDistance));
    this.camera.lookAt(0, 0, 0);
    this.updateInteractionScale();
    this.controls.update();
  }

  desiredTiles() {
    this.resize();
    this.camera.updateMatrixWorld();
    this.camera.updateProjectionMatrix();
    const frustum = new THREE.Frustum();
    const projectionScreen = new THREE.Matrix4().multiplyMatrices(
      this.camera.projectionMatrix,
      this.camera.matrixWorldInverse
    );
    frustum.setFromProjectionMatrix(projectionScreen);
    const cameraPosition = this.camera.position;
    const cameraDirection = this.camera.position.clone().normalize();
    const minDot = this.state.order <= this.manifest.minOrder ? -1.0 : -0.42;
    this.visibleTiles = this.traverseVisibleTiles({
      targetOrder: this.state.order,
      frustum,
      cameraPosition,
      cameraDirection,
      minDot
    })
      .sort((a, b) => a.priority - b.priority || b.dot - a.dot)
      .slice(0, MAX_GLOBE_VISIBLE_TILES)
      .map((entry) => entry.tile);
    return this.visibleTiles;
  }

  traverseVisibleTiles({ targetOrder, frustum, cameraPosition, cameraDirection, minDot }) {
    const minOrder = this.manifest.minOrder ?? this.manifest.tileShift;
    const rootGrid = tileGridSize(minOrder, this.manifest.tileShift);
    const stack = [];
    const visible = [];
    for (let face = 0; face < 12; face += 1) {
      for (let y = 0; y < rootGrid; y += 1) {
        for (let x = 0; x < rootGrid; x += 1) {
          stack.push({ order: minOrder, face, x, y });
        }
      }
    }

    while (stack.length) {
      const tile = stack.pop();
      const sphere = this.tileSphere(tile);
      const dot = cameraDirection.dot(sphere.center.clone().normalize());
      if (dot <= minDot || !frustum.intersectsSphere(sphere)) {
        continue;
      }
      if (tile.order < targetOrder) {
        stack.push(...childTiles(tile));
        continue;
      }
      visible.push({
        tile,
        dot,
        priority: sphere.center.distanceToSquared(cameraPosition)
      });
    }
    return visible;
  }

  detailOrder(maxOrder = this.manifest.maxOrder) {
    this.resize();
    const rect = this.canvas.getBoundingClientRect();
    const viewportPixels = Math.max(1, Math.min(rect.width, rect.height));
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const distance = Math.max(0.001, this.camera.position.distanceTo(this.controls.target));
    if (distance <= this.controls.minDistance * GLOBE_MAX_DETAIL_DISTANCE_FACTOR) {
      const minOrder = this.manifest.minOrder ?? this.manifest.tileShift;
      return clampOrder(maxOrder, minOrder, this.manifest.maxOrder);
    }
    const focalPixels = (viewportPixels * 0.5) / Math.tan(fov * 0.5);
    const horizonDistance = Math.sqrt(Math.max(0.0001, distance * distance - GLOBE_RADIUS * GLOBE_RADIUS));
    return detailOrderForBasePixels(
      (focalPixels / horizonDistance) * GLOBE_LOD_FACE_FACTOR,
      this.manifest,
      maxOrder
    );
  }

  draw() {
    this.resize();
    this.syncMeshes();
    this.updateInteractionScale();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  syncMeshes() {
    const visibleTiles = this.visibleTiles ?? this.desiredTiles();
    const wanted = new Set(visibleTiles.map((tile) => tileKey(tile)));
    const usedTextureKeys = new Set();
    const stats = emptyRenderStats(visibleTiles.length);
    for (const [key, mesh] of this.meshes) {
      if (!wanted.has(key)) {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
        this.meshes.delete(key);
      }
    }

    for (const targetTile of visibleTiles) {
      const key = tileKey(targetTile);
      let mesh = this.meshes.get(key);
      if (!mesh) {
        mesh = this.createMesh(targetTile);
        this.meshes.set(key, mesh);
        this.scene.add(mesh);
      }
      const resolved = this.scheduler.resolve(this.state.layerId, targetTile);
      updateRenderStats(stats, resolved, targetTile);
      const textureKey = this.updateMeshTexture(mesh, targetTile, resolved);
      if (textureKey) {
        usedTextureKeys.add(textureKey);
      }
    }
    this.pruneTextureCache(usedTextureKeys);
    this.renderStats = stats;
  }

  tileSphere(tile) {
    const key = tileKey(tile);
    let sphere = this.tileSphereCache.get(key);
    if (!sphere) {
      sphere = tileBoundingSphere(tile, this.manifest.tileShift);
      this.tileSphereCache.set(key, sphere);
    }
    return sphere;
  }

  createMesh(tile) {
    const geometry = createTileGeometry(tile, this.manifest.tileShift);
    const material = createScalarMaterial(this.blankTextures.float, this.manifest.tileSize, "float");
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.targetTile = tile;
    mesh.userData.materialKind = "float";
    return mesh;
  }

  updateMeshTexture(mesh, targetTile, resolved = this.scheduler.resolve(this.state.layerId, targetTile)) {
    if (!resolved) {
      const material = this.ensureMeshMaterial(mesh, mesh.userData.materialKind ?? "float");
      updateScalarUniforms(material, this.state);
      material.uniforms.uHasData.value = false;
      material.uniforms.uData.value = this.blankTextures[mesh.userData.materialKind ?? "float"];
      material.uniforms.uCrop.value.set(0, 0, 1, 1);
      return null;
    }

    const crop = resolved.exact
      ? { sx: 0, sy: 0, sw: 1, sh: 1 }
      : sourceCropForTarget(resolved.sourceTile, targetTile, this.manifest.tileShift);
    const textureKey = `${resolved.data.layerId}:${resolved.data.key}`;
    const textureEntry = this.textureForTile(resolved.data, textureKey);
    const material = this.ensureMeshMaterial(mesh, textureEntry.kind);
    updateScalarUniforms(material, this.state);
    material.uniforms.uHasData.value = true;
    material.uniforms.uData.value = textureEntry.texture;
    material.uniforms.uCrop.value.set(crop.sx, crop.sy, crop.sw, crop.sh);
    updateEncodingUniforms(material, textureEntry.encoding);
    mesh.userData.resolved = resolved;
    mesh.userData.textureKey = textureKey;
    return textureKey;
  }

  textureForTile(tileData, textureKey) {
    let entry = this.textures.get(textureKey);
    if (!entry) {
      entry = createTextureEntry(tileData, this.manifest.tileSize, this.textureSupport);
      this.textures.set(textureKey, entry);
    }
    entry.lastUsed = performance.now();
    return entry;
  }

  ensureMeshMaterial(mesh, kind) {
    if (mesh.userData.materialKind === kind) {
      return mesh.material;
    }
    const previous = mesh.material;
    mesh.material = createScalarMaterial(this.blankTextures[kind], this.manifest.tileSize, kind);
    mesh.userData.materialKind = kind;
    previous.dispose();
    return mesh.material;
  }

  pruneTextureCache(usedTextureKeys) {
    for (const [key, entry] of this.textures) {
      if (!usedTextureKeys.has(key)) {
        entry.texture.dispose();
        this.textures.delete(key);
      }
    }
  }

  stats() {
    return this.renderStats;
  }

  updateInteractionScale() {
    const distance = Math.max(0.001, this.camera.position.distanceTo(this.controls.target));
    const altitude = Math.max(0.006, distance - GLOBE_RADIUS);
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const normalizedSpeed = (altitude / GLOBE_RADIUS) * (Math.tan(fov * 0.5) / Math.PI) * SURFACE_DRAG_GAIN;
    this.controls.rotateSpeed = THREE.MathUtils.clamp(normalizedSpeed, MIN_ROTATE_SPEED, MAX_ROTATE_SPEED);
    const zoomT = THREE.MathUtils.clamp((distance - 1.15) / 2.5, 0, 1);
    this.controls.zoomSpeed = THREE.MathUtils.lerp(NEAR_ZOOM_SPEED, FAR_ZOOM_SPEED, zoomT);
    this.controls.dampingFactor = THREE.MathUtils.lerp(NEAR_DAMPING, FAR_DAMPING, zoomT);
  }

  inspectAt(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const intersections = this.raycaster.intersectObjects([...this.meshes.values()], false);
    if (!intersections.length) {
      return null;
    }
    const hit = intersections[0];
    const targetTile = hit.object.userData.targetTile;
    const bounds = tileBounds(targetTile, this.manifest.tileShift);
    const uv = hit.uv ?? new THREE.Vector2(0.5, 0.5);
    const u = bounds.u0 + (bounds.u1 - bounds.u0) * uv.x;
    const v = bounds.v0 + (bounds.v1 - bounds.v0) * uv.y;
    const cell = cellFromFaceUv(this.state.order, targetTile.face, u, v);
    const target = tileFromCell(cell, this.manifest.tileShift);
    const resolved = this.scheduler.resolve(this.state.layerId, target);
    const sourceOrder = resolved?.sourceTile.order ?? this.state.order;
    const sourceNside = 2 ** sourceOrder;
    const sourceCell = {
      order: sourceOrder,
      face: targetTile.face,
      ix: Math.min(sourceNside - 1, Math.max(0, Math.floor(u * sourceNside))),
      iy: Math.min(sourceNside - 1, Math.max(0, Math.floor(v * sourceNside)))
    };
    const value = resolved ? sampleTileValue(resolved.data, this.manifest, sourceCell) : NaN;
    const lonLat = vectorToLonLat(faceUvToVector(targetTile.face, u, v));
    return {
      cell,
      nestedId: cellToNestedId(cell),
      lonLat,
      value,
      exact: resolved?.exact ?? false,
      tile: resolved?.sourceTile ?? target,
      targetTile: target,
      tileKey: tileKey(resolved?.sourceTile ?? target)
    };
  }

  onPointerMove(event) {
    const inspected = this.inspectAt(event.clientX, event.clientY);
    this.onHover(inspected);
  }

  onPointerUp(event) {
    if (this.tileSelection) {
      const last = this.tileSelection.last;
      const end = { x: event.clientX, y: event.clientY };
      this.tileSelection = null;
      event.preventDefault();
      event.stopImmediatePropagation();
      addTilesAlongLine({
        tiles: this.selectedTiles,
        start: last,
        end,
        tileAt: (clientX, clientY) => this.tileAt(clientX, clientY)
      });
      this.syncSelectionMeshes();
      this.onSelect(
        createTileSelection({
          tiles: this.selectedTiles.values(),
          tileShift: this.manifest.tileShift
        })
      );
      return;
    }
    if (!this.pointerDown) {
      return;
    }
    const distance = Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y);
    this.pointerDown = null;
    if (distance <= 4) {
      this.onSelect(this.inspectAt(event.clientX, event.clientY));
    }
  }

  onClick(event) {
    if (event.button !== 0) {
      return;
    }
    this.clearSelectedTiles();
    this.onSelect(this.inspectAt(event.clientX, event.clientY));
  }

  tileAt(clientX, clientY) {
    return this.inspectAt(clientX, clientY)?.targetTile ?? null;
  }

  syncSelectionMeshes() {
    const wanted = new Set(this.selectedTiles.keys());
    for (const [key, mesh] of this.selectionMeshes) {
      if (!wanted.has(key)) {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
        this.selectionMeshes.delete(key);
      }
    }
    for (const [key, tile] of this.selectedTiles) {
      if (this.selectionMeshes.has(key)) {
        continue;
      }
      const mesh = new THREE.Mesh(createTileGeometry(tile, this.manifest.tileShift, GLOBE_RADIUS + 0.004), this.selectionMaterial);
      mesh.renderOrder = 20;
      this.selectionMeshes.set(key, mesh);
      this.scene.add(mesh);
    }
  }

  clearSelectedTiles() {
    this.selectedTiles.clear();
    this.syncSelectionMeshes();
  }
}

function createTileGeometry(tile, tileShift, radius = GLOBE_RADIUS) {
  const bounds = tileBounds(tile, tileShift);
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  for (let y = 0; y <= PATCH_SEGMENTS; y += 1) {
    for (let x = 0; x <= PATCH_SEGMENTS; x += 1) {
      const s = x / PATCH_SEGMENTS;
      const t = y / PATCH_SEGMENTS;
      const u = bounds.u0 + (bounds.u1 - bounds.u0) * s;
      const v = bounds.v0 + (bounds.v1 - bounds.v0) * t;
      const point = displayArray(faceUvToVector(tile.face, u, v, radius));
      positions.push(point[0], point[1], point[2]);
      normals.push(point[0] / radius, point[1] / radius, point[2] / radius);
      uvs.push(s, t);
    }
  }

  const row = PATCH_SEGMENTS + 1;
  for (let y = 0; y < PATCH_SEGMENTS; y += 1) {
    for (let x = 0; x < PATCH_SEGMENTS; x += 1) {
      const a = y * row + x;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

function createScalarMaterial(blankTexture, tileSize, textureKind) {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: GLOBE_VERTEX_SHADER,
    fragmentShader: fragmentShaderForTextureKind(textureKind),
    uniforms: {
      uData: { value: blankTexture },
      uHasData: { value: false },
      uCrop: { value: new THREE.Vector4(0, 0, 1, 1) },
      uTexelSize: { value: new THREE.Vector2(1 / tileSize, 1 / tileSize) },
      uMin: { value: -1 },
      uMax: { value: 1 },
      uSymlogConstant: { value: 0.03 },
      uValueScale: { value: 1 },
      uValueOffset: { value: 0 },
      uNoData: { value: 0 },
      uScaleMode: { value: 0 },
      uColormap: { value: 0 },
      uDataType: { value: 0 },
      uRelief: { value: false },
      uGrid: { value: false },
      uHasNoData: { value: false }
    },
    side: THREE.FrontSide,
    transparent: false
  });
}

function fragmentShaderForTextureKind(textureKind) {
  return `precision highp float;
precision highp int;
${textureSamplerDeclaration(textureKind)}
${GLOBE_FRAGMENT_SHADER_BODY.replace("__SAMPLE_ENCODED_VALUE__", textureSamplerFunction(textureKind))}`;
}

function textureSamplerDeclaration(textureKind) {
  if (textureKind === "uint") {
    return `
precision highp usampler2D;
uniform highp usampler2D uData;
`;
  }
  if (textureKind === "int") {
    return `
precision highp isampler2D;
uniform highp isampler2D uData;
`;
  }
  return `
uniform sampler2D uData;
`;
}

function textureSamplerFunction(textureKind) {
  if (textureKind === "uint" || textureKind === "int") {
    return `
float sampleEncodedValue(vec2 uv) {
  return float(texture(uData, uv).r);
}
`;
  }
  return `

float sampleEncodedValue(vec2 uv) {
  return texture(uData, uv).r;
}
`;
}

function updateScalarUniforms(material, state) {
  material.uniforms.uMin.value = Number(state.min);
  material.uniforms.uMax.value = Number(state.max);
  material.uniforms.uSymlogConstant.value = Number(state.symlogConstant ?? 0.03);
  material.uniforms.uScaleMode.value = scaleModeId(state.scale);
  material.uniforms.uColormap.value = colormapId(state.colormap);
  material.uniforms.uRelief.value = Boolean(state.relief) && RELIEF_LAYER_PATTERN.test(state.layerId ?? "");
  material.uniforms.uGrid.value = Boolean(state.grid);
}

function updateEncodingUniforms(material, encoding) {
  material.uniforms.uDataType.value = dataTypeId(encoding.dtype);
  material.uniforms.uValueScale.value = Number(encoding.scale ?? 1);
  material.uniforms.uValueOffset.value = Number(encoding.offset ?? 0);
  material.uniforms.uHasNoData.value = encoding.nodata !== null;
  material.uniforms.uNoData.value = encoding.nodata ?? 0;
}

function createBlankTextures() {
  return {
    float: createScalarDataTexture(new Float32Array([Number.NaN]), 1, "float"),
    uint: createScalarDataTexture(new Uint16Array([0]), 1, "uint"),
    int: createScalarDataTexture(new Int16Array([0]), 1, "int")
  };
}

function createTextureEntry(tileData, size, textureSupport) {
  const kind = textureKindForTile(tileData.values, textureSupport);
  const direct = kind !== "float" || tileData.values instanceof Float32Array;
  const values = direct ? tileData.values : decodedFloatValues(tileData);
  const encoding = direct
    ? tileData.encoding
    : { dtype: "float32", scale: 1, offset: 0, nodata: null };
  const textureKind = direct ? kind : "float";
  return {
    texture: createScalarDataTexture(values, size, textureKind),
    kind: textureKind,
    encoding,
    lastUsed: performance.now()
  };
}

function createScalarDataTexture(values, size, textureKind) {
  const texture = new THREE.DataTexture(
    values,
    size,
    size,
    textureFormatForKind(textureKind),
    textureTypeForKind(textureKind)
  );
  texture.internalFormat = textureInternalFormatForKind(textureKind);
  configureScalarTexture(texture);
  texture.needsUpdate = true;
  return texture;
}

function configureScalarTexture(texture) {
  texture.colorSpace = THREE.NoColorSpace;
  texture.flipY = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.unpackAlignment = 1;
}

function scaleModeId(scale) {
  if (scale === "log") {
    return 1;
  }
  if (scale === "symlog") {
    return 2;
  }
  return 0;
}

function colormapId(colormap) {
  if (colormap === "magma") {
    return 1;
  }
  if (colormap === "balance") {
    return 2;
  }
  if (colormap === "turbo") {
    return 3;
  }
  return 0;
}

function dataTypeId(dtype) {
  if (dtype === "uint16") {
    return 1;
  }
  if (dtype === "int16") {
    return 2;
  }
  return 0;
}

function textureFormatForKind(textureKind) {
  return textureKind === "float" ? THREE.RedFormat : THREE.RedIntegerFormat;
}

function textureTypeForKind(textureKind) {
  if (textureKind === "uint") {
    return THREE.UnsignedShortType;
  }
  if (textureKind === "int") {
    return THREE.ShortType;
  }
  return THREE.FloatType;
}

function textureInternalFormatForKind(textureKind) {
  if (textureKind === "uint") {
    return "R16UI";
  }
  if (textureKind === "int") {
    return "R16I";
  }
  return "R32F";
}

function decodedFloatValues(tileData) {
  if (tileData.encoding.dtype === "float32") {
    return tileData.values;
  }
  if (tileData.decodedValues) {
    return tileData.decodedValues;
  }
  const wasmValues = decodeQuantizedTileWasm(tileData);
  if (wasmValues) {
    tileData.decodedValues = wasmValues;
    return wasmValues;
  }
  const values = new Float32Array(tileData.values.length);
  for (let i = 0; i < values.length; i += 1) {
    values[i] = decodeSample(tileData, i);
  }
  tileData.decodedValues = values;
  return values;
}

function textureKindForTile(values, textureSupport) {
  if (values instanceof Uint16Array) {
    return textureSupport.integer16 ? "uint" : "float";
  }
  if (values instanceof Int16Array) {
    return textureSupport.integer16 ? "int" : "float";
  }
  return "float";
}

function scalarTextureSupport(gl) {
  return {
    integer16: isWebGL2Context(gl)
  };
}

function isWebGL2Context(gl) {
  return typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
}

function childTiles(tile) {
  const order = tile.order + 1;
  const x = tile.x * 2;
  const y = tile.y * 2;
  return [
    { order, face: tile.face, x, y },
    { order, face: tile.face, x: x + 1, y },
    { order, face: tile.face, x, y: y + 1 },
    { order, face: tile.face, x: x + 1, y: y + 1 }
  ];
}

function displayArray(normal) {
  return healpixVectorToDisplayVector(normal);
}

function displayVector(normal) {
  return new THREE.Vector3(normal[0], normal[2], normal[1]).normalize();
}

function displayPoint(face, u, v) {
  const point = displayArray(faceUvToVector(face, u, v, GLOBE_RADIUS));
  return new THREE.Vector3(point[0], point[1], point[2]);
}

function tileBoundingSphere(tile, tileShift) {
  const bounds = tileBounds(tile, tileShift);
  const center = displayPoint(
    tile.face,
    (bounds.u0 + bounds.u1) * 0.5,
    (bounds.v0 + bounds.v1) * 0.5
  );
  const points = [
    displayPoint(tile.face, bounds.u0, bounds.v0),
    displayPoint(tile.face, bounds.u1, bounds.v0),
    displayPoint(tile.face, bounds.u1, bounds.v1),
    displayPoint(tile.face, bounds.u0, bounds.v1)
  ];
  const radius = Math.max(...points.map((point) => point.distanceTo(center))) * TILE_BOUNDING_RADIUS_SCALE;
  return new THREE.Sphere(center, radius);
}

function emptyRenderStats(visible = 0) {
  return {
    visible,
    exact: 0,
    approximate: 0,
    missing: visible,
    maxSourceOrder: null
  };
}

function updateRenderStats(stats, resolved, targetTile) {
  if (!resolved) {
    return;
  }
  stats.missing -= 1;
  stats.maxSourceOrder = Math.max(stats.maxSourceOrder ?? -Infinity, resolved.sourceTile.order);
  if (resolved.sourceTile.order === targetTile.order) {
    stats.exact += 1;
  } else {
    stats.approximate += 1;
  }
}
