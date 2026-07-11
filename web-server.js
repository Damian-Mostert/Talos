import http from 'http';
import fs   from 'fs';
import path from 'path';
import { WebSocketServer } from 'ws';
import { fileURLToPath }   from 'url';
import { NeuronMap }       from './neuron-map.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML      = fs.readFileSync(path.join(__dirname, 'web-ui.html'));

export class WebUI {
    constructor(onInput) {
        this.onInput    = onInput;
        this._ws        = null;
        this._mood      = 'calm';
        this._neural    = { valence: 0, arousal: 0, drive: 0, norepinephrine: 0 };
        this._neuronMap = null;
        this._mapTimer  = null;

        const server = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(HTML);
        });

        this._wss = new WebSocketServer({ server });
        this._wss.on('connection', (ws) => {
            this._ws = ws;
            ws.on('message', (raw) => {
                try { const { text } = JSON.parse(raw); if (text) this.onInput(text); } catch {}
            });
            ws.on('close', () => { if (this._ws === ws) this._ws = null; });
        });

        this._server = server;
    }

    attachBrain(brain) {
        this._neuronMap = new NeuronMap(brain);
        this._mapTimer  = setInterval(() => {
            if (!this._ws || this._ws.readyState !== 1) return;
            setImmediate(() => {
                try {
                    const snap = this._neuronMap.snapshot();
                    this._ws.send(JSON.stringify(snap));
                } catch {}
            });
        }, 1000);
    }

    _send(obj) { if (this._ws?.readyState === 1) this._ws.send(JSON.stringify(obj)); }

    start(port = 3000) {
        this._server.listen(port, () => console.log(`Web UI → http://localhost:${port}`));
    }

    stop() { clearInterval(this._mapTimer); }

    _state()          { return { mood: this._mood, neural: this._neural }; }

    log(msg)          { this._send({ type: 'system', text: msg, ...this._state() }); }
    thinking(msg)     { this._send({ type: 'think',  text: msg, ...this._state() }); }
    brainThinks(msg)  { this._send({ type: 'think',  text: msg, ...this._state() }); }
    brainSpeaks(msg)  { this._send({ type: 'speaks', text: msg, ...this._state() }); }
    ready()           { this._send({ type: 'ready',             ...this._state() }); }
    bootProgress()    {}

    updateState(mood, neural) {
        this._mood   = mood;
        this._neural = neural;
        this._send({ type: 'state', ...this._state() });
    }
}
