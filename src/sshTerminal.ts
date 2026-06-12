import { Client, ClientChannel } from 'ssh2';
import * as vscode from 'vscode';
import { HostEntry } from './storage';

/**
 * Opens an interactive SSH session as a terminal tab in the editor area.
 * Uses the ssh2 library so the stored password can be supplied automatically
 * (a plain `ssh` process would prompt for it interactively).
 */
export function openSshTerminal(entry: HostEntry): void {
  const pty = new SshPseudoterminal(entry);
  const terminal = vscode.window.createTerminal({
    name: `SSH: ${entry.name}`,
    pty,
    location: vscode.TerminalLocation.Editor,
    iconPath: new vscode.ThemeIcon('remote'),
  });
  terminal.show();
}

class SshPseudoterminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;

  private client: Client | undefined;
  private stream: ClientChannel | undefined;
  private dimensions: vscode.TerminalDimensions = { columns: 80, rows: 24 };

  constructor(private readonly entry: HostEntry) {}

  open(initialDimensions?: vscode.TerminalDimensions): void {
    if (initialDimensions) {
      this.dimensions = initialDimensions;
    }
    const { entry } = this;
    this.print(`Connecting to ${entry.username}@${entry.host}:${entry.port} ...\r\n`);

    const client = new Client();
    this.client = client;

    client.on('ready', () => {
      client.shell(
        {
          term: 'xterm-256color',
          cols: this.dimensions.columns,
          rows: this.dimensions.rows,
        },
        (err, stream) => {
          if (err) {
            this.fail(`Failed to open shell: ${err.message}`);
            return;
          }
          this.stream = stream;
          stream.on('data', (data: Buffer) => this.writeEmitter.fire(data.toString('utf8')));
          stream.stderr.on('data', (data: Buffer) => this.writeEmitter.fire(data.toString('utf8')));
          stream.on('close', () => {
            client.end();
            this.print('\r\n\x1b[90mConnection closed.\x1b[0m\r\n');
            this.closeEmitter.fire(0);
          });
        }
      );
    });

    client.on('error', (err) => {
      this.fail(`Connection error: ${err.message}`);
    });

    client.on(
      'keyboard-interactive',
      (_name, _instructions, _lang, prompts, finish) => {
        // Servers that use keyboard-interactive auth instead of plain
        // password auth still get the stored password.
        finish(prompts.map(() => entry.password ?? ''));
      }
    );

    try {
      client.connect({
        host: entry.host,
        port: entry.port,
        username: entry.username,
        password: entry.password || undefined,
        tryKeyboard: true,
        agent: process.env.SSH_AUTH_SOCK,
        readyTimeout: 20000,
        keepaliveInterval: 15000,
      });
    } catch (err) {
      this.fail(`Connection failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  handleInput(data: string): void {
    this.stream?.write(data);
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.dimensions = dimensions;
    this.stream?.setWindow(dimensions.rows, dimensions.columns, 0, 0);
  }

  close(): void {
    this.stream?.end();
    this.client?.end();
  }

  private print(text: string): void {
    this.writeEmitter.fire(text);
  }

  private fail(message: string): void {
    this.print(`\r\n\x1b[31m${message}\x1b[0m\r\n`);
    this.print('\x1b[90mPress any key to close this terminal.\x1b[0m\r\n');
    // Replace input handling so the next keypress closes the tab.
    this.handleInput = () => this.closeEmitter.fire(1);
    vscode.window.showErrorMessage(`SSH ${this.entry.name}: ${message}`);
  }
}
