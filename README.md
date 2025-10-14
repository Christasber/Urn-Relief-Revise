# Depth-Anything v2 Urn Customizer

This repository contains an end-to-end reference implementation for integrating Depth-Anything-V2 depth estimation into a Shopify product customizer that generates relief meshes for urns.

## Contents

- **/api/depth/index.ts** – Next.js compatible API route that calls the Hugging Face inference endpoint and returns a depth PNG.
- **/server/main.py** – Optional FastAPI server for on-premises inference.
- **/workers/reliefWorker.ts** – Three.js Web Worker that converts the depth map into a shrink-wrapped relief mesh, frame, and lettering, then exports a GLB and PNG preview.
- **/src/components/UrnReliefCustomizer.tsx** – React component demonstrating how to capture user input, call the API, and communicate with the worker.
- **/shopify/sections/urn-relief-customizer.schema.json** – Drop-in Shopify section schema for exposing settings in the theme editor.

## Getting Started

1. Install dependencies (Next.js, Three.js, `three/examples` helpers, and optional `three-mesh-bvh`).
2. Set the `HF_API_TOKEN` environment variable before starting the Next.js dev server.
3. Serve the worker and component via your chosen bundler.
4. (Optional) Run the FastAPI server for local inference.

## Cart Integration

The worker returns preview data and dimension checks that can be stored in Shopify line-item properties:

```json
{
  "urn_model": "urn_rect_a",
  "urn_side": "front",
  "relief_depth_mm": 4,
  "detail_level": "preview",
  "frame_enabled": true,
  "frame_style": "beveled",
  "lettering_text": "In Loving Memory",
  "heightmap_url": "https://.../depth.png",
  "preview_glb_url": "https://.../preview.glb",
  "preview_png_url": "https://.../preview.png",
  "ai_engine": "Depth-Anything-V2",
  "ai_version": "base",
  "dimensions_ok": true,
  "max_overflow_mm": 0.0,
  "timestamp_iso": "2024-01-01T00:00:00.000Z"
}
```

Update the webhook or storefront code to upload source images, previews, and GLBs to Shopify Files or your own storage bucket before submitting the cart.

## Safety & Validation

- Relief depth is clamped via the worker.
- Overflow detection raycasts back to the urn shell.
- Frame and lettering sizes adapt to the relief bounds.

## Notes

- Replace the mock inference in `server/main.py` with the real Depth-Anything-V2 model when running locally.
- Ensure fonts referenced by the worker are available as Three.js JSON font assets (`/fonts/*.json`).
- Bundle the worker with tools such as Vite, Next.js (via `next.config.js` worker loader), or Webpack.
