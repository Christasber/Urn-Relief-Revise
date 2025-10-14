"""FastAPI server that performs Depth-Anything V2 inference locally.

This module loads the Depth-Anything V2 model (small/base/large) and exposes a
single `/depth` endpoint that accepts an uploaded RGB image.  The response is a
16-bit PNG depth map encoded as base64 so that the storefront worker can decode
it losslessly.  The implementation keeps the core pieces extensible so you can
swap in your own preprocessing or batching logic.
"""

from __future__ import annotations

import base64
import io
from datetime import datetime
from functools import lru_cache
from typing import Literal

import numpy as np
import torch
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from PIL import Image

try:
    from depth_anything_v2 import DepthAnythingV2
except ImportError as exc:  # pragma: no cover - optional dependency
    DepthAnythingV2 = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc
else:
    _IMPORT_ERROR = None


ModelSize = Literal["small", "base", "large"]

app = FastAPI(title="Depth-Anything V2 Local Inference")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@lru_cache(maxsize=1)
def load_model(model_size: ModelSize = "base"):
    if DepthAnythingV2 is None:  # pragma: no cover - import guard
        raise RuntimeError(
            "depth_anything_v2 is not installed. Install the library or switch to the Hugging Face endpoint."
        ) from _IMPORT_ERROR

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    weights = f"depth-anything/Depth-Anything-V2-{model_size}"
    model = DepthAnythingV2.from_pretrained(weights)  # type: ignore[attr-defined]
    model.to(device)
    model.eval()
    return model, device


def _prepare_image(file_bytes: bytes) -> Image.Image:
    try:
        img = Image.open(io.BytesIO(file_bytes)).convert("RGB")
    except Exception as exc:  # pragma: no cover - Pillow handles errors internally
        raise HTTPException(status_code=400, detail=f"Invalid image: {exc}") from exc
    return img


def _infer_depth(img: Image.Image, model_size: ModelSize) -> np.ndarray:
    model, device = load_model(model_size)
    np_img = np.asarray(img).astype(np.float32) / 255.0
    tensor = torch.from_numpy(np_img).permute(2, 0, 1).unsqueeze(0).to(device)

    with torch.inference_mode():
        pred = model(tensor)  # type: ignore[operator]

    depth = pred.squeeze().detach().cpu().numpy().astype(np.float32)
    depth -= depth.min()
    max_val = depth.max()
    if max_val > 0:
        depth /= max_val
    return depth


def _encode_depth_png(depth: np.ndarray) -> str:
    depth16 = np.clip(depth * 65535.0, 0, 65535).astype(np.uint16)
    png = Image.fromarray(depth16, mode="I;16")

    buf = io.BytesIO()
    png.save(buf, format="PNG")
    encoded = base64.b64encode(buf.getvalue()).decode("utf-8")
    return f"data:image/png;base64,{encoded}"


@app.post("/depth")
async def depth_endpoint(
    file: UploadFile = File(...),
    model_size: ModelSize = "base",
):
    content = await file.read()
    if len(content) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image exceeds 20MB limit")

    img = _prepare_image(content)
    depth = _infer_depth(img, model_size)
    depth_b64 = _encode_depth_png(depth)

    return JSONResponse(
        {
            "depthPngBase64": depth_b64,
            "model": f"Depth-Anything-V2-{model_size}",
            "ts": datetime.utcnow().isoformat() + "Z",
        }
    )


if __name__ == "__main__":  # pragma: no cover - manual execution helper
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
