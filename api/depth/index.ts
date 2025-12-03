import type { NextApiRequest, NextApiResponse } from 'next';
import fetch from 'node-fetch';

const HF_MODEL = process.env.HF_MODEL_NAME || 'depth-anything/Depth-Anything-V2-base';
const HF_URL = `https://api-inference.huggingface.co/models/${HF_MODEL}`;

export const config = {
  api: { bodyParser: { sizeLimit: '20mb' } },
};

type DepthResponse = {
  depthPngBase64: string;
  model: string;
  ts: string;
};

type ErrorResponse = {
  error: string;
  details?: string;
};

const isJson = (res: Response) => res.headers.get('content-type')?.includes('application/json');

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<DepthResponse | ErrorResponse>,
) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method not allowed. Use POST.' });
    }

    const { imageBase64 } = req.body as { imageBase64?: string };
    if (!imageBase64) {
      return res.status(400).json({ error: 'imageBase64 required' });
    }

    if (!process.env.HF_API_TOKEN) {
      return res.status(500).json({ error: 'HF_API_TOKEN is not configured on the server' });
    }

    const base64Payload = imageBase64.includes(',') ? imageBase64.split(',').pop()! : imageBase64;
    const imageBuffer = Buffer.from(base64Payload, 'base64');

    const hfRes = await fetch(HF_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.HF_API_TOKEN}`,
        'Content-Type': 'application/octet-stream',
      },
      body: imageBuffer,
    });

    if (!hfRes.ok) {
      const errorPayload = isJson(hfRes) ? await hfRes.json() : await hfRes.text();
      return res.status(502).json({
        error: 'Hugging Face inference failed',
        details: typeof errorPayload === 'string' ? errorPayload : JSON.stringify(errorPayload),
      });
    }

    if (isJson(hfRes)) {
      const json = await hfRes.json();
      const depthBase64 = json.depthmap || json.depth || json.image || json.data;
      if (!depthBase64) {
        return res.status(500).json({ error: 'Unexpected HF JSON response – missing depth payload' });
      }
      return res.status(200).json({
        depthPngBase64: depthBase64.startsWith('data:')
          ? depthBase64
          : `data:image/png;base64,${depthBase64}`,
        model: HF_MODEL,
        ts: new Date().toISOString(),
      });
    }

    const depthPng = await hfRes.arrayBuffer();
    const base64 = Buffer.from(depthPng).toString('base64');

    return res.status(200).json({
      depthPngBase64: `data:image/png;base64,${base64}`,
      model: HF_MODEL,
      ts: new Date().toISOString(),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown server error';
    return res.status(500).json({ error: message });
  }
}
