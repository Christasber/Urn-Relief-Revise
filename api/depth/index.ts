import type { NextApiRequest, NextApiResponse } from 'next';
import fetch from 'node-fetch';

const HF_MODEL = process.env.HF_MODEL_NAME ?? 'depth-anything/Depth-Anything-V2-base';
const HF_URL = `https://api-inference.huggingface.co/models/${HF_MODEL}`;

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '20mb',
    },
  },
};

export type DepthApiSuccess = {
  depthPngBase64: string;
  model: string;
  ts: string;
};

export type DepthApiError = {
  error: string;
  details?: string;
};

function isPost(req: NextApiRequest): boolean {
  return req.method?.toUpperCase() === 'POST';
}

async function readBase64Image(req: NextApiRequest): Promise<Buffer> {
  const { imageBase64 } = req.body as { imageBase64?: string };
  if (!imageBase64) {
    throw new Error('imageBase64 required');
  }

  const base64String = imageBase64.includes(',') ? imageBase64.split(',').pop()! : imageBase64;
  return Buffer.from(base64String, 'base64');
}

async function callHuggingFace(imageBuffer: Buffer): Promise<string> {
  if (!process.env.HF_API_TOKEN) {
    throw new Error('HF_API_TOKEN env var not configured');
  }

  const response = await fetch(HF_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.HF_API_TOKEN}`,
      'Content-Type': 'application/octet-stream',
    },
    body: imageBuffer,
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`HF error: ${details}`);
  }

  const contentType = response.headers.get('content-type');
  if (contentType?.includes('application/json')) {
    const payload = (await response.json()) as { depthmap?: string; depth?: string };
    const dataUrl = payload.depthmap ?? payload.depth;
    if (!dataUrl) {
      throw new Error('HF JSON payload missing depthmap property');
    }
    const base64 = dataUrl.includes(',') ? dataUrl.split(',').pop()! : dataUrl;
    return `data:image/png;base64,${base64}`;
  }

  const arrayBuffer = await response.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');
  return `data:image/png;base64,${base64}`;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<DepthApiSuccess | DepthApiError>,
) {
  try {
    if (!isPost(req)) {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'POST only' });
    }

    const buffer = await readBase64Image(req);
    const depthPngBase64 = await callHuggingFace(buffer);

    const payload: DepthApiSuccess = {
      depthPngBase64,
      model: HF_MODEL,
      ts: new Date().toISOString(),
    };

    return res.status(200).json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'server error';
    const details = error instanceof Error ? undefined : JSON.stringify(error);
    return res.status(500).json({ error: message, details });
  }
}
