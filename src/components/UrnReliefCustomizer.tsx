import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReliefReq, ReliefResp } from '@/workers/reliefWorker';

type WorkerHandle = Worker | null;

type UrnAssetMap = {
  front: string;
  back: string;
  left: string;
  right: string;
  round: string;
};

type FrameState = {
  enabled: boolean;
  style: 'plain' | 'beveled' | 'ornate';
  widthMM: number;
  thicknessMM: number;
};

type LetteringState = {
  text: string;
  font: string;
  sizeMM: number;
  emboss: boolean;
  tracking?: number;
};

type ReliefState = {
  file?: File;
  sourceImageBase64?: string;
  depth?: string;
  preview?: ReliefResp;
  isProcessing: boolean;
  error?: string;
};

type Props = {
  assets: Partial<UrnAssetMap>;
  maxReliefMM: number;
  defaultReliefMM: number;
  unitsPerMM?: number;
  onPreview?: (preview: ReliefResp | null) => void;
  onPropertiesChange?: (properties: Record<string, string>) => void;
};

const DEFAULT_FRAME: FrameState = {
  enabled: false,
  style: 'plain',
  widthMM: 4,
  thicknessMM: 2,
};

const DEFAULT_LETTERING: LetteringState = {
  text: '',
  font: '',
  sizeMM: 14,
  emboss: true,
};

export function UrnReliefCustomizer({
  assets,
  maxReliefMM,
  defaultReliefMM,
  unitsPerMM = 0.001,
  onPreview,
  onPropertiesChange,
}: Props) {
  const workerRef = useRef<WorkerHandle>(null);
  const [relief, setRelief] = useState<ReliefState>({ isProcessing: false });
  const [selectedSide, setSelectedSide] = useState<'front' | 'back' | 'left' | 'right' | 'round'>('front');
  const [roundAngle, setRoundAngle] = useState(0);
  const [reliefDepth, setReliefDepth] = useState(defaultReliefMM);
  const [frame, setFrame] = useState<FrameState>(DEFAULT_FRAME);
  const [lettering, setLettering] = useState<LetteringState>(DEFAULT_LETTERING);
  const [detailLevel, setDetailLevel] = useState<'draft' | 'high'>('draft');
  const [smoothing, setSmoothing] = useState(0.5);

  useEffect(() => () => {
    workerRef.current?.terminate();
    workerRef.current = null;
  }, []);

  useEffect(() => {
    if (relief.preview && onPreview) onPreview(relief.preview);
  }, [relief.preview, onPreview]);

  useEffect(() => {
    if (!onPropertiesChange || !relief.preview) return;
    const properties = buildLineItemProperties({
      preview: relief.preview,
      reliefDepthMM: reliefDepth,
      detailLevel,
      smoothingLevel: smoothing,
      frame,
      lettering,
      side: selectedSide,
      roundAngle,
      depthMap: relief.depth,
      sourceImage: relief.sourceImageBase64,
    });
    onPropertiesChange(properties);
  }, [
    relief.preview,
    relief.depth,
    relief.sourceImageBase64,
    onPropertiesChange,
    reliefDepth,
    detailLevel,
    smoothing,
    frame,
    lettering,
    selectedSide,
    roundAngle,
  ]);

  const onFileChange = async (file?: File) => {
    setRelief({ isProcessing: false });
    if (!file) return;
    setRelief({ file, isProcessing: false });
  };

  const ensureWorker = () => {
    if (!workerRef.current) {
      workerRef.current = new Worker(new URL('../workers/reliefWorker.ts', import.meta.url), {
        type: 'module',
      });
    }
    return workerRef.current;
  };

  const resolveUrnUrl = (): string | null => {
    if (selectedSide === 'round') {
      return assets.round ?? null;
    }
    return assets[selectedSide] ?? null;
  };

  const createRelief = async () => {
    if (!relief.file) {
      setRelief((prev) => ({ ...prev, error: 'Please upload an image first.' }));
      return;
    }
    const urnUrl = resolveUrnUrl();
    if (!urnUrl) {
      setRelief((prev) => ({ ...prev, error: 'Urn model missing for selected side.' }));
      return;
    }

    try {
      setRelief((prev) => ({ ...prev, isProcessing: true, error: undefined }));
      const base64 = await fileToDataUrl(relief.file);
      const depthRes = await fetch('/api/depth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: base64, detail: detailLevel }),
      }).then((res) => res.json());

      if (!depthRes.depthPngBase64) {
        throw new Error(depthRes.error || 'Depth API did not return a depth map.');
      }

      const worker = ensureWorker();
      const req: ReliefReq = {
        depthPngBase64: depthRes.depthPngBase64,
        maxReliefMM,
        reliefScaleMM: reliefDepth,
        urnGLBUrl: urnUrl,
        urnSide: selectedSide === 'round' ? { angleDeg: roundAngle } : selectedSide,
        frame,
        lettering: lettering.text ? lettering : undefined,
        unitsPerMM,
      };

      worker.onmessage = (event: MessageEvent<ReliefResp | { error: string }>) => {
        if ('error' in event.data) {
          setRelief({
            file: relief.file,
            sourceImageBase64: base64,
            depth: depthRes.depthPngBase64,
            isProcessing: false,
            error: event.data.error,
          });
          return;
        }
        setRelief({
          file: relief.file,
          sourceImageBase64: base64,
          depth: depthRes.depthPngBase64,
          preview: event.data,
          isProcessing: false,
        });
      };

      worker.postMessage(req);
    } catch (error) {
      setRelief((prev) => ({
        ...prev,
        isProcessing: false,
        error: error instanceof Error ? error.message : 'Failed to create relief',
      }));
    }
  };

  const previewMarkup = useMemo(() => {
    if (!relief.preview) return null;
    return (
      <figure className="urn-relief__preview">
        <img src={relief.preview.snapshotPngBase64} alt="Relief preview" />
        {!relief.preview.dimensionsOK && (
          <figcaption className="urn-relief__warning">
            Relief exceeds max depth by {relief.preview.maxOverflowMM.toFixed(2)}mm.
          </figcaption>
        )}
      </figure>
    );
  }, [relief.preview]);

  return (
    <div className="urn-relief">
      <div className="urn-relief__upload">
        <label className="urn-relief__label">
          Upload source photo
          <input type="file" accept="image/*" onChange={(event) => onFileChange(event.target.files?.[0])} />
        </label>
        <button type="button" onClick={createRelief} disabled={relief.isProcessing}>
          {relief.isProcessing ? 'Processing…' : 'Generate relief'}
        </button>
        {relief.error && <p className="urn-relief__error">{relief.error}</p>}
      </div>

      <div className="urn-relief__controls">
        <fieldset>
          <legend>Relief depth (mm)</legend>
          <input
            type="range"
            min={0}
            max={maxReliefMM}
            step={0.5}
            value={reliefDepth}
            onChange={(event) => setReliefDepth(Number(event.target.value))}
          />
          <span>{reliefDepth.toFixed(1)} mm</span>
        </fieldset>

        <fieldset>
          <legend>Urn side</legend>
          <select value={selectedSide} onChange={(event) => setSelectedSide(event.target.value as typeof selectedSide)}>
            <option value="front">Front</option>
            <option value="back">Back</option>
            <option value="left">Left</option>
            <option value="right">Right</option>
            <option value="round">Round</option>
          </select>
          {selectedSide === 'round' && (
            <label>
              Angle (°)
              <input
                type="number"
                min={0}
                max={359}
                value={roundAngle}
                onChange={(event) => setRoundAngle(Number(event.target.value))}
              />
            </label>
          )}
        </fieldset>

        <fieldset>
          <legend>Frame</legend>
          <label>
            <input
              type="checkbox"
              checked={frame.enabled}
              onChange={(event) => setFrame((prev) => ({ ...prev, enabled: event.target.checked }))}
            />
            Add frame
          </label>
          {frame.enabled && (
            <div className="urn-relief__frame-options">
              <label>
                Style
                <select
                  value={frame.style}
                  onChange={(event) => setFrame((prev) => ({ ...prev, style: event.target.value as FrameState['style'] }))}
                >
                  <option value="plain">Plain</option>
                  <option value="beveled">Beveled</option>
                  <option value="ornate">Ornate</option>
                </select>
              </label>
              <label>
                Width (mm)
                <input
                  type="number"
                  min={2}
                  max={20}
                  value={frame.widthMM}
                  onChange={(event) => setFrame((prev) => ({ ...prev, widthMM: Number(event.target.value) }))}
                />
              </label>
              <label>
                Thickness (mm)
                <input
                  type="number"
                  min={1}
                  max={12}
                  value={frame.thicknessMM}
                  onChange={(event) => setFrame((prev) => ({ ...prev, thicknessMM: Number(event.target.value) }))}
                />
              </label>
            </div>
          )}
        </fieldset>

        <fieldset>
          <legend>Lettering</legend>
          <label>
            Text
            <input
              value={lettering.text}
              onChange={(event) => setLettering((prev) => ({ ...prev, text: event.target.value }))}
            />
          </label>
          <label>
            Font URL
            <input
              value={lettering.font}
              onChange={(event) => setLettering((prev) => ({ ...prev, font: event.target.value }))}
            />
          </label>
          <label>
            Size (mm)
            <input
              type="number"
              min={6}
              max={48}
              value={lettering.sizeMM}
              onChange={(event) => setLettering((prev) => ({ ...prev, sizeMM: Number(event.target.value) }))}
            />
          </label>
          <label>
            Embossed?
            <input
              type="checkbox"
              checked={lettering.emboss}
              onChange={(event) => setLettering((prev) => ({ ...prev, emboss: event.target.checked }))}
            />
          </label>
        </fieldset>

        <fieldset>
          <legend>Quality</legend>
          <label>
            Detail level
            <select value={detailLevel} onChange={(event) => setDetailLevel(event.target.value as typeof detailLevel)}>
              <option value="draft">Draft (-small)</option>
              <option value="high">High (-base)</option>
            </select>
          </label>
          <label>
            Smoothing
            <input
              type="range"
              min={0}
              max={1}
              step={0.1}
              value={smoothing}
              onChange={(event) => setSmoothing(Number(event.target.value))}
            />
          </label>
        </fieldset>
      </div>

      {previewMarkup}
    </div>
  );
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

type PropertiesInput = {
  preview: ReliefResp;
  reliefDepthMM: number;
  detailLevel: 'draft' | 'high';
  smoothingLevel: number;
  frame: FrameState;
  lettering: LetteringState;
  side: 'front' | 'back' | 'left' | 'right' | 'round';
  roundAngle: number;
  depthMap?: string;
  sourceImage?: string;
};

function buildLineItemProperties({
  preview,
  reliefDepthMM,
  detailLevel,
  smoothingLevel,
  frame,
  lettering,
  side,
  roundAngle,
  depthMap,
  sourceImage,
}: PropertiesInput): Record<string, string> {
  return {
    urn_side: side,
    urn_angle_deg: side === 'round' ? roundAngle.toString() : '0',
    relief_depth_mm: reliefDepthMM.toFixed(2),
    detail_level: detailLevel,
    smoothing_level: smoothingLevel.toFixed(2),
    frame_enabled: frame.enabled ? 'true' : 'false',
    frame_style: frame.style,
    frame_width_mm: frame.widthMM.toFixed(2),
    frame_thickness_mm: frame.thicknessMM.toFixed(2),
    lettering_text: lettering.text,
    lettering_font: lettering.font,
    lettering_size_mm: lettering.sizeMM.toFixed(2),
    lettering_emboss: lettering.emboss ? 'true' : 'false',
    source_image_url: sourceImage ?? '',
    heightmap_url: depthMap ?? '',
    preview_glb_url: preview.previewGLBBase64,
    preview_png_url: preview.snapshotPngBase64,
    dimensions_ok: preview.dimensionsOK ? 'true' : 'false',
    max_overflow_mm: preview.maxOverflowMM.toFixed(2),
    ai_engine: 'Depth-Anything-V2',
  };
}
