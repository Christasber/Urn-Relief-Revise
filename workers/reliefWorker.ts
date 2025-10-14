/* eslint-disable no-restricted-globals */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter';
import { FontLoader } from 'three/examples/jsm/loaders/FontLoader';
import { TextGeometry } from 'three/examples/jsm/geometries/TextGeometry';

export type ReliefReq = {
  depthPngBase64: string;
  maxReliefMM: number;
  reliefScaleMM: number;
  urnGLBUrl: string;
  urnSide: 'front' | 'back' | 'left' | 'right' | { angleDeg: number };
  frame?: { enabled: boolean; style: 'plain' | 'beveled' | 'ornate'; widthMM: number; thicknessMM: number };
  lettering?: { text: string; font: string; sizeMM: number; emboss: boolean };
  unitsPerMM: number;
};

export type ReliefResp = {
  previewGLBBase64: string;
  snapshotPngBase64: string;
  dimensionsOK: boolean;
  maxOverflowMM: number;
};

type ReliefError = { error: string };

type WorkerResponse = ReliefResp | ReliefError;

const gltfLoader = new GLTFLoader();
const fontLoader = new FontLoader();

const urnCache = new Map<string, THREE.Object3D>();
const fontCache = new Map<string, THREE.Font>();

const TEMP_VEC = new THREE.Vector3();
const TEMP_VEC2 = new THREE.Vector3();

self.onmessage = async (ev: MessageEvent<ReliefReq>) => {
  try {
    const req = ev.data;
    const depthTex = await decodeDepth16(req.depthPngBase64);
    const { width, height } = depthTex.image;
    const depthData = depthTex.userData.depthFloat as Float32Array;

    const segments = Math.min(1024, Math.max(256, Math.round(Math.sqrt(width * height) / 2)));
    const geo = new THREE.PlaneGeometry(1, 1, segments, segments);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const displace = req.reliefScaleMM * req.unitsPerMM;

    for (let i = 0; i < pos.count; i += 1) {
      const u = (i % (segments + 1)) / segments;
      const v = Math.floor(i / (segments + 1)) / segments;
      const x = Math.min(width - 1, Math.max(0, Math.round(u * (width - 1))));
      const y = Math.min(height - 1, Math.max(0, Math.round((1 - v) * (height - 1))));
      const d = depthData[y * width + x];
      const z = (d - 0.5) * displace;
      pos.setZ(i, z);
    }
    geo.computeVertexNormals();

    const urn = await loadUrn(req.urnGLBUrl);
    const { matrix, outward } = computeSideTransform(req.urnSide, urn, req.unitsPerMM);
    geo.applyMatrix4(matrix);

    shrinkwrap(geo, urn, outward, req.maxReliefMM * req.unitsPerMM);

    const reliefMesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ color: 0xd5c4a1, metalness: 0.1, roughness: 0.8 })
    );

    const meshes: THREE.Object3D[] = [reliefMesh];

    if (req.frame?.enabled) {
      const frameMesh = makeFrameMesh(geo, req.frame, outward, req.unitsPerMM);
      if (frameMesh) {
        meshes.push(frameMesh);
      }
    }

    if (req.lettering?.text) {
      const textMesh = await makeTextMesh(req.lettering, geo, outward, req.unitsPerMM);
      if (textMesh) {
        meshes.push(textMesh);
      }
    }

    const { dimensionsOK, maxOverflowMM } = checkOverflow(meshes, urn, outward, req.unitsPerMM, req.maxReliefMM);
    const { previewGLBBase64, snapshotPngBase64 } = await exportPreview(meshes, urn);

    const payload: ReliefResp = { previewGLBBase64, snapshotPngBase64, dimensionsOK, maxOverflowMM };
    (self as DedicatedWorkerGlobalScope).postMessage(payload satisfies WorkerResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Relief worker failed';
    (self as DedicatedWorkerGlobalScope).postMessage({ error: message } satisfies WorkerResponse);
  }
};

async function decodeDepth16(dataUrl: string) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('Unable to obtain canvas context for depth decoding');
  }
  ctx.drawImage(bitmap, 0, 0);
  const raw = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  const depth = new Float32Array(bitmap.width * bitmap.height);
  for (let i = 0, j = 0; i < raw.length; i += 4, j += 1) {
    const hi = raw[i];
    const lo = raw[i + 1];
    const value = (hi << 8) | lo;
    depth[j] = value / 65535.0;
  }
  const texture = new THREE.DataTexture(depth, bitmap.width, bitmap.height, THREE.RedFormat, THREE.FloatType);
  texture.needsUpdate = true;
  (texture as THREE.DataTexture & { userData: Record<string, unknown> }).userData = {
    depthFloat: depth,
  };
  return texture;
}

async function loadUrn(url: string): Promise<THREE.Object3D> {
  if (urnCache.has(url)) {
    return urnCache.get(url)!.clone(true);
  }
  const arrayBuffer = await fetch(url).then((res) => {
    if (!res.ok) {
      throw new Error(`Failed to load urn GLB: ${res.status}`);
    }
    return res.arrayBuffer();
  });
  const glb = await new Promise<THREE.Object3D>((resolve, reject) => {
    gltfLoader.parse(
      arrayBuffer,
      '',
      (gltf) => {
        resolve(gltf.scene);
      },
      (err) => reject(err)
    );
  });
  urnCache.set(url, glb);
  return glb.clone(true);
}

function computeSideTransform(
  side: ReliefReq['urnSide'],
  urn: THREE.Object3D,
  unitsPerMM: number
): { matrix: THREE.Matrix4; outward: THREE.Vector3 } {
  const box = new THREE.Box3().setFromObject(urn);
  if (!box.isEmpty()) {
    box.expandByScalar(1e-4);
  }
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  const matrix = new THREE.Matrix4();
  const scale = new THREE.Matrix4();
  const rotation = new THREE.Matrix4();
  const translation = new THREE.Matrix4();

  let outward = new THREE.Vector3(0, 0, 1);
  let width = size.x;
  let height = size.y;
  let depthOffset = 0;

  if (typeof side === 'string') {
    switch (side) {
      case 'front':
        outward = new THREE.Vector3(0, 0, 1);
        translation.makeTranslation(center.x, center.y, box.max.z + 0.1 * unitsPerMM);
        width = size.x;
        height = size.y;
        break;
      case 'back':
        outward = new THREE.Vector3(0, 0, -1);
        rotation.makeRotationY(Math.PI);
        translation.makeTranslation(center.x, center.y, box.min.z - 0.1 * unitsPerMM);
        width = size.x;
        height = size.y;
        break;
      case 'right':
        outward = new THREE.Vector3(1, 0, 0);
        rotation.makeRotationY(-Math.PI / 2);
        translation.makeTranslation(box.max.x + 0.1 * unitsPerMM, center.y, center.z);
        width = size.z;
        height = size.y;
        break;
      case 'left':
        outward = new THREE.Vector3(-1, 0, 0);
        rotation.makeRotationY(Math.PI / 2);
        translation.makeTranslation(box.min.x - 0.1 * unitsPerMM, center.y, center.z);
        width = size.z;
        height = size.y;
        break;
      default:
        throw new Error(`Unsupported urn side: ${side satisfies never}`);
    }
  } else {
    const angle = THREE.MathUtils.degToRad(side.angleDeg);
    outward = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
    rotation.makeRotationY(angle - Math.PI / 2);
    depthOffset = size.x * 0.5;
    translation.makeTranslation(center.x + outward.x * depthOffset, center.y, center.z + outward.z * depthOffset);
    width = size.x * Math.PI * 0.5;
    height = size.y;
  }

  if (rotation.determinant() === 0) {
    rotation.identity();
  }

  scale.makeScale(width, height, 1);
  matrix.multiplyMatrices(translation, rotation);
  matrix.multiply(scale);
  return { matrix, outward: outward.normalize() };
}

function shrinkwrap(
  geo: THREE.BufferGeometry,
  urn: THREE.Object3D,
  outward: THREE.Vector3,
  maxRelief: number
) {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const raycaster = new THREE.Raycaster();
  const dir = outward.clone().normalize().multiplyScalar(-1);
  const tmp = new THREE.Vector3();
  const origin = new THREE.Vector3();

  for (let i = 0; i < pos.count; i += 1) {
    tmp.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    origin.copy(tmp).addScaledVector(outward, maxRelief * 50);
    raycaster.set(origin, dir);
    const hits = raycaster.intersectObject(urn, true);
    if (hits.length > 0) {
      const surfacePoint = hits[0].point;
      const distance = surfacePoint.distanceTo(tmp);
      if (distance > maxRelief) {
        tmp.copy(surfacePoint).addScaledVector(outward, maxRelief);
      }
      pos.setXYZ(i, tmp.x, tmp.y, tmp.z);
    }
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

function makeFrameMesh(
  geo: THREE.BufferGeometry,
  frame: NonNullable<ReliefReq['frame']>,
  outward: THREE.Vector3,
  unitsPerMM: number
): THREE.Mesh | null {
  const bbox = new THREE.Box3().setFromBufferAttribute(geo.attributes.position as THREE.BufferAttribute);
  const size = bbox.getSize(new THREE.Vector3());

  const width = size.x;
  const height = size.y;
  const depth = Math.min(frame.thicknessMM * unitsPerMM, frame.widthMM * unitsPerMM);
  const outer = new THREE.Shape([
    new THREE.Vector2(-width / 2, -height / 2),
    new THREE.Vector2(-width / 2, height / 2),
    new THREE.Vector2(width / 2, height / 2),
    new THREE.Vector2(width / 2, -height / 2),
  ]);

  const inset = frame.widthMM * unitsPerMM;
  const inner = new THREE.Path([
    new THREE.Vector2(-width / 2 + inset, -height / 2 + inset),
    new THREE.Vector2(-width / 2 + inset, height / 2 - inset),
    new THREE.Vector2(width / 2 - inset, height / 2 - inset),
    new THREE.Vector2(width / 2 - inset, -height / 2 + inset),
  ]);
  outer.holes.push(inner);

  const geometry = new THREE.ExtrudeGeometry(outer, {
    depth,
    bevelEnabled: frame.style !== 'plain',
    bevelThickness: frame.style === 'ornate' ? depth * 0.4 : depth * 0.2,
    bevelSize: inset * 0.3,
    bevelSegments: frame.style === 'plain' ? 1 : 4,
  });

  geometry.translate(0, 0, Math.max(0, inset * 0.1));
  const material = new THREE.MeshStandardMaterial({ color: 0x8d6e63, metalness: 0.2, roughness: 0.6 });
  const mesh = new THREE.Mesh(geometry, material);
  alignObjectNormal(mesh, outward);
  mesh.position.copy(bbox.getCenter(new THREE.Vector3()));
  return mesh;
}

async function makeTextMesh(
  lettering: NonNullable<ReliefReq['lettering']>,
  geo: THREE.BufferGeometry,
  outward: THREE.Vector3,
  unitsPerMM: number
): Promise<THREE.Mesh | null> {
  const text = lettering.text.trim();
  if (!text) {
    return null;
  }
  const font = await loadFont(lettering.font);
  const depth = Math.max(0.2, Math.min(1.2, lettering.sizeMM * 0.2)) * unitsPerMM;
  const geometry = new TextGeometry(text, {
    font,
    size: lettering.sizeMM * unitsPerMM,
    height: depth,
    curveSegments: 8,
    bevelEnabled: false,
  });
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox;
  if (!bbox) {
    return null;
  }
  const center = bbox.getCenter(new THREE.Vector3());
  geometry.translate(-center.x, -center.y, -center.z);

  const reliefBox = new THREE.Box3().setFromBufferAttribute(geo.attributes.position as THREE.BufferAttribute);
  const reliefCenter = reliefBox.getCenter(new THREE.Vector3());
  const reliefSize = reliefBox.getSize(new THREE.Vector3());

  const scaleFactor = Math.min(reliefSize.x / (bbox.max.x - bbox.min.x + 1e-5), reliefSize.y / (bbox.max.y - bbox.min.y + 1e-5)) * 0.6;
  geometry.scale(scaleFactor, scaleFactor, 1);

  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: 0x3e2723, metalness: 0.1, roughness: 0.7 })
  );
  mesh.position.copy(reliefCenter);
  mesh.position.addScaledVector(outward, lettering.emboss ? depth : -depth);
  alignObjectNormal(mesh, outward);
  return mesh;
}

function alignObjectNormal(object: THREE.Object3D, outward: THREE.Vector3) {
  const forward = new THREE.Vector3(0, 0, 1);
  const quaternion = new THREE.Quaternion().setFromUnitVectors(forward, outward.clone().normalize());
  object.quaternion.multiply(quaternion);
}

async function loadFont(name: string): Promise<THREE.Font> {
  if (fontCache.has(name)) {
    return fontCache.get(name)!;
  }
  const url = name.endsWith('.json') ? name : `/fonts/${name}.json`;
  const font = await new Promise<THREE.Font>((resolve, reject) => {
    fontLoader.load(
      url,
      (loaded) => resolve(loaded),
      undefined,
      (err) => reject(err)
    );
  });
  fontCache.set(name, font);
  return font;
}

function checkOverflow(
  meshes: THREE.Object3D[],
  urn: THREE.Object3D,
  outward: THREE.Vector3,
  unitsPerMM: number,
  maxReliefMM: number
): { dimensionsOK: boolean; maxOverflowMM: number } {
  const raycaster = new THREE.Raycaster();
  const dir = outward.clone().normalize().multiplyScalar(-1);
  let maxOverflow = 0;
  let ok = true;

  meshes.forEach((mesh) => {
    mesh.updateMatrixWorld(true);
    const geometry = (mesh as THREE.Mesh).geometry as THREE.BufferGeometry;
    const pos = geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i += 1) {
      TEMP_VEC.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      mesh.localToWorld(TEMP_VEC);
      TEMP_VEC2.copy(TEMP_VEC).addScaledVector(outward, maxReliefMM * unitsPerMM);
      raycaster.set(TEMP_VEC2, dir);
      const hits = raycaster.intersectObject(urn, true);
      if (hits.length > 0) {
        const distance = hits[0].point.distanceTo(TEMP_VEC);
        const overflow = distance - maxReliefMM * unitsPerMM;
        if (overflow > 0) {
          maxOverflow = Math.max(maxOverflow, overflow / unitsPerMM);
          ok = false;
        }
      }
    }
  });

  return { dimensionsOK: ok, maxOverflowMM: parseFloat(maxOverflow.toFixed(2)) };
}

async function exportPreview(meshes: THREE.Object3D[], urn: THREE.Object3D) {
  const scene = new THREE.Scene();
  const group = new THREE.Group();
  group.add(urn.clone(true));
  meshes.forEach((mesh) => group.add(mesh.clone(true)));
  scene.add(group);

  const light = new THREE.DirectionalLight(0xffffff, 1.2);
  light.position.set(5, 5, 8);
  scene.add(light);
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));

  const exporter = new GLTFExporter();
  const glbBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    exporter.parse(
      scene,
      (result) => {
        if (result instanceof ArrayBuffer) {
          resolve(result);
        } else {
          const encoded = JSON.stringify(result);
          resolve(new TextEncoder().encode(encoded).buffer);
        }
      },
      { binary: true }
    );
  });
  const previewGLBBase64 = `data:model/gltf-binary;base64,${arrayBufferToBase64(glbBuffer)}`;

  let snapshotPngBase64 = '';
  try {
    const canvas = new OffscreenCanvas(640, 640);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setSize(640, 640, false);
    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
    const bbox = new THREE.Box3().setFromObject(group);
    const size = bbox.getSize(new THREE.Vector3());
    const center = bbox.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.7;
    camera.position.copy(center.clone().add(new THREE.Vector3(radius, radius, radius)));
    camera.lookAt(center);
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    snapshotPngBase64 = await blobToDataURL(blob);
    renderer.dispose();
  } catch (error) {
    console.warn('Failed to generate snapshot', error);
    snapshotPngBase64 = '';
  }

  return { previewGLBBase64, snapshotPngBase64 };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function blobToDataURL(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  const base64 = arrayBufferToBase64(arrayBuffer);
  return `data:${blob.type};base64,${base64}`;
}
