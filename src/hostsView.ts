import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { HostEntry, HostStore } from './storage';

/**
 * The single VSCode Connect panel view: a webview with a live search bar,
 * Add / Edit / Delete buttons, and the host list itself.
 * Single click selects a host, double click connects.
 */
export class HostsViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'vscodeConnect.hosts';

  private view?: vscode.WebviewView;
  private filter = '';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: HostStore
  ) {
    store.onDidChange(() => this.refresh());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.renderHtml();

    view.webview.onDidReceiveMessage((msg) => {
      switch (msg.type) {
        case 'ready':
          this.refresh();
          break;
        case 'search':
          this.setFilter(String(msg.value ?? ''), false);
          break;
        case 'add':
          vscode.commands.executeCommand('vscodeConnect.addHost');
          break;
        case 'edit':
        case 'delete':
        case 'connect':
          if (!msg.id) {
            vscode.window.showWarningMessage('Select an SSH host in the list first.');
            break;
          }
          vscode.commands.executeCommand(
            msg.type === 'edit'
              ? 'vscodeConnect.editHost'
              : msg.type === 'delete'
                ? 'vscodeConnect.deleteHost'
                : 'vscodeConnect.connect',
            String(msg.id)
          );
          break;
      }
    });
  }

  getFilter(): string {
    return this.filter;
  }

  /** Updates the filter; optionally syncs the search input in the webview. */
  setFilter(value: string, updateInput = true): void {
    this.filter = value;
    vscode.commands.executeCommand(
      'setContext',
      'vscodeConnect.filtered',
      value.trim().length > 0
    );
    if (updateInput) {
      this.view?.webview.postMessage({ type: 'setSearch', value });
    }
    this.refresh();
  }

  private visibleHosts(): HostEntry[] {
    const needle = this.filter.trim().toLowerCase();
    let hosts = this.store.getAll();
    if (needle) {
      hosts = hosts.filter((h) =>
        [h.name, h.host, h.username, `${h.username}@${h.host}`]
          .join(' ')
          .toLowerCase()
          .includes(needle)
      );
    }
    return hosts;
  }

  private refresh(): void {
    this.view?.webview.postMessage({
      type: 'hosts',
      hosts: this.visibleHosts().map((h) => ({
        id: h.id,
        name: h.name,
        detail: `${h.username}@${h.host}:${h.port}`,
      })),
    });
  }

  private renderHtml(): string {
    const htmlPath = path.join(this.extensionUri.fsPath, 'media', 'hostsView.html');
    const template = fs.readFileSync(htmlPath, 'utf8');
    const esc = this.filter
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    return template.replace(/\{\{filter\}\}/g, esc);
  }
}
