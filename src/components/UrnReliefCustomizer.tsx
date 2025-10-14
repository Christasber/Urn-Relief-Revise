import { useCallback, useMemo, useRef, useState } from 'react';

export type ReliefPreview = {
  glb: string;
  snapshot: string;
  ok: boolean;
  overflowMM: number;
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
};

type Props = {
  maxReliefMM: number;
  defaultReliefMM: number;
  urnUrls: Record<'front' | 'back' | 'left' | 'right' | 'round', string>;
  fonts: string[];
};

const initialFrame: FrameState = {
  enabled: false,
  style: 'plain',
  widthMM: 8,
  thicknessMM: 2,
};

const initialLettering: LetteringState = {
  text: '',
  font: 'Noto Serif',
  sizeMM: 12,
  emboss: true,
};

export function UrnReliefCustomizer({ maxReliefMM, defaultReliefMM, urnUrls, fonts }: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [preview, setPreview] = useState<ReliefPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedSide, setSelectedSide] = useState<'front' | 'back' | 'left' | 'right'>('front');
  const [reliefDepth, setReliefDepth] = useState(defaultReliefMM);
  const [frameState, setFrameState] = useState<FrameState>(initialFrame);
  const [letteringState, setLetteringState] = useState<LetteringState>(initialLettering);

  const urnUrl = useMemo(() => urnUrls[selectedSide] ?? urnUrls.front, [urnUrls, selectedSide]);

  const handleFileChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      setLoading(true);
      setError(null);
      try {
        const base64 = await fileToDataURL(file);
        const depthResp = await fetch('/api/depth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageBase64: base64 }),
        }).then((res) => res.json());

        if (depthResp.error) {
          throw new Error(depthResp.error);
        }

        const worker = new Worker(new URL('../../workers/reliefWorker.ts', import.meta.url));
        worker.postMessage({
          depthPngBase64: depthResp.depthPngBase64,
          maxReliefMM,
          reliefScaleMM: reliefDepth,
          urnGLBUrl: urnUrl,
          urnSide: selectedSide,
          frame: frameState,
          lettering: letteringState,
          unitsPerMM: 0.001,
        });
        worker.onmessage = (ev) => {
          const { previewGLBBase64, snapshotPngBase64, dimensionsOK, maxOverflowMM, error: workerError } = ev.data;
          if (workerError) {
            setError(workerError);
          } else {
            setPreview({ glb: previewGLBBase64, snapshot: snapshotPngBase64, ok: dimensionsOK, overflowMM: maxOverflowMM });
          }
          worker.terminate();
          setLoading(false);
        };
      } catch (err) {
        setLoading(false);
        setError(err instanceof Error ? err.message : 'Failed to create relief');
      }
    },
    [frameState, letteringState, maxReliefMM, reliefDepth, selectedSide, urnUrl]
  );

  const onReset = useCallback(() => {
    setPreview(null);
    setError(null);
    setFrameState(initialFrame);
    setLetteringState(initialLettering);
    setReliefDepth(defaultReliefMM);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [defaultReliefMM]);

  return (
    <div className="urn-relief-customizer">
      <h2>Urn Relief Customizer</h2>
      <div className="controls">
        <label>
          Upload reference photo
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileChange} />
        </label>
        <label>
          Relief depth (mm)
          <input
            type="range"
            min={1}
            max={maxReliefMM}
            value={reliefDepth}
            onChange={(event) => setReliefDepth(Number(event.target.value))}
          />
        </label>
        <label>
          Urn side
          <select value={selectedSide} onChange={(event) => setSelectedSide(event.target.value as typeof selectedSide)}>
            <option value="front">Front</option>
            <option value="back">Back</option>
            <option value="left">Left</option>
            <option value="right">Right</option>
          </select>
        </label>
        <fieldset>
          <legend>Frame</legend>
          <label>
            <input
              type="checkbox"
              checked={frameState.enabled}
              onChange={(event) => setFrameState((prev) => ({ ...prev, enabled: event.target.checked }))}
            />
            Enable frame
          </label>
          {frameState.enabled && (
            <div className="frame-options">
              <label>
                Style
                <select
                  value={frameState.style}
                  onChange={(event) => setFrameState((prev) => ({ ...prev, style: event.target.value as FrameState['style'] }))}
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
                  max={24}
                  value={frameState.widthMM}
                  onChange={(event) => setFrameState((prev) => ({ ...prev, widthMM: Number(event.target.value) }))}
                />
              </label>
              <label>
                Thickness (mm)
                <input
                  type="number"
                  min={1}
                  max={maxReliefMM}
                  value={frameState.thicknessMM}
                  onChange={(event) => setFrameState((prev) => ({ ...prev, thicknessMM: Number(event.target.value) }))}
                />
              </label>
            </div>
          )}
        </fieldset>
        <fieldset>
          <legend>Lettering</legend>
          <label>
            Message
            <input
              type="text"
              value={letteringState.text}
              onChange={(event) => setLetteringState((prev) => ({ ...prev, text: event.target.value }))}
            />
          </label>
          <label>
            Font
            <select
              value={letteringState.font}
              onChange={(event) => setLetteringState((prev) => ({ ...prev, font: event.target.value }))}
            >
              {fonts.map((font) => (
                <option key={font} value={font}>
                  {font}
                </option>
              ))}
            </select>
          </label>
          <label>
            Size (mm)
            <input
              type="number"
              min={6}
              max={40}
              value={letteringState.sizeMM}
              onChange={(event) => setLetteringState((prev) => ({ ...prev, sizeMM: Number(event.target.value) }))}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={letteringState.emboss}
              onChange={(event) => setLetteringState((prev) => ({ ...prev, emboss: event.target.checked }))}
            />
            Emboss
          </label>
        </fieldset>
        <button type="button" onClick={onReset} disabled={loading}>
          Reset
        </button>
      </div>

      {loading && <p className="status">Processing image…</p>}
      {error && <p className="error">{error}</p>}
      {preview && (
        <div className="preview">
          <p>{preview.ok ? 'Ready for cart' : `Overflow of ${preview.overflowMM.toFixed(2)}mm`}</p>
          {preview.snapshot && <img src={preview.snapshot} alt="Relief preview" />}
          <a href={preview.glb} download="urn-relief.glb">
            Download GLB
          </a>
        </div>
      )}
    </div>
  );
}

async function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

export default UrnReliefCustomizer;
