"""Depth-Anything-V2 local inference FastAPI server."""
from __future__ import annotations

import base64
import io
from typing import Literal

import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from PIL import Image

try:
    import torch
except ModuleNotFoundError:  # pragma: no cover - torch optional
    torch = None  # type: ignore

app = FastAPI(title="Depth Anything V2 Service", version="1.0.0")

Device = Literal["cpu", "cuda"]

def get_device() -> Device:
    if torch is None:
        return "cpu"
    return "cuda" if torch.cuda.is_available() else "cpu"


def normalise_depth(depth: np.ndarray) -> np.ndarray:
    depth_min = float(np.min(depth))
    depth_max = float(np.max(depth))
    if depth_max - depth_min < 1e-8:
        return np.zeros_like(depth)
    return (depth - depth_min) / (depth_max - depth_min)


def array_to_depth_png(depth: np.ndarray) -> str:
    depth16 = np.clip(depth * 65535.0, 0, 65535).astype(np.uint16)
    png = Image.fromarray(depth16, mode="I;16")
    buf = io.BytesIO()
    png.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("utf-8")


def mock_depth_prediction(image: Image.Image) -> np.ndarray:
    arr = np.asarray(image.resize((512, 512)))
    gray = arr.mean(axis=2)
    depth = normalise_depth(gray)
    return depth.astype(np.float32)


@app.post("/depth")
async def generate_depth(file: UploadFile = File(...)) -> JSONResponse:
    if file.content_type not in {"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"}:
        raise HTTPException(status_code=400, detail="Unsupported file type")

    image_bytes = await file.read()
    try:
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    except Exception as exc:  # pragma: no cover - PIL handles errors internally
        raise HTTPException(status_code=400, detail=f"Invalid image: {exc}") from exc

    # TODO: replace mock implementation with real Depth-Anything-V2 model forward pass.
    depth = mock_depth_prediction(image)
    depth_png = array_to_depth_png(depth)
    return JSONResponse(
        {
            "depthPngBase64": depth_png,
            "model": "depth-anything/Depth-Anything-V2-base",
            "device": get_device(),
        }
    )


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
