// vision.js — visual cortex
// Retinotopic spatial mapping: the visual region is a 10x10 grid of cells.
// Each cell corresponds to a spatial region of the image.
// Objects detected at a position fire the neurons for that grid cell —
// so the brain learns WHERE things appear, not just WHAT they are.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VisionServer } from './vision-server.js';

const FRAME_PATH      = join(tmpdir(), 'echo_frame.jpg');
const FRAME_PREV      = join(tmpdir(), 'echo_frame_prev.jpg');
const OLLAMA_ENDPOINT = 'http://localhost:11434/api/generate';
const VISION_MODEL    = 'moondream';

// Grid dimensions — 10x10 = 100 spatial cells
const GRID_W = 10;
const GRID_H = 10;

function captureFrame() {
    return new Promise((resolve, reject) => {
        // 320x240 is plenty for moondream — much faster encode/transfer
        const ffmpegArgs = [
            '-f', 'avfoundation', '-framerate', '1', '-i', '0',
            '-vframes', '1', '-vf', 'scale=320:240', '-q:v', '4', '-y', FRAME_PATH,
        ];
        execFile('ffmpeg', ffmpegArgs, { timeout: 8000 }, (err) => {
            if (!err) return resolve();
            execFile('imagesnap', ['-w', '0.3', FRAME_PATH], { timeout: 8000 }, (err2) => {
                if (!err2) return resolve();
                reject(new Error('No capture tool. Install ffmpeg or imagesnap.'));
            });
        });
    });
}

// Cheap pixel diff — sample every 50th byte of the JPEG buffer.
// Returns true if the frame changed enough to be worth re-analysing.
function frameChanged(a, b, threshold = 0.03) {
    if (!a || Math.abs(a.length - b.length) / b.length > 0.1) return true;
    let diff = 0;
    const step = 50;
    const samples = Math.floor(Math.min(a.length, b.length) / step);
    for (let i = 0; i < samples; i++) diff += Math.abs(a[i * step] - b[i * step]);
    return (diff / samples) > (threshold * 255);
}

// Ask moondream to return spatially-located detections.
// We ask for position as a fraction of the image (0.0–1.0) so we can map to grid cells.
async function describeFrame(jpg) {
    const b64  = jpg.toString('base64');
    const body = {
        model:  VISION_MODEL,
        prompt: `Analyze this image. For each person, face, or significant object you see, return a JSON array.
Each item: {"label": "what it is", "x": 0.0-1.0, "y": 0.0-1.0, "w": 0.0-1.0, "h": 0.0-1.0, "note": "brief description"}
x,y = top-left corner as fraction of image width/height. w,h = size as fraction.
Focus on people and faces. Include expression and what they are doing in note.
If nothing significant, return [].
Return ONLY the JSON array, no other text.`,
        images: [b64],
        stream: false,
    };
    const res = await fetch(OLLAMA_ENDPOINT, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
        signal:  AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`moondream HTTP ${res.status}`);
    const data = await res.json();
    const text = data.response?.trim() || '';

    let detections = [];
    try {
        // Extract JSON array from response even if moondream adds prose around it
        const match = text.match(/\[[\s\S]*\]/);
        if (match) detections = JSON.parse(match[0]);
    } catch {}

    // Validate and clamp
    detections = detections
        .filter(d => d.label && typeof d.x === 'number')
        .map(d => ({
            label: d.label.toLowerCase().trim(),
            x: Math.max(0, Math.min(1, d.x)),
            y: Math.max(0, Math.min(1, d.y)),
            w: Math.max(0.05, Math.min(1, d.w || 0.2)),
            h: Math.max(0.05, Math.min(1, d.h || 0.2)),
            note: d.note || '',
        }));

    const scene = detections.length > 0
        ? detections.map(d => `${d.label} (${d.note})`).join('; ')
        : null;
    const objects = detections.map(d => d.label);

    return { scene, objects, detections };
}

// Map a detection's spatial position to neuron indices in the visual region.
// The visual region is treated as a GRID_W x GRID_H grid of equal-sized cell blocks.
// Each cell owns (regionSize / GRID_W*GRID_H) neurons.
// An object spanning multiple cells fires all covered cells.
// Within each cell, the object's label hash selects specific neurons —
// so the same label in the same position always fires the same neurons (Hebbian-friendly).
export function spatialPattern(detections, regionSize) {
    const cellCount  = GRID_W * GRID_H;
    const cellSize   = Math.floor(regionSize / cellCount);
    const indices    = new Set();

    for (const det of detections) {
        // Grid cells covered by this detection's bounding box
        const colStart = Math.floor(det.x * GRID_W);
        const rowStart = Math.floor(det.y * GRID_H);
        const colEnd   = Math.min(GRID_W - 1, Math.floor((det.x + det.w) * GRID_W));
        const rowEnd   = Math.min(GRID_H - 1, Math.floor((det.y + det.h) * GRID_H));

        // Label hash — same label always maps to same offset within a cell
        let labelHash = 5381;
        for (let i = 0; i < det.label.length; i++) {
            labelHash = ((labelHash << 5) + labelHash) ^ det.label.charCodeAt(i);
            labelHash = labelHash >>> 0;
        }

        for (let row = rowStart; row <= rowEnd; row++) {
            for (let col = colStart; col <= colEnd; col++) {
                const cellIdx  = row * GRID_W + col;
                const cellBase = cellIdx * cellSize;
                // Fire ~12 neurons per cell per detection
                for (let k = 0; k < 12; k++) {
                    const offset = (labelHash * (k + 1) * 2654435761) % cellSize >>> 0;
                    indices.add(cellBase + offset);
                }
            }
        }
    }
    return new Uint32Array([...indices]);
}

// Keep objectsToPattern as fallback for non-spatial use
export function objectsToPattern(objects, regionSize) {
    return spatialPattern(
        objects.map(o => ({ label: o, x: 0.4, y: 0.4, w: 0.2, h: 0.2 })),
        regionSize
    );
}

export class VisualCortex {
    constructor() {
        this.lastScene      = null;
        this.lastObjects    = [];
        this.lastDetections = [];
        this._running       = false;
        this._interval      = null;
        this._server        = new VisionServer();
        this._prevJpg       = null;
        this._inferring     = false;
    }

    start(brain, onScene, intervalMs = 800) {
        if (this._running) return;
        this._running = true;
        this._server.start();
        this._loop(brain, onScene, intervalMs);
    }

    stop() {
        this._running = false;
        if (this._interval) clearTimeout(this._interval);
        this._server.stop();
    }

    async _loop(brain, onScene, intervalMs) {
        while (this._running) {
            try {
                await captureFrame();
                const jpg = await readFile(FRAME_PATH);

                // Always push the raw frame to the viewer for smooth video
                this._server.push(jpg.toString('base64'), this.lastObjects, this.lastDetections);

                // Only run moondream if frame changed AND not already inferring
                if (!this._inferring && frameChanged(this._prevJpg, jpg)) {
                    this._prevJpg   = jpg;
                    this._inferring = true;
                    // Non-blocking — inference runs in background, loop keeps capturing
                    describeFrame(jpg).then(result => {
                        this._inferring     = false;
                        if (!result.scene && result.detections.length === 0) return;
                        this.lastScene      = result.scene;
                        this.lastObjects    = result.objects;
                        this.lastDetections = result.detections;
                        if (result.detections.length > 0) {
                            const pattern = spatialPattern(result.detections, brain.layout.visual.size);
                            brain.perceiveVisual(pattern);
                        }
                        onScene(result);
                    }).catch(() => { this._inferring = false; });
                }
            } catch {}
            await new Promise(r => { this._interval = setTimeout(r, intervalMs); });
        }
    }
}
