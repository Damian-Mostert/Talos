import readline from 'readline';
import chalk from 'chalk';

export class UI {
    constructor(onInput) {
        this.onInput  = onInput;

        this.rl = readline.createInterface({
            input:     process.stdin,
            output:    process.stdout,
            terminal:  true,
        });

        this.rl.on('line', (line) => {
            const text = line.trim();
            if (!text) { this._prompt(); return; }
            if (text === '/quit' || text === '/exit') {
                this._write(chalk.white.dim('[system] Shutting down...'));
                process.exit(0);
            }
            this.onInput(text);
        });

        this.rl.on('close', () => {});
    }

    _prompt() {
        this.rl.setPrompt(chalk.yellow('You > '));
        this.rl.prompt(true);
    }

    _write(line) {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(line + '\n');
        this._prompt();
    }

    // Inline progress bar — overwrites same line each epoch
    bootProgress(epoch, total) {
        const pct    = Math.round((epoch / total) * 100);
        const filled = Math.round(pct / 5);
        const bar    = chalk.green('█'.repeat(filled)) + chalk.white.dim('░'.repeat(20 - filled));
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(chalk.white.dim(`  Booting [${bar}] ${pct}%`));
    }

    // Clear green banner when fully ready
    ready() {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write('\n' + chalk.green.bold('  ✓ Ready — say something\n\n'));
        this._prompt();
    }

    log(msg) {
        this._write(chalk.white.dim(`[system] ${msg}`));
    }

    thinking(msg) {
        this._write(chalk.gray(`  ... ${msg}`));
    }

    brainThinks(msg) {
        this._write(chalk.blue(`  [~] ${msg}`));
    }

    brainSpeaks(msg) {
        this._write(chalk.cyan(`\nBrain > ${msg}\n`));
    }

    start() {
        console.clear();
        console.log(chalk.cyan.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        console.log(chalk.cyan.bold('  Talos — Online'));
        console.log(chalk.cyan.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        console.log(chalk.white.dim('  Brain speaks in cyan. You type below.'));
        console.log(chalk.white.dim('  /quit to exit\n'));
        this._prompt();
    }
}
