// vision-server.js — live camera viewer
// Serves a browser window showing what the visual cortex sees in real time.
// Draws bounding boxes over detected objects/faces.

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { exec } from 'node:child_process';

const PORT = 5005;

const HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Visual Cortex</title>
<style>
  body { margin:0; background:#000; display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; font-family:monospace; color:#0f0; }
  #wrap { position:relative; display:inline-block; }
  img   { max-width:100%; max-height:80vh; border:1px solid #0f0; display:block; }
  canvas{ position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; }
  #labels { margin-top:12px; font-size:14px; letter-spacing:1px; }
  #status { font-size:11px; opacity:0.5; margin-top:6px; }
</style>
</head>
<body>
<div id="wrap">
  <img id="frame" src="" alt="waiting...">
  <canvas id="overlay"></canvas>
</div>
<div id="labels">—</div>
<div id="status">connecting...</div>
<script>
  const img    = document.getElementById('frame');
  const canvas = document.getElementById('overlay');
  const ctx    = canvas.getContext('2d');
  const labels = document.getElementById('labels');
  const status = document.getElementById('status');

  const ws = new WebSocket('ws://localhost:${PORT}');
  ws.onopen  = () => status.textContent = 'live';
  ws.onclose = () => status.textContent = 'disconnected';
  ws.onmessage = (e) => {
    const d = JSON.parse(e.data);
    img.onload = () => {
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = '#0f0';
      ctx.lineWidth   = 2;
      ctx.font        = '13px monospace';
      ctx.fillStyle   = '#0f0';
      for (const det of (d.detections || [])) {
        const bx = det.x * canvas.width;
        const by = det.y * canvas.height;
        const bw = det.w * canvas.width;
        const bh = det.h * canvas.height;
        ctx.strokeRect(bx, by, bw, bh);
        const txt = det.label + (det.note ? ' — ' + det.note : '');
        ctx.fillText(txt, bx + 4, Math.max(14, by - 4));
      }
    };
    img.src = 'data:image/jpeg;base64,' + d.frame;
    labels.textContent = d.objects.join('  ·  ') || '—';
  };
</script>
</body>
</html>`;

export class VisionServer {
    constructor() {
        this._wss        = null;
        this._httpServer = null;
    }

    start() {
        this._httpServer = createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(HTML);
        });
        this._wss = new WebSocketServer({ server: this._httpServer });
        this._httpServer.listen(PORT, () => {
            exec(`open http://localhost:${PORT}`);
        });
    }

    push(frameBase64, objects, detections = []) {
        if (!this._wss) return;
        const msg = JSON.stringify({ frame: frameBase64, objects, detections });
        for (const client of this._wss.clients) {
            if (client.readyState === 1) client.send(msg);
        }
    }

    stop() {
        this._wss?.close();
        this._httpServer?.close();
    }
}
