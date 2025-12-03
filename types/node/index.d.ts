declare module 'http' {
  export class IncomingMessage {
    method?: string;
    headers: Record<string, string | string[] | undefined>;
  }

  export class ServerResponse<T = any> {
    statusCode: number;
    status: (code: number) => ServerResponse<T>;
    json: (body: T) => ServerResponse<T>;
    setHeader: (name: string, value: string | string[]) => void;
  }
}

declare var process: { env: Record<string, string | undefined> };
declare var __dirname: string;
declare var module: any;
declare var require: any;

type BufferEncoding = 'utf8' | 'utf-8' | 'base64' | 'hex' | string;
interface Buffer extends Uint8Array {
  toString: (encoding?: BufferEncoding) => string;
}
declare const Buffer: {
  from(data: string | ArrayBuffer | ArrayBufferView, encoding?: BufferEncoding): Buffer;
  from(data: Uint8Array | ReadonlyArray<number>): Buffer;
  byteLength: (data: string | ArrayBuffer | ArrayBufferView, encoding?: BufferEncoding) => number;
  new (str: string, encoding?: BufferEncoding): Buffer;
};
