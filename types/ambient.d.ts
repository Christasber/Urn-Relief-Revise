declare module 'react' {
  export type ReactNode = any;
  export type FC<P = {}> = (props: P & { children?: ReactNode }) => any;
  export function useState<T>(initial: T): [T, (value: T | ((prev: T) => T)) => void];
  export function useEffect(effect: () => void | (() => void), deps?: any[]): void;
  export function useMemo<T>(factory: () => T, deps: any[]): T;
  export function useRef<T>(initial: T | null): { current: T | null };
  export function useCallback<T extends (...args: any[]) => any>(fn: T, deps: any[]): T;
  export const Fragment: any;
  const React: any;
  export default React;
}

declare module 'react-dom' {
  const ReactDOM: any;
  export default ReactDOM;
}

declare module 'react-dom/client' {
  export const createRoot: any;
}

declare module 'three' {
  const THREE: any;
  export = THREE;
  export as namespace THREE;
}

declare const THREE: any;
declare namespace THREE {
  type Mesh = any;
  type Object3D<T = any> = any;
  type BufferGeometry = any;
  type BufferAttribute = any;
  type Shape = any;
  type Vector3 = any;
  type Matrix4 = any;
  type Box3 = any;
  type Intersection<T = any> = any;
  type Event = any;
  type Scene = any;
  type PerspectiveCamera = any;
  type MeshStandardMaterial = any;
  type WebGLRenderer = any;
  type Texture = any;
  type DataTexture = any;
}

declare module 'three-mesh-bvh' {
  export const MeshBVH: any;
  export function acceleratedRaycast(...args: any[]): any;
  export function computeBoundsTree(...args: any[]): any;
  export function disposeBoundsTree(...args: any[]): any;
}

declare module 'opentype.js' {
  export type Font = any;
  export type Path = any;
  const opentype: {
    load: (url: string, cb: (err: any, font: Font) => void) => void;
    parse: (buffer: ArrayBuffer | ArrayBufferView) => Font;
  };
  export default opentype;
}
declare namespace opentype {
  type Font = any;
  type Path = any;
}

declare module 'node-fetch' {
  const fetch: (url: any, init?: any) => Promise<any>;
  export default fetch;
}

declare module 'react/jsx-runtime' {
  export const Fragment: any;
  export function jsx(type: any, props: any, key?: any): any;
  export function jsxs(type: any, props: any, key?: any): any;
}

declare module 'three/examples/jsm/loaders/GLTFLoader.js' {
  export class GLTFLoader {
    constructor(manager?: any);
    load(
      url: string,
      onLoad: (gltf: any) => void,
      onProgress?: (event: any) => void,
      onError?: (error: any) => void,
    ): void;
    parse(data: ArrayBuffer | string, path: string, onLoad: (gltf: any) => void, onError?: (error: any) => void): void;
  }
}

declare module 'three/examples/jsm/exporters/GLTFExporter.js' {
  export class GLTFExporter {
    parse(
      input: any,
      onCompleted: (result: any) => void,
      optionsOrOnError?: ((error: any) => void) | Record<string, any>,
      onError?: (error: any) => void,
    ): void;
  }
}

declare namespace JSX {
  interface IntrinsicElements {
    [elemName: string]: any;
  }
}
