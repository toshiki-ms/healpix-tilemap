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
import { viewportSurfaceSegments } from "./viewport-footprint.js";

const PATCH_SEGMENTS = 18;
const GLOBE_RADIUS = 1.004;
const GLOBE_MIN_CAMERA_ALTITUDE = 0.075;
const GLOBE_MIN_CAMERA_RADIUS = GLOBE_RADIUS + GLOBE_MIN_CAMERA_ALTITUDE;
const GLOBE_LOD_FACE_FACTOR = 1.45;
const GLOBE_MAX_DETAIL_DISTANCE_FACTOR = 1.04;
const MAX_GLOBE_VISIBLE_TILES = 1100;
const TILE_BOUNDING_RADIUS_SCALE = 1.12;
const NEAR_HORIZON_CULL_MARGIN = 0.035;
const FAR_HORIZON_CULL_MARGIN = 0.22;
const NEAR_FOCUS_DETAIL_ANGLE = 0.11;
const FAR_FOCUS_DETAIL_ANGLE = 1.15;
const FOCUS_DETAIL_DISTANCE_SPAN = 1.2;
const SURFACE_DRAG_GAIN = 1.35;
const MIN_ROTATE_SPEED = 0.03;
const MAX_DETAIL_MIN_ROTATE_SPEED = 0.055;
const MAX_ROTATE_SPEED = 0.55;
const NEAR_ZOOM_SPEED = 0.42;
const FAR_ZOOM_SPEED = 0.78;
const NEAR_DAMPING = 0.32;
const FAR_DAMPING = 0.08;
const MIN_CAMERA_FOV = 1;
const MAX_CAMERA_FOV = 179.9;
const DEFAULT_CAMERA_FOV = 38;
const RELIEF_LAYER_PATTERN = /(elevation|height|terrain|topo|dem)/i;
const AXIS_LENGTH = GLOBE_RADIUS * 1.56;
const AXIS_INNER_RADIUS = GLOBE_RADIUS * 1.08;
const DEFAULT_CAMERA_UP = new THREE.Vector3(0, 0, 1);
const GEOGRAPHIC_NORTH_DISPLAY = new THREE.Vector3(0, 0, 1);
const GRATICULE_RADIUS = GLOBE_RADIUS + 0.003;
const ANGULAR_RADIUS_DEG = 180 / Math.PI;
const FOOTPRINT_RADIUS = 0.0075;
const FOOTPRINT_SURFACE_RADIUS = GLOBE_RADIUS + 0.014;
const AXIS_ROTATE_DERIVATIVE_EPSILON = 0.01;
const AXIS_VECTORS = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1)
};

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
    this.surfaceScale = surfaceScaleForManifest(manifest);
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
    this.axisKey = null;
    this.axisDrag = null;
    this.suppressClick = false;
    this.selectedTiles = new Map();
    this.selectionMeshes = new Map();
    this.hovered = null;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true
    });
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

    this.camera = new THREE.PerspectiveCamera(DEFAULT_CAMERA_FOV, 1, 0.01, 100);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(3.2, 2.15, 1.7);
    this.camera.lookAt(0, 0, 0);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minDistance = GLOBE_MIN_CAMERA_RADIUS;
    this.controls.maxDistance = 6.5;
    this.controls.zoomToCursor = true;
    this.updateInteractionScale();

    const ambient = new THREE.AmbientLight(0xffffff, 1.25);
    this.scene.add(ambient);
    this.axesGroup = createAxesGroup();
    this.axesGroup.visible = Boolean(this.state.axes);
    this.scene.add(this.axesGroup);
    this.graticuleGroup = createGraticuleGroup();
    this.graticuleGroup.visible = Boolean(this.state.graticule);
    this.scene.add(this.graticuleGroup);
    this.footprintGroup = new THREE.Group();
    this.footprintGroup.renderOrder = 30;
    this.footprintMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -8,
      polygonOffsetUnits: -8,
      transparent: true,
      opacity: 0.98
    });
    this.scene.add(this.footprintGroup);
    this.blankTextures = createBlankTextures();

    canvas.addEventListener("pointerdown", (event) => {
      if (this.beginAxisDrag(event)) {
        return;
      }
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
    canvas.addEventListener("pointercancel", (event) => {
      this.endAxisDrag(event);
      this.tileSelection = null;
      this.pointerDown = null;
    }, { capture: true });
    canvas.addEventListener("pointermove", (event) => {
      if (this.axisDrag) {
        this.updateAxisDrag(event);
        return;
      }
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
    window.addEventListener("keydown", (event) => this.onAxisKeyDown(event));
    window.addEventListener("keyup", (event) => this.onAxisKeyUp(event));
    window.addEventListener("blur", () => {
      this.axisKey = null;
      this.endAxisDrag();
    });
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
    this.camera.fov = DEFAULT_CAMERA_FOV;
    this.camera.up.copy(DEFAULT_CAMERA_UP);
    this.camera.updateProjectionMatrix();
    this.controls.target.set(0, 0, 0);
    this.constrainCameraOutsideGlobe();
    this.updateInteractionScale();
    if (this.state.northUp) {
      this.alignNorthUp();
    }
    this.controls.update();
  }

  setAxesVisible(visible) {
    this.axesGroup.visible = Boolean(visible);
  }

  setGraticuleVisible(visible) {
    this.graticuleGroup.visible = Boolean(visible);
  }

  setFootprintSegments(segments = [], color = "#000000") {
    const signature = footprintSignature(segments, color);
    if (this.footprintSignature === signature) {
      return;
    }
    this.footprintSignature = signature;
    clearGroup(this.footprintGroup);
    this.footprintMaterial.color.set(color);
    for (const segment of segments) {
      if (!Array.isArray(segment) || segment.length < 2) {
        continue;
      }
      const points = segment.map((point) => new THREE.Vector3(
        point[0] * FOOTPRINT_SURFACE_RADIUS,
        point[1] * FOOTPRINT_SURFACE_RADIUS,
        point[2] * FOOTPRINT_SURFACE_RADIUS
      ));
      const closed = isClosedPointLoop(points);
      const curvePoints = closed ? points.slice(0, -1) : points;
      const curve = new THREE.CatmullRomCurve3(curvePoints, closed);
      const geometry = new THREE.TubeGeometry(
        curve,
        Math.max(8, curvePoints.length * 2),
        FOOTPRINT_RADIUS,
        6,
        closed
      );
      const mesh = new THREE.Mesh(geometry, this.footprintMaterial);
      mesh.renderOrder = 38;
      this.footprintGroup.add(mesh);
    }
  }

  setNorthUp(visible) {
    if (visible) {
      this.alignNorthUp();
    } else {
      this.camera.up.copy(DEFAULT_CAMERA_UP);
      this.camera.lookAt(this.controls.target);
    }
    this.controls.update();
  }

  onAxisKeyDown(event) {
    if (isTextEditingTarget(event.target)) {
      return;
    }
    const key = axisKeyFromEvent(event);
    if (!key) {
      return;
    }
    this.axisKey = key;
  }

  onAxisKeyUp(event) {
    const key = axisKeyFromEvent(event);
    if (!key || key !== this.axisKey) {
      return;
    }
    this.axisKey = null;
    this.endAxisDrag(event);
  }

  beginAxisDrag(event) {
    if (!this.axisKey || event.button !== 0) {
      return false;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    this.canvas.setPointerCapture(event.pointerId);
    this.axisDrag = {
      pointerId: event.pointerId,
      axisKey: this.axisKey,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false
    };
    this.pointerDown = null;
    this.controls.enabled = false;
    this.updateInteractionScale();
    return true;
  }

  updateAxisDrag(event) {
    if (!this.axisDrag || event.pointerId !== this.axisDrag.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    const dx = event.clientX - this.axisDrag.lastX;
    const dy = event.clientY - this.axisDrag.lastY;
    this.axisDrag.lastX = event.clientX;
    this.axisDrag.lastY = event.clientY;
    if (Math.hypot(dx, dy) < 1e-6) {
      return;
    }
    const angle = this.axisDragAngle(this.axisDrag.axisKey, dx, dy);
    if (!Number.isFinite(angle) || Math.abs(angle) < 1e-8) {
      return;
    }
    this.axisDrag.moved = true;
    this.rotateAroundDisplayAxis(this.axisDrag.axisKey, angle);
  }

  axisDragAngle(axisKey, dx, dy) {
    const basis = this.axisScreenBasis(axisKey);
    if (!basis) {
      return 0;
    }
    const signedPixels = dx * basis.direction.x + dy * basis.direction.y;
    return signedPixels / basis.pixelsPerRadian;
  }

  axisScreenBasis(axisKey) {
    const axis = AXIS_VECTORS[axisKey];
    if (!axis) {
      return null;
    }
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    this.camera.updateMatrixWorld(true);
    this.camera.updateProjectionMatrix();
    const rotation = new THREE.Quaternion().setFromAxisAngle(axis, AXIS_ROTATE_DERIVATIVE_EPSILON);
    const rotatedTarget = this.controls.target.clone().applyQuaternion(rotation);
    const rotatedCamera = this.camera.clone();
    rotatedCamera.position.applyQuaternion(rotation);
    rotatedCamera.up.applyQuaternion(rotation).normalize();
    rotatedCamera.lookAt(rotatedTarget);
    rotatedCamera.updateMatrixWorld(true);
    rotatedCamera.updateProjectionMatrix();

    let best = null;
    for (const point of this.axisReferencePoints(rect)) {
      const before = projectToCanvasPixels(point, this.camera, rect);
      const after = projectToCanvasPixels(point, rotatedCamera, rect);
      if (!before || !after) {
        continue;
      }
      const tangent = after.sub(before);
      const pixelsPerRadian = tangent.length() / AXIS_ROTATE_DERIVATIVE_EPSILON;
      if (!Number.isFinite(pixelsPerRadian) || pixelsPerRadian <= 1e-6) {
        continue;
      }
      if (!best || pixelsPerRadian > best.pixelsPerRadian) {
        best = {
          direction: tangent.normalize(),
          pixelsPerRadian
        };
      }
    }
    return best;
  }

  axisReferencePoints(rect) {
    const samples = [
      [0.5, 0.5],
      [0.35, 0.5],
      [0.65, 0.5],
      [0.5, 0.35],
      [0.5, 0.65],
      [0.35, 0.35],
      [0.65, 0.65]
    ];
    const points = [];
    for (const [fx, fy] of samples) {
      const vector = this.surfaceDisplayVectorAtScreenPoint(
        rect.left + rect.width * fx,
        rect.top + rect.height * fy
      );
      if (vector) {
        points.push(new THREE.Vector3(vector[0], vector[1], vector[2]).multiplyScalar(GLOBE_RADIUS));
      }
    }
    return points;
  }

  endAxisDrag(event = null) {
    if (!this.axisDrag) {
      return false;
    }
    const pointerId = this.axisDrag.pointerId;
    if (event && event.pointerId === pointerId) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    if (this.canvas.hasPointerCapture(pointerId)) {
      this.canvas.releasePointerCapture(pointerId);
    }
    this.suppressClick = this.axisDrag.moved;
    this.axisDrag = null;
    this.controls.enabled = true;
    return true;
  }

  rotateAroundDisplayAxis(axisKey, angle) {
    const axis = AXIS_VECTORS[axisKey];
    if (!axis) {
      return;
    }
    const rotation = new THREE.Quaternion().setFromAxisAngle(axis, angle);
    this.camera.position.applyQuaternion(rotation);
    this.controls.target.applyQuaternion(rotation);
    this.camera.up.applyQuaternion(rotation).normalize();
    this.constrainCameraOutsideGlobe();
    this.camera.lookAt(this.controls.target);
    if (this.state.northUp) {
      this.alignNorthUp();
    }
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
    this.constrainCameraOutsideGlobe();
    this.updateInteractionScale();
    if (this.state.northUp) {
      this.alignNorthUp();
    }
    this.controls.update();
  }

  applyViewState(view = {}) {
    const camera = view.camera ?? view;
    const position = vector3FromObject(camera.position);
    const target = vector3FromObject(camera.target);
    if (position) {
      this.camera.position.copy(position);
    }
    if (target) {
      this.controls.target.copy(target);
    }
    const center = camera.centerLonLat ?? camera.lonLat ?? view.centerLonLat ?? view.lonLat;
    if (!position && !target && center && Number.isFinite(Number(center.lon)) && Number.isFinite(Number(center.lat))) {
      this.focusLonLat(center.lon, center.lat, camera.distance ?? view.distance);
    }
    const fov = normalizeCameraFov(camera.fov ?? view.fov);
    if (Number.isFinite(fov)) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.constrainCameraOutsideGlobe();
    this.camera.lookAt(this.controls.target);
    this.updateInteractionScale();
    if (this.state.northUp) {
      this.alignNorthUp();
    }
    this.controls.update();
  }

  viewState() {
    const centerDisplay = this.surfaceFocusDirection();
    const centerProjection = displayVectorToProjection(centerDisplay);
    const centerLonLat = vectorToLonLat(centerProjection);
    return {
      camera: {
        position: vectorObject(this.camera.position),
        target: vectorObject(this.controls.target),
        distance: this.camera.position.distanceTo(this.controls.target),
        fov: this.camera.fov,
        centerLonLat,
        centerVector: vectorObject(centerDisplay)
      },
      coordinateSystem: {
        camera: "display-xyz-z-up",
        centerVector: "display-xyz-z-up",
        projectionVector: "internal-projection-xyz-y-up",
        note: "The UI uses Z-up display XYZ, so +Z is the north pole. Internal projection vectors use Y-up."
      }
    };
  }

  cameraUrlValue() {
    const p = this.camera.position;
    const t = this.controls.target;
    return [p.x, p.y, p.z, t.x, t.y, t.z, this.camera.fov].map((value) => compactFloat(value)).join(",");
  }

  applyCameraUrlValue(value) {
    if (!value) {
      return;
    }
    const parts = String(value).split(",").map(Number);
    if (parts.length !== 7 || parts.some((item) => !Number.isFinite(item))) {
      return;
    }
    this.applyViewState({
      position: { x: parts[0], y: parts[1], z: parts[2] },
      target: { x: parts[3], y: parts[4], z: parts[5] },
      fov: parts[6]
    });
  }

  desiredTiles() {
    this.resize();
    this.constrainCameraOutsideGlobe();
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
    const cameraDistance = cameraPosition.length();
    const focusDirection = this.surfaceFocusDirection();
    const minDot =
      this.state.order <= this.manifest.minOrder ? -1.0 : this.horizonCullMinDot(cameraDistance);
    this.visibleTiles = this.traverseVisibleTiles({
      targetOrder: this.state.order,
      frustum,
      cameraPosition,
      cameraDirection,
      cameraDistance,
      focusDirection,
      minDot
    })
      .sort((a, b) => a.priority - b.priority || b.dot - a.dot)
      .slice(0, MAX_GLOBE_VISIBLE_TILES)
      .map((entry) => entry.tile);
    return this.visibleTiles;
  }

  traverseVisibleTiles({
    targetOrder,
    frustum,
    cameraPosition,
    cameraDirection,
    cameraDistance,
    focusDirection,
    minDot
  }) {
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
      if (dot + sphereDotPadding(sphere) <= minDot || !frustum.intersectsSphere(sphere)) {
        continue;
      }
      if (
        tile.order < targetOrder &&
        tileIntersectsAngularCap(
          focusDirection,
          sphere,
          this.focusDetailAngle(tile.order + 1, targetOrder, cameraDistance)
        )
      ) {
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
    const cameraRadius = Math.max(GLOBE_MIN_CAMERA_RADIUS, this.camera.position.length());
    if (cameraRadius <= this.controls.minDistance * GLOBE_MAX_DETAIL_DISTANCE_FACTOR) {
      const minOrder = this.manifest.minOrder ?? this.manifest.tileShift;
      return clampOrder(maxOrder, minOrder, this.manifest.maxOrder);
    }
    const focalPixels = (viewportPixels * 0.5) / Math.tan(fov * 0.5);
    const horizonDistance = Math.sqrt(Math.max(0.0001, cameraRadius * cameraRadius - GLOBE_RADIUS * GLOBE_RADIUS));
    return detailOrderForBasePixels(
      (focalPixels / horizonDistance) * GLOBE_LOD_FACE_FACTOR,
      this.manifest,
      maxOrder
    );
  }

  draw() {
    this.resize();
    this.syncMeshes();
    this.setAxesVisible(this.state.axes);
    this.setGraticuleVisible(this.state.graticule);
    this.controls.update();
    this.constrainCameraOutsideGlobe();
    if (this.state.northUp) {
      this.alignNorthUp();
    }
    this.updateInteractionScale();
    this.renderer.render(this.scene, this.camera);
  }

  syncMeshes() {
    const visibleTiles = this.visibleTiles ?? this.desiredTiles();
    const wanted = new Set(visibleTiles.map((tile) => tileKey(tile)));
    const usedTextureKeys = new Set();
    const stats = emptyRenderStats(visibleTiles.length);
    stats.orderCounts = orderCounts(visibleTiles);
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
    const cameraRadius = Math.max(GLOBE_MIN_CAMERA_RADIUS, this.camera.position.length());
    const distance = Math.max(0.001, this.camera.position.distanceTo(this.controls.target));
    const altitude = Math.max(GLOBE_MIN_CAMERA_ALTITUDE, cameraRadius - GLOBE_RADIUS);
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const altitudeRatio = altitude / GLOBE_RADIUS;
    const normalizedSpeed = Math.max(altitudeRatio, Math.sqrt(altitudeRatio) * 0.18)
      * (Math.tan(fov * 0.5) / Math.PI)
      * SURFACE_DRAG_GAIN;
    const detailT = THREE.MathUtils.clamp(this.state.order - (this.state.maxOrder - 1), 0, 1);
    const minRotateSpeed = THREE.MathUtils.lerp(MIN_ROTATE_SPEED, MAX_DETAIL_MIN_ROTATE_SPEED, detailT);
    this.controls.rotateSpeed = THREE.MathUtils.clamp(normalizedSpeed, minRotateSpeed, MAX_ROTATE_SPEED);
    const zoomT = THREE.MathUtils.clamp((distance - 1.15) / 2.5, 0, 1);
    this.controls.zoomSpeed = THREE.MathUtils.lerp(NEAR_ZOOM_SPEED, FAR_ZOOM_SPEED, zoomT);
    this.controls.dampingFactor = THREE.MathUtils.lerp(NEAR_DAMPING, FAR_DAMPING, zoomT);
  }

  alignNorthUp() {
    const viewNormal = this.camera.position.clone().sub(this.controls.target);
    if (viewNormal.lengthSq() < 1e-10) {
      return;
    }
    viewNormal.normalize();

    const focus = this.surfaceFocusDirection();
    const localNorth = GEOGRAPHIC_NORTH_DISPLAY.clone()
      .sub(focus.clone().multiplyScalar(GEOGRAPHIC_NORTH_DISPLAY.dot(focus)));
    const north = localNorth.lengthSq() > 1e-8 ? localNorth.normalize() : GEOGRAPHIC_NORTH_DISPLAY;
    const screenNorth = north
      .clone()
      .sub(viewNormal.clone().multiplyScalar(north.dot(viewNormal)));
    if (screenNorth.lengthSq() < 1e-8) {
      this.camera.up.copy(DEFAULT_CAMERA_UP);
    } else {
      this.camera.up.copy(screenNorth.normalize());
    }
    this.camera.lookAt(this.controls.target);
  }

  surfaceScalePerPixel(samplePixels = 120) {
    const distance = this.surfaceDistanceForScreenPixels(samplePixels, this.surfaceScale.radius);
    return {
      ...this.surfaceScale,
      valuePerPixel: Number.isFinite(distance) && distance > 0 ? distance / samplePixels : Number.NaN
    };
  }

  surfaceDistanceForScreenPixels(samplePixels = 120, radius = 1) {
    const rect = this.canvas.getBoundingClientRect();
    const span = Math.max(2, Math.min(rect.width * 0.75, Number(samplePixels) || 120));
    const y = rect.top + rect.height * 0.5;
    const x0 = rect.left + rect.width * 0.5 - span * 0.5;
    const x1 = rect.left + rect.width * 0.5 + span * 0.5;
    const a = this.surfaceVectorAtScreenPoint(x0, y);
    const b = this.surfaceVectorAtScreenPoint(x1, y);
    if (!a || !b) {
      return Number.NaN;
    }
    const dot = THREE.MathUtils.clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1);
    return Math.acos(dot) * radius;
  }

  surfaceVectorAtScreenPoint(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.camera.updateMatrixWorld(true);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = raySphereIntersection(this.raycaster.ray.origin, this.raycaster.ray.direction, GLOBE_RADIUS);
    return hit ? displayVectorToProjection(hit.normalize()) : null;
  }

  surfaceDisplayVectorAtScreenPoint(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.camera.updateMatrixWorld(true);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = raySphereIntersection(this.raycaster.ray.origin, this.raycaster.ray.direction, GLOBE_RADIUS);
    return hit ? vectorArray(hit.normalize()) : null;
  }

  viewportSurfaceSegments(samplesPerEdge = 32) {
    const segments = viewportSurfaceSegments(
      this.canvas,
      samplesPerEdge,
      (clientX, clientY) => this.surfaceDisplayVectorAtScreenPoint(clientX, clientY)
    );
    return segments.length ? segments : [this.horizonSurfaceSegment(160)];
  }

  horizonSurfaceSegment(samples = 160) {
    const direction = this.camera.position.clone();
    const distance = direction.length();
    if (distance <= 1e-8) {
      return [];
    }
    direction.normalize();
    const dot = THREE.MathUtils.clamp(GLOBE_RADIUS / Math.max(GLOBE_RADIUS, distance), -1, 1);
    const radius = Math.sqrt(Math.max(0, 1 - dot * dot));
    const reference = Math.abs(direction.z) < 0.92
      ? new THREE.Vector3(0, 0, 1)
      : new THREE.Vector3(0, 1, 0);
    const u = new THREE.Vector3().crossVectors(direction, reference).normalize();
    const v = new THREE.Vector3().crossVectors(direction, u).normalize();
    const center = direction.clone().multiplyScalar(dot);
    const points = [];
    for (let i = 0; i <= samples; i += 1) {
      const t = (i / samples) * Math.PI * 2;
      const point = center.clone()
        .add(u.clone().multiplyScalar(Math.cos(t) * radius))
        .add(v.clone().multiplyScalar(Math.sin(t) * radius))
        .normalize();
      points.push(vectorArray(point));
    }
    return points;
  }

  horizonCullMinDot(distance) {
    const safeDistance = Math.max(GLOBE_MIN_CAMERA_RADIUS, distance);
    const horizonDot = GLOBE_RADIUS / safeDistance;
    const farT = THREE.MathUtils.clamp(
      (safeDistance - GLOBE_MIN_CAMERA_RADIUS) / (this.controls.maxDistance - GLOBE_MIN_CAMERA_RADIUS),
      0,
      1
    );
    const margin = THREE.MathUtils.lerp(NEAR_HORIZON_CULL_MARGIN, FAR_HORIZON_CULL_MARGIN, farT);
    return THREE.MathUtils.clamp(horizonDot - margin, -0.1, 0.92);
  }

  focusDetailAngle(nextOrder, targetOrder, distance) {
    const farT = THREE.MathUtils.clamp(
      (distance - GLOBE_MIN_CAMERA_RADIUS) / FOCUS_DETAIL_DISTANCE_SPAN,
      0,
      1
    );
    const baseAngle = THREE.MathUtils.lerp(NEAR_FOCUS_DETAIL_ANGLE, FAR_FOCUS_DETAIL_ANGLE, farT);
    return Math.min(Math.PI, baseAngle * 2 ** Math.max(0, targetOrder - nextOrder));
  }

  surfaceFocusDirection() {
    this.camera.updateMatrixWorld(true);
    const origin = this.camera.position.clone();
    const direction = new THREE.Vector3();
    this.camera.getWorldDirection(direction);
    const hit = raySphereIntersection(origin, direction, GLOBE_RADIUS);
    if (hit) {
      return hit.normalize();
    }
    if (this.controls.target.lengthSq() > 1e-8) {
      return this.controls.target.clone().normalize();
    }
    return origin.normalize();
  }

  constrainCameraOutsideGlobe() {
    const radius = this.camera.position.length();
    if (radius >= GLOBE_MIN_CAMERA_RADIUS) {
      return;
    }
    if (radius <= 1e-8) {
      this.camera.position.set(0, -GLOBE_MIN_CAMERA_RADIUS, 0);
      this.camera.lookAt(this.controls.target);
      return;
    }
    this.camera.position.multiplyScalar(GLOBE_MIN_CAMERA_RADIUS / radius);
    this.camera.lookAt(this.controls.target);
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
    if (this.axisDrag) {
      this.endAxisDrag(event);
      return;
    }
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
    if (this.suppressClick) {
      this.suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
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

function displayVectorToProjection(vector) {
  return [vector.x, vector.z, vector.y];
}

function vectorArray(vector) {
  return [Number(vector.x), Number(vector.y), Number(vector.z)];
}

function vectorObject(vector) {
  return {
    x: Number(vector.x),
    y: Number(vector.y),
    z: Number(vector.z)
  };
}

function vector3FromObject(value) {
  if (!value) {
    return null;
  }
  const x = Number(value.x);
  const y = Number(value.y);
  const z = Number(value.z);
  if (![x, y, z].every(Number.isFinite)) {
    return null;
  }
  return new THREE.Vector3(x, y, z);
}

function surfaceScaleForManifest(manifest) {
  const body = manifest?.body;
  const radiusKm = Number(body?.radiusKm);
  if (Number.isFinite(radiusKm) && radiusKm > 0) {
    return {
      radius: radiusKm,
      unit: "km",
      physical: true,
      bodyName: typeof body?.name === "string" ? body.name : ""
    };
  }
  return {
    radius: ANGULAR_RADIUS_DEG,
    unit: "deg",
    physical: false,
    bodyName: typeof body?.name === "string" ? body.name : ""
  };
}

function normalizeCameraFov(value) {
  const fov = Number(value);
  if (!Number.isFinite(fov) || fov < MIN_CAMERA_FOV) {
    return Number.NaN;
  }
  return Math.min(MAX_CAMERA_FOV, fov);
}

function clearGroup(group) {
  for (const child of [...group.children]) {
    group.remove(child);
    child.geometry?.dispose?.();
  }
}

function isClosedPointLoop(points) {
  if (points.length < 3) {
    return false;
  }
  const first = points[0];
  const last = points[points.length - 1];
  return first.distanceToSquared(last) < 1e-8;
}

function footprintSignature(segments, color) {
  return `${color}|${segments.map((segment) => segment.map((point) => point
    .map((value) => Number(value).toFixed(4))
    .join(",")).join(";")).join("|")}`;
}

function compactFloat(value) {
  return Number(value).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function axisKeyFromEvent(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return null;
  }
  const key = String(event.key ?? "").toLowerCase();
  return key === "x" || key === "y" || key === "z" ? key : null;
}

function isTextEditingTarget(target) {
  if (!(target instanceof Element)) {
    return false;
  }
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function projectToCanvasPixels(point, camera, rect) {
  const ndc = point.clone().project(camera);
  if (!Number.isFinite(ndc.x) || !Number.isFinite(ndc.y) || !Number.isFinite(ndc.z) || ndc.z < -1 || ndc.z > 1) {
    return null;
  }
  return new THREE.Vector2(
    ((ndc.x + 1) * 0.5) * rect.width,
    ((1 - ndc.y) * 0.5) * rect.height
  );
}

function createAxesGroup() {
  const group = new THREE.Group();
  const axes = [
    { name: "X", color: 0xff6b6b, direction: new THREE.Vector3(1, 0, 0) },
    { name: "Y", color: 0x5fd36a, direction: new THREE.Vector3(0, 1, 0) },
    { name: "Z", color: 0x6ba7ff, direction: new THREE.Vector3(0, 0, 1) }
  ];
  for (const axis of axes) {
    group.add(createAxisSegment(axis.direction, axis.color));
    group.add(createAxisSegment(axis.direction.clone().multiplyScalar(-1), axis.color));
    group.add(createAxisLabel(`+${axis.name}`, axis.direction, axis.color));
    group.add(createAxisLabel(`-${axis.name}`, axis.direction.clone().multiplyScalar(-1), axis.color));
  }
  return group;
}

function createAxisSegment(direction, color) {
  const start = direction.clone().normalize().multiplyScalar(AXIS_INNER_RADIUS);
  const end = direction.clone().normalize().multiplyScalar(AXIS_LENGTH);
  const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.68,
    depthTest: false
  });
  const line = new THREE.Line(geometry, material);
  line.renderOrder = 40;
  return line;
}

function createAxisLabel(text, direction, color) {
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 48;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.font = "700 26px Inter, system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.lineWidth = 5;
  context.strokeStyle = "rgba(20, 22, 24, 0.92)";
  context.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
  context.strokeText(text, canvas.width * 0.5, canvas.height * 0.5);
  context.fillText(text, canvas.width * 0.5, canvas.height * 0.5);
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false
  });
  const sprite = new THREE.Sprite(material);
  sprite.position.copy(direction.clone().normalize().multiplyScalar(AXIS_LENGTH * 1.08));
  sprite.scale.set(0.14, 0.07, 1);
  sprite.renderOrder = 41;
  return sprite;
}

function createGraticuleGroup() {
  const group = new THREE.Group();
  const material = new THREE.LineBasicMaterial({
    color: 0xf6f1e7,
    transparent: true,
    opacity: 0.22,
    depthTest: true,
    depthWrite: false
  });
  for (let lon = -180; lon < 180; lon += 30) {
    group.add(createLonLatLine(material, lineRange(-80, 80, 2).map((lat) => [lon, lat])));
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    group.add(createLonLatLine(material, lineRange(-180, 180, 2).map((lon) => [lon, lat])));
  }
  return group;
}

function createLonLatLine(material, lonLatPairs) {
  const points = lonLatPairs.map(([lon, lat]) => displayLonLatPoint(lon, lat, GRATICULE_RADIUS));
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const line = new THREE.Line(geometry, material);
  line.renderOrder = 34;
  return line;
}

function displayLonLatPoint(lon, lat, radius) {
  const point = displayArray(lonLatToVector(lon, lat, radius));
  return new THREE.Vector3(point[0], point[1], point[2]);
}

function lineRange(start, stop, step) {
  const values = [];
  for (let value = start; value <= stop; value += step) {
    values.push(value);
  }
  return values;
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

function sphereDotPadding(sphere) {
  return Math.min(1, sphere.radius / Math.max(1e-6, sphere.center.length()));
}

function tileIntersectsAngularCap(direction, sphere, capAngle) {
  const center = sphere.center.clone().normalize();
  const centerAngle = Math.acos(THREE.MathUtils.clamp(direction.dot(center), -1, 1));
  const angularRadius = Math.asin(Math.min(1, sphere.radius / Math.max(1e-6, sphere.center.length())));
  return centerAngle - angularRadius <= capAngle;
}

function raySphereIntersection(origin, direction, radius) {
  const b = origin.dot(direction);
  const c = origin.lengthSq() - radius * radius;
  const discriminant = b * b - c;
  if (discriminant < 0) {
    return null;
  }
  const root = Math.sqrt(discriminant);
  const near = -b - root;
  const far = -b + root;
  const t = near >= 0 ? near : far;
  if (t < 0) {
    return null;
  }
  return origin.clone().addScaledVector(direction, t);
}

function emptyRenderStats(visible = 0) {
  return {
    visible,
    orderCounts: {},
    exact: 0,
    approximate: 0,
    missing: visible,
    maxSourceOrder: null
  };
}

function orderCounts(tiles) {
  const counts = {};
  for (const tile of tiles) {
    counts[tile.order] = (counts[tile.order] ?? 0) + 1;
  }
  return counts;
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
