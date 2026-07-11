import { Brain }         from './brain.js';
import { boot, warmup } from './boot.js';
import { Consciousness } from './consciousness.js';
import { UI }            from './interface.js';
import { WebUI }         from './web-server.js';
import { saveSnapshot, loadSnapshot } from './snapshot.js';

const useCamera = process.argv.includes('--use-camera');
const useWebUI  = process.argv.includes('--use-web-ui');

const brain = new Brain();
brain.start(20);

let consciousness;

const ui = useWebUI ? new WebUI((text) => {
    if (consciousness) consciousness.receive(text);
    else ui.log('Still booting, hold on...');
}) : new UI((text) => {
    if (consciousness) consciousness.receive(text);
    else ui.log('Still booting, hold on...');
});

useWebUI ? ui.start(3000) : ui.start();

function launch() {
    consciousness = new Consciousness(brain, ui);
    if (useCamera) consciousness.enableCamera();
    if (useWebUI) ui.attachBrain(brain);
    ui.ready();

    process.on('SIGINT', async () => {
        ui.log('Shutting down...');
        consciousness.stop();
        brain.stop();
        process.exit(0);
    });

    consciousness.start();
}

ui.log('Neural tissue allocated.');

if (loadSnapshot(brain.engine)) {
    ui.log('Snapshot loaded.');
    warmup(brain).then(launch);
} else {
    boot(brain, (msg) => ui.log(msg), (ep, total) => ui.bootProgress(ep, total)).then(() => {
        saveSnapshot(brain.engine);
        launch();
    });
}
