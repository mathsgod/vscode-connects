import * as vscode from 'vscode';

export interface HostEntry {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  /** PEM-encoded private key content (for key-based auth). */
  privateKey?: string;
  /** Passphrase to decrypt the private key (if the key is encrypted). */
  passphrase?: string;
  /** If true, the SSH client will send keep-alive packets to prevent idle timeouts. */
  keepAlive?: boolean;
}

const HOSTS_KEY = 'vscodeConnect.hosts';
const SEEN_SYNC_HINT_KEY = 'vscodeConnect.hasSeenSyncHint';

/**
 * Hosts are stored in globalState and registered with setKeysForSync, so they
 * roam to any machine where the user is signed in with Settings Sync enabled.
 */
export class HostStore {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    context.globalState.setKeysForSync([HOSTS_KEY]);
  }

  getAll(): HostEntry[] {
    return this.context.globalState.get<HostEntry[]>(HOSTS_KEY, []);
  }

  /** Returns true if the user has never been shown the Settings Sync hint on this machine. */
  hasSeenSyncHint(): boolean {
    return !!this.context.globalState.get<boolean>(SEEN_SYNC_HINT_KEY);
  }

  /** Mark that we've shown the one-time Settings Sync hint (stored locally, not synced). */
  async markSeenSyncHint(): Promise<void> {
    await this.context.globalState.update(SEEN_SYNC_HINT_KEY, true);
  }

  get(id: string): HostEntry | undefined {
    return this.getAll().find((h) => h.id === id);
  }

  async upsert(entry: HostEntry): Promise<void> {
    const hosts = this.getAll();
    const idx = hosts.findIndex((h) => h.id === entry.id);
    if (idx >= 0) {
      hosts[idx] = entry;
    } else {
      hosts.push(entry);
    }
    hosts.sort((a, b) => a.name.localeCompare(b.name));
    await this.context.globalState.update(HOSTS_KEY, hosts);
    this._onDidChange.fire();

    // One-time hint: remind users they need Settings Sync enabled for cross-machine roaming.
    if (!this.hasSeenSyncHint()) {
      await this.markSeenSyncHint();
      // Fire-and-forget; do not await the message so we don't block the caller.
      void vscode.window
        .showInformationMessage(
          'SSH hosts are saved to your VS Code profile. To see them on other computers, sign in with GitHub (or Microsoft) and turn on Settings Sync (select "Extensions" or "All").',
          'Open Settings Sync'
        )
        .then((choice) => {
          if (choice === 'Open Settings Sync') {
            void vscode.commands.executeCommand('workbench.userDataSync.actions.turnOn');
          }
        });
    }
  }

  async delete(id: string): Promise<void> {
    const hosts = this.getAll().filter((h) => h.id !== id);
    await this.context.globalState.update(HOSTS_KEY, hosts);
    this._onDidChange.fire();
  }
}
