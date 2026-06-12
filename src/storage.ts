import * as vscode from 'vscode';

export interface HostEntry {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password?: string;
}

const HOSTS_KEY = 'vscodeConnect.hosts';

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
  }

  async delete(id: string): Promise<void> {
    const hosts = this.getAll().filter((h) => h.id !== id);
    await this.context.globalState.update(HOSTS_KEY, hosts);
    this._onDidChange.fire();
  }
}
