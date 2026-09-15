import { Notice, Plugin, PluginSettingTab, App, Setting } from "obsidian";
import { DEFAULT_SETTINGS, PluginData, defaultData, sanitizeVaultId } from "./settings";
import { SyncEngine, SyncResult } from "./syncEngine";
import { checkHealth } from "./api";

export default class VaultSyncPlugin extends Plugin {
  data: PluginData = defaultData();
  private engine!: SyncEngine;
  private statusBarItem!: HTMLElement;
  private syncing = false;

  async onload(): Promise<void> {
    await this.loadPluginData();

    if (!this.data.settings.vaultId) {
      this.data.settings.vaultId = sanitizeVaultId(this.app.vault.getName());
      await this.savePluginData();
    }

    this.engine = new SyncEngine(
      this.app,
      () => this.data.settings,
      this.data.syncState,
      () => this.savePluginData()
    );

    this.statusBarItem = this.addStatusBarItem();
    this.setStatus("idle");

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => this.syncNow(),
    });

    this.addSettingTab(new VaultSyncSettingTab(this.app, this));

    // obsidian://vault-sync-lite-sync?vault=<name> — lets a Shortcut, widget or
    // home-screen icon kick off a sync without opening the plugin's settings.
    this.registerObsidianProtocolHandler("vault-sync-lite-sync", () => {
      void this.syncNow();
    });

    this.registerInterval(
      window.setInterval(() => {
        if (this.data.settings.autoSync) void this.syncNow();
      }, Math.max(10, this.data.settings.intervalSec) * 1000)
    );
  }

  async syncNow(): Promise<void> {
    if (this.syncing) {
      new Notice("Sync already running");
      return;
    }
    this.syncing = true;
    this.setStatus("syncing");
    try {
      const result = await this.engine.run();
      this.setStatus("synced", result);
      this.reportResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus("error", undefined, message);
      new Notice(`Vault sync failed: ${message}`);
    } finally {
      this.syncing = false;
    }
  }

  private reportResult(result: SyncResult): void {
    if (result.errors.length > 0) {
      new Notice(`Vault sync finished with ${result.errors.length} error(s). See console for details.`);
      for (const e of result.errors) console.error("[vault-sync-lite]", e);
    }
    const total = result.uploaded + result.downloaded + result.deletedLocal + result.deletedRemote;
    if (total > 0 || result.conflicts > 0) {
      new Notice(
        `Synced: ${result.uploaded} up, ${result.downloaded} down, ${result.conflicts} conflict(s)`
      );
    }
  }

  private setStatus(state: "idle" | "syncing" | "synced" | "error", result?: SyncResult, error?: string): void {
    const icons: Record<string, string> = { idle: "⚪", syncing: "⏳", synced: "✅", error: "⚠️" };
    if (state === "synced") {
      const time = new Date().toLocaleTimeString();
      this.statusBarItem.setText(`${icons.synced} Synced ${time}`);
    } else if (state === "error") {
      this.statusBarItem.setText(`${icons.error} Sync error`);
    } else {
      this.statusBarItem.setText(`${icons[state]} Sync ${state}`);
    }
  }

  async loadPluginData(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<PluginData> | null;
    this.data = {
      settings: { ...DEFAULT_SETTINGS, ...(loaded?.settings ?? {}) },
      syncState: loaded?.syncState ?? {},
    };
  }

  async savePluginData(): Promise<void> {
    await this.saveData(this.data);
  }
}

class VaultSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: VaultSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Vault Sync Lite" });

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("Base URL of your self-hosted sync server, e.g. http://100.x.x.x:8787 (Tailscale) or https://sync.example.com")
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:8787")
          .setValue(this.plugin.data.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.data.settings.serverUrl = value.trim();
            await this.plugin.savePluginData();
          })
      );

    new Setting(containerEl)
      .setName("Token")
      .setDesc("Shared secret, must match SYNC_TOKEN on the server")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setValue(this.plugin.data.settings.token)
          .onChange(async (value) => {
            this.plugin.data.settings.token = value.trim();
            await this.plugin.savePluginData();
          });
      });

    new Setting(containerEl)
      .setName("Vault ID")
      .setDesc("Namespaces this vault on a server shared by several vaults. Defaults to the vault's name; only change it if two vaults share a name.")
      .addText((text) =>
        text
          .setValue(this.plugin.data.settings.vaultId)
          .onChange(async (value) => {
            this.plugin.data.settings.vaultId = value.trim();
            await this.plugin.savePluginData();
          })
      );

    new Setting(containerEl)
      .setName("Auto sync")
      .setDesc("Sync automatically on the interval below")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.data.settings.autoSync).onChange(async (value) => {
          this.plugin.data.settings.autoSync = value;
          await this.plugin.savePluginData();
        })
      );

    new Setting(containerEl)
      .setName("Sync interval (seconds)")
      .addText((text) =>
        text
          .setValue(String(this.plugin.data.settings.intervalSec))
          .onChange(async (value) => {
            const n = Number(value);
            if (Number.isFinite(n) && n >= 10) {
              this.plugin.data.settings.intervalSec = n;
              await this.plugin.savePluginData();
            }
          })
      );

    new Setting(containerEl)
      .setName("Ignore patterns")
      .setDesc("One per line. '*' matches anything, including '/'.")
      .addTextArea((text) => {
        text.inputEl.rows = 4;
        text
          .setValue(this.plugin.data.settings.ignorePatterns.join("\n"))
          .onChange(async (value) => {
            this.plugin.data.settings.ignorePatterns = value
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean);
            await this.plugin.savePluginData();
          });
      });

    new Setting(containerEl)
      .setName("Test connection")
      .addButton((button) =>
        button.setButtonText("Test").onClick(async () => {
          const ok = await checkHealth(this.plugin.data.settings);
          new Notice(ok ? "Server reachable" : "Could not reach server");
        })
      );

    new Setting(containerEl)
      .setName("Sync now")
      .addButton((button) =>
        button
          .setButtonText("Sync")
          .setCta()
          .onClick(() => this.plugin.syncNow())
      );

    const syncUri = `obsidian://vault-sync-lite-sync?vault=${encodeURIComponent(this.app.vault.getName())}`;
    new Setting(containerEl)
      .setName("Sync URI")
      .setDesc(`Opening this link triggers a sync in this vault — useful from iOS Shortcuts, a widget or a home-screen icon. ${syncUri}`)
      .addButton((button) =>
        button.setButtonText("Copy").onClick(async () => {
          await navigator.clipboard.writeText(syncUri);
          new Notice("Sync URI copied");
        })
      );
  }
}
