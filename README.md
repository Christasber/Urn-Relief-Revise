# Depth-Anything v2 Urn Customizer

This repository provides a reference implementation for integrating Depth-Anything V2 depth estimation into a Shopify product customizer.  It contains:

- A Next.js/Express-compatible API route that forwards images to the Hugging Face Inference API and returns a 16-bit depth PNG.
- An optional FastAPI server for local inference when you want to host the model yourself.
- A fully featured Three.js web worker that converts the depth map into a relief mesh, shrink-wraps it to urn geometry, and exports preview assets.
- A React component that wires the worker into a Shopify-ready UI, feeds outputs into cart line item properties, and enforces sizing rules.
- A Shopify section schema that exposes urn assets and default relief settings to merchants.

> **Note:** This code focuses on the client/server logic required for integration.  You will still need to supply actual GLB assets for the urns and provide valid font URLs for lettering.

## Project layout

```
api/depth/index.ts      # Hugging Face forwarding API
server/main.py          # Optional local FastAPI inference server
src/workers/reliefWorker.ts   # Three.js worker that builds relief meshes
src/components/UrnReliefCustomizer.tsx # React UI entry point
public/schema/urn-relief-customizer.json # Shopify section schema
```

### Getting started

1. Install dependencies and TypeScript types:
   ```bash
   npm install
   ```
2. Build or type-check the project:
   ```bash
   npm run build
   ```
3. For local inference, install the Depth-Anything V2 weights and run the FastAPI server:
   ```bash
   pip install -r server/requirements.txt
   uvicorn server.main:app --reload
   ```
4. Configure your Shopify app or hosting environment with a valid `HF_API_TOKEN` for the Hugging Face route, or update your storefront to call the local endpoint.

### Shopify integration

- Drop the section schema into your theme and connect the React bundle to the storefront product template.
- When the user clicks **Add to cart**, persist the properties listed in `src/components/UrnReliefCustomizer.tsx` so that the fulfillment team receives all assets and metadata.
- The worker enforces the max relief depth; however, we still flag any overflows in the UI for manual approval.

### Local Depth-Anything V2

The FastAPI server automatically falls back to CPU if CUDA is unavailable, but GPU acceleration is strongly recommended.  Review the comments in `server/main.py` to replace the placeholder inference call with the actual model forward pass.

### Additional notes

- The worker uses `three-mesh-bvh` for efficient collision and proximity tests.
- Text meshes are generated via `opentype.js`; provide font URLs that permit client-side loading.
- The preview exporter produces both a GLB (for in-cart viewers) and a PNG snapshot (for quick thumbnails).

### Built-in lettering font URLs

The React customizer ships with a short list of serif fonts that are loaded directly from the Google Fonts repository via jsDelivr.  You can replace or extend them inside `src/components/UrnReliefCustomizer.tsx` (`FONT_OPTIONS`).

| Font        | URL                                                                 |
|-------------|---------------------------------------------------------------------|
| EB Garamond | `https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/ebgaramond/EBGaramond-Regular.ttf` |
| Lora        | `https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/lora/Lora-Regular.ttf`              |
| Noto Serif  | `https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/notoserif/NotoSerif-Regular.ttf`    |

These links are HTTPS, CORS-friendly, and compatible with `opentype.js` parsing in the worker.  If you prefer branded fonts, add their URLs to `FONT_OPTIONS` or switch the UI to accept merchant-provided inputs.

