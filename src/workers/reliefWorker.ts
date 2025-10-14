/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { MeshBVH } from 'three-mesh-bvh';
import opentype, { Font } from 'opentype.js';

export type ReliefReq = {
  depthPngBase64: string;
  maxReliefMM: number;
  reliefScaleMM: number;
  urnGLBUrl: string;
  urnSide: 'front' | 'back' | 'left' | 'right' | { angleDeg: number };
  frame?: { enabled: boolean; style: 'plain' | 'beveled' | 'ornate'; widthMM: number; thicknessMM: number };
  lettering?: { text: string; font: string; sizeMM: number; emboss: boolean; tracking?: number };
  unitsPerMM: number;
};

export type ReliefResp = {
  previewGLBBase64: string;
  snapshotPngBase64: string;
  dimensionsOK: boolean;
  maxOverflowMM: number;
};

type WorkerError = { error: string };

type SideTarget = {
  matrix: THREE.Matrix4;
  outward: THREE.Vector3;
  bounds: THREE.Box3;
  type: 'rect' | 'round';
};

const loader = new GLTFLoader();

self.onmessage = async (ev: MessageEvent<ReliefReq>) => {
  const port = self as unknown as Worker;
  try {
    const req = ev.data;
    const depth = await decodeDepth16(req.depthPngBase64);
    const { width, height, depthData } = depth;

    const grid = 512;
    const plane = new THREE.PlaneGeometry(1, 1, grid, grid);
    const displace = req.reliefScaleMM * req.unitsPerMM;
    const position = plane.attributes.position as THREE.BufferAttribute;

    for (let i = 0; i < position.count; i += 1) {
      const u = (i % (grid + 1)) / grid;
      const v = Math.floor(i / (grid + 1)) / grid;
      const x = Math.min(width - 1, Math.max(0, Math.round(u * (width - 1))));
      const y = Math.min(height - 1, Math.max(0, Math.round((1 - v) * (height - 1))));
      const d = depthData[y * width + x] - 0.5;
      position.setZ(i, d * displace);
    }
    plane.computeVertexNormals();

    const urn = await loadUrn(req.urnGLBUrl);
    urn.updateMatrixWorld(true);
    const side = sideTarget(req.urnSide, urn);
    alignPlaneToSide(plane, side);
    shrinkwrap(plane, urn, side.outward, req.maxReliefMM * req.unitsPerMM);

    const meshes: THREE.Mesh[] = [
      new THREE.Mesh(plane, new THREE.MeshStandardMaterial({ color: 0xcccccc })),
    ];

    if (req.frame?.enabled) {
      const frameMesh = makeFrameMesh(plane, side, req.frame, req.unitsPerMM);
      if (frameMesh) meshes.push(frameMesh);
    }

    if (req.lettering?.text) {
      const textMesh = await makeTextMesh(plane, side, req.lettering, req.unitsPerMM);
      if (textMesh) meshes.push(textMesh);
    }

    meshes.forEach((m) => m.updateMatrixWorld(true));

    const { dimensionsOK, maxOverflowMM } = checkOverflow(meshes, urn, req.unitsPerMM, req.maxReliefMM);

    const { previewGLBBase64, snapshotPngBase64 } = await exportPreview(meshes, urn);

    port.postMessage({ previewGLBBase64, snapshotPngBase64, dimensionsOK, maxOverflowMM } satisfies ReliefResp);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Relief worker failed';
    port.postMessage({ error: message } satisfies WorkerError);
  }
};

async function decodeDepth16(
  dataUrl: string,
): Promise<{ width: number; height: number; depthData: Float32Array }>
{
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const image = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Failed to create 2D context for depth decoding');
  ctx.drawImage(image, 0, 0);
  const raw = ctx.getImageData(0, 0, image.width, image.height).data;

  const depth = new Float32Array(image.width * image.height);
  for (let i = 0, j = 0; i < raw.length; i += 4, j += 1) {
    const hi = raw[i];
    const lo = raw[i + 1];
    const value = (hi << 8) | lo;
    depth[j] = value / 65535;
  }
  return { width: image.width, height: image.height, depthData: depth };
}

async function loadUrn(url: string): Promise<THREE.Object3D> {
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (gltf) => {
        const scene = gltf.scene || gltf.scenes?.[0];
        if (!scene) {
          reject(new Error('GLB did not contain a scene'));
          return;
        }
        resolve(scene.clone(true));
      },
      undefined,
      (err) => reject(err),
    );
  });
}

function sideTarget(side: ReliefReq['urnSide'], urn: THREE.Object3D): SideTarget {
  const bounds = new THREE.Box3().setFromObject(urn);
  const matrix = new THREE.Matrix4();
  const outward = new THREE.Vector3(0, 0, 1);

  if (typeof side === 'object') {
    const angle = THREE.MathUtils.degToRad(side.angleDeg);
    const radius = Math.max(bounds.getSize(new THREE.Vector3()).x, bounds.getSize(new THREE.Vector3()).z) / 2;
    const rotation = new THREE.Matrix4().makeRotationY(angle);
    const translation = new THREE.Matrix4().makeTranslation(
      Math.sin(angle) * radius,
      0,
      Math.cos(angle) * radius,
    );
    matrix.multiplyMatrices(translation, rotation);
    outward.set(Math.sin(angle), 0, Math.cos(angle));
    return { matrix, outward, bounds, type: 'round' };
  }

  const center = bounds.getCenter(new THREE.Vector3());
  switch (side) {
    case 'front':
      matrix.makeTranslation(center.x, center.y, bounds.max.z + 0.001);
      outward.set(0, 0, 1);
      return { matrix, outward, bounds, type: 'rect' };
    case 'back': {
      const rot = new THREE.Matrix4().makeRotationY(Math.PI);
      const trans = new THREE.Matrix4().makeTranslation(center.x, center.y, bounds.min.z - 0.001);
      matrix.multiplyMatrices(trans, rot);
      outward.set(0, 0, -1);
      return { matrix, outward, bounds, type: 'rect' };
    }
    case 'left': {
      const rot = new THREE.Matrix4().makeRotationY(-Math.PI / 2);
      const trans = new THREE.Matrix4().makeTranslation(bounds.min.x - 0.001, center.y, center.z);
      matrix.multiplyMatrices(trans, rot);
      outward.set(-1, 0, 0);
      return { matrix, outward, bounds, type: 'rect' };
    }
    case 'right': {
      const rot = new THREE.Matrix4().makeRotationY(Math.PI / 2);
      const trans = new THREE.Matrix4().makeTranslation(bounds.max.x + 0.001, center.y, center.z);
      matrix.multiplyMatrices(trans, rot);
      outward.set(1, 0, 0);
      return { matrix, outward, bounds, type: 'rect' };
    }
    default:
      throw new Error(`Unsupported urn side: ${side satisfies never}`);
  }
}

function alignPlaneToSide(geo: THREE.BufferGeometry, side: SideTarget) {
  const size = side.bounds.getSize(new THREE.Vector3());
  const widthAxis = Math.abs(side.outward.x) > 0.5 ? size.z : size.x;
  const height = size.y;

  const scale = new THREE.Matrix4().makeScale(widthAxis, height, 1);
  geo.applyMatrix4(scale);
  geo.applyMatrix4(side.matrix);
  geo.computeVertexNormals();
}

function shrinkwrap(
  geo: THREE.BufferGeometry,
  urn: THREE.Object3D,
  outward: THREE.Vector3,
  maxRelief: number,
) {
  const raycaster = new THREE.Raycaster();
  const direction = outward.clone().normalize();
  const temp = new THREE.Vector3();
  const origin = new THREE.Vector3();
  const positions = geo.attributes.position as THREE.BufferAttribute;

  const meshes: THREE.Mesh[] = [];
  urn.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      meshes.push(child as THREE.Mesh);
    }
  });

  for (let i = 0; i < positions.count; i += 1) {
    temp.fromBufferAttribute(positions, i);
    origin.copy(temp).addScaledVector(direction, maxRelief * 2 + 0.1);
    raycaster.set(origin, direction.clone().multiplyScalar(-1));

    let closest: THREE.Intersection<THREE.Object3D<THREE.Event>> | null = null;
    for (const mesh of meshes) {
      const hits = raycaster.intersectObject(mesh, false);
      if (hits.length > 0) {
        const hit = hits[0];
        if (!closest || hit.distance < closest.distance) {
          closest = hit;
        }
      }
    }

    if (closest) {
      const hitPoint = closest.point;
      const maxPoint = hitPoint.clone().addScaledVector(direction, maxRelief);
      if (temp.distanceTo(hitPoint) > maxRelief) {
        positions.setXYZ(i, maxPoint.x, maxPoint.y, maxPoint.z);
      }
    }
  }
  positions.needsUpdate = true;
  geo.computeVertexNormals();
}

function makeFrameMesh(
  plane: THREE.BufferGeometry,
  side: SideTarget,
  frame: NonNullable<ReliefReq['frame']>,
  unitsPerMM: number,
): THREE.Mesh | null {
  plane.computeBoundingBox();
  const bbox = plane.boundingBox;
  if (!bbox) return null;

  const width = bbox.max.x - bbox.min.x;
  const height = bbox.max.y - bbox.min.y;

  const frameWidth = frame.widthMM * unitsPerMM;
  const thickness = frame.thicknessMM * unitsPerMM;

  if (side.type === 'round') {
    const radius = Math.max(width, height) / (2 * Math.PI);
    const geometry = new THREE.TorusGeometry(radius, frameWidth * 0.5, 24, 96);
    geometry.rotateX(Math.PI / 2);
    geometry.translate(0, 0, bbox.max.z + thickness * 0.5);
    const material = new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 0.2 });
    return new THREE.Mesh(geometry, material);
  }

  const outer = new THREE.Shape([
    new THREE.Vector2(bbox.min.x - frameWidth, bbox.min.y - frameWidth),
    new THREE.Vector2(bbox.max.x + frameWidth, bbox.min.y - frameWidth),
    new THREE.Vector2(bbox.max.x + frameWidth, bbox.max.y + frameWidth),
    new THREE.Vector2(bbox.min.x - frameWidth, bbox.max.y + frameWidth),
  ]);

  const inner = new THREE.Path([
    new THREE.Vector2(bbox.min.x + frameWidth, bbox.min.y + frameWidth),
    new THREE.Vector2(bbox.max.x - frameWidth, bbox.min.y + frameWidth),
    new THREE.Vector2(bbox.max.x - frameWidth, bbox.max.y - frameWidth),
    new THREE.Vector2(bbox.min.x + frameWidth, bbox.max.y - frameWidth),
  ]);
  inner.autoClose = true;
  outer.holes.push(inner);

  const bevel = frame.style === 'plain' ? 0 : frameWidth * (frame.style === 'ornate' ? 0.5 : 0.3);
  const geometry = new THREE.ExtrudeGeometry(outer, {
    depth: thickness,
    bevelEnabled: frame.style !== 'plain',
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: frame.style === 'ornate' ? 5 : 2,
  });

  geometry.translate(0, 0, bbox.max.z + thickness * 0.5);
  const material = new THREE.MeshStandardMaterial({ color: 0x999999, metalness: 0.3, roughness: 0.4 });
  return new THREE.Mesh(geometry, material);
}

async function makeTextMesh(
  plane: THREE.BufferGeometry,
  side: SideTarget,
  lettering: NonNullable<ReliefReq['lettering']>,
  unitsPerMM: number,
): Promise<THREE.Mesh | null> {
  const font = await loadFont(lettering.font);
  if (!font) return null;

  plane.computeBoundingBox();
  const bbox = plane.boundingBox;
  if (!bbox) return null;

  const size = lettering.sizeMM * unitsPerMM;
  const path = font.getPath(lettering.text, 0, 0, size, { tracking: lettering.tracking ?? 0 });
  const shapes = pathToShapes(path);
  if (shapes.length === 0) return null;

  const depth = Math.max(size * 0.25, 0.2 * unitsPerMM);
  const geometry = new THREE.ExtrudeGeometry(shapes, {
    depth,
    bevelEnabled: true,
    bevelThickness: depth * 0.3,
    bevelSize: depth * 0.3,
    bevelSegments: 2,
  });

  geometry.center();
  const totalHeight = bbox.max.y - bbox.min.y;
  const baseline = bbox.min.y + totalHeight * 0.2;
  const offsetZ = lettering.emboss ? bbox.max.z + depth * 0.6 : bbox.min.z - depth * 0.6;
  geometry.translate((bbox.min.x + bbox.max.x) / 2, baseline, offsetZ);

  const material = new THREE.MeshStandardMaterial({
    color: 0x333333,
    metalness: lettering.emboss ? 0.4 : 0.1,
    roughness: lettering.emboss ? 0.5 : 0.8,
  });

  return new THREE.Mesh(geometry, material);
}

function pathToShapes(path: opentype.Path): THREE.Shape[] {
  const shapes: THREE.Shape[] = [];
  let currentShape: THREE.Shape | null = null;
  let startPoint = new THREE.Vector2();

  for (const cmd of path.commands) {
    const { x, y } = cmd;
    switch (cmd.type) {
      case 'M': {
        currentShape = new THREE.Shape();
        shapes.push(currentShape);
        const point = new THREE.Vector2(x!, -y!);
        currentShape.moveTo(point.x, point.y);
        startPoint = point;
        break;
      }
      case 'L': {
        if (!currentShape) break;
        const point = new THREE.Vector2(x!, -y!);
        currentShape.lineTo(point.x, point.y);
        break;
      }
      case 'C': {
        if (!currentShape) break;
        currentShape.bezierCurveTo(cmd.x1!, -cmd.y1!, cmd.x2!, -cmd.y2!, x!, -y!);
        break;
      }
      case 'Q': {
        if (!currentShape) break;
        currentShape.quadraticCurveTo(cmd.x1!, -cmd.y1!, x!, -y!);
        break;
      }
      case 'Z': {
        if (!currentShape) break;
        currentShape.lineTo(startPoint.x, startPoint.y);
        currentShape.closePath();
        currentShape = null;
        break;
      }
      default:
        break;
    }
  }

  return shapes.filter((shape) => shape.getPoints().length > 0);
}

async function loadFont(url: string): Promise<Font | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load font: ${res.status}`);
    const buf = await res.arrayBuffer();
    return opentype.parse(buf);
  } catch (error) {
    console.error(error);
    return null;
  }
}

function checkOverflow(
  meshes: THREE.Mesh[],
  urn: THREE.Object3D,
  unitsPerMM: number,
  maxReliefMM: number,
): { dimensionsOK: boolean; maxOverflowMM: number } {
  let maxOverflow = 0;
  const urnMesh = findFirstMesh(urn);
  if (!urnMesh) return { dimensionsOK: true, maxOverflowMM: 0 };

  const bvh = new MeshBVH(urnMesh.geometry as THREE.BufferGeometry);

  const tempPoint = new THREE.Vector3();
  const targetLocal = new THREE.Vector3();
  const normalLocal = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const normalWorld = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();

  for (const mesh of meshes) {
    mesh.updateMatrixWorld(true);
    const positions = (mesh.geometry as THREE.BufferGeometry).attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < positions.count; i += 1) {
      tempPoint.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
      const localPoint = tempPoint.clone();
      urnMesh.worldToLocal(localPoint);

      targetLocal.copy(localPoint);
      normalLocal.set(0, 0, 0);
      bvh.closestPointToPoint(localPoint, targetLocal, normalLocal);

      const worldTarget = targetLocal.clone();
      urnMesh.localToWorld(worldTarget);
      normalMatrix.getNormalMatrix(urnMesh.matrixWorld);
      normalWorld.copy(normalLocal).applyMatrix3(normalMatrix).normalize();

      direction.subVectors(tempPoint, worldTarget);
      const distance = direction.length();
      if (distance === 0) continue;
      const signed = Math.sign(direction.dot(normalWorld)) * distance;
      if (signed <= 0) continue;
      const overflow = signed / unitsPerMM - maxReliefMM;
      if (overflow > maxOverflow) {
        maxOverflow = overflow;
      }
    }
  }

  return { dimensionsOK: maxOverflow <= 0.01, maxOverflowMM: Math.max(0, maxOverflow) };
}

function findFirstMesh(obj: THREE.Object3D): THREE.Mesh | null {
  let mesh: THREE.Mesh | null = null;
  obj.traverse((child) => {
    if (!mesh && (child as THREE.Mesh).isMesh) {
      mesh = child as THREE.Mesh;
    }
  });
  return mesh;
}

async function exportPreview(
  meshes: THREE.Mesh[],
  urn: THREE.Object3D,
): Promise<{ previewGLBBase64: string; snapshotPngBase64: string }> {
  const scene = new THREE.Scene();
  const urnClone = urn.clone(true);
  urnClone.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      (child as THREE.Mesh).material = (child as THREE.Mesh).material.clone();
    }
  });
  scene.add(urnClone);
  for (const mesh of meshes) {
    scene.add(mesh.clone(true));
  }

  scene.add(new THREE.AmbientLight(0xffffff, 0.4));
  const light = new THREE.DirectionalLight(0xffffff, 1.0);
  light.position.set(2, 4, 6);
  scene.add(light);

  const exporter = new GLTFExporter();
  const glb = await new Promise<ArrayBuffer>((resolve, reject) => {
    exporter.parse(
      scene,
      (result) => {
        if (result instanceof ArrayBuffer) resolve(result);
        else resolve(new TextEncoder().encode(JSON.stringify(result)).buffer);
      },
      { binary: true },
      (error) => reject(error),
    );
  });

  const canvas = new OffscreenCanvas(768, 768);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setClearColor(new THREE.Color(0xf5f5f5));
  renderer.setSize(768, 768, false);

  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
  const bounds = new THREE.Box3().setFromObject(scene);
  const center = bounds.getCenter(new THREE.Vector3());
  const radius = bounds.getSize(new THREE.Vector3()).length() * 0.6;
  camera.position.copy(center).add(new THREE.Vector3(1, 0.8, 1).normalize().multiplyScalar(radius));
  camera.lookAt(center);
  camera.updateProjectionMatrix();

  renderer.render(scene, camera);
  const blob = await canvas.convertToBlob({ type: 'image/png', quality: 0.92 });
  const pngBuffer = await blob.arrayBuffer();

  return {
    previewGLBBase64: bufferToDataURL(glb, 'model/gltf-binary'),
    snapshotPngBase64: bufferToDataURL(pngBuffer, 'image/png'),
  };
}

function bufferToDataURL(buffer: ArrayBuffer, mime: string): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:${mime};base64,${btoa(binary)}`;
}
