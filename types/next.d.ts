declare module 'next' {
  import type { IncomingMessage, ServerResponse } from 'http';

  export interface NextApiRequest extends IncomingMessage {
    method?: string;
    body?: any;
  }

  export interface NextApiResponse<T = any> extends ServerResponse {
    status: (statusCode: number) => NextApiResponse<T>;
    json: (body: T) => NextApiResponse<T>;
    setHeader: (name: string, value: string | string[]) => void;
  }
}
