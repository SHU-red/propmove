const {
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
  Notice
} = require("obsidian");

const DEFAULT_SETTINGS = {
  properties: [],
  autoAppendSuffix: true,
  ignoreFolders: []
};

module.exports = class PropMove extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.migrateSettings();
    this.pending = new Map();
    this.movingPaths = new Set();

    this.addSettingTab(new PropMoveSettingTab(this.app, this));

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        this.queueProcess(file);
      })
    );

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        this.queueProcess(file);
      })
    );
  }

  onunload() {
    for (const timeoutId of this.pending.values()) {
      clearTimeout(timeoutId);
    }
    this.pending.clear();
    this.movingPaths.clear();
  }

  queueProcess(file) {
    if (this.app.metadataCache.isUserIgnored(file.path)) {
      return;
    }
    if (!(file instanceof TFile) || file.extension !== "md") {
      return;
    }

    if (this.movingPaths.has(file.path)) {
      return;
    }

    const existingTimeout = this.pending.get(file.path);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    const timeoutId = setTimeout(() => {
      this.pending.delete(file.path);
      this.processFile(file.path);
    }, 150);

    this.pending.set(file.path, timeoutId);
  }

  async processFile(filePath) {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile) || file.extension !== "md") {
      return;
    }

    // Check if file is in an ignored folder
    if (this.isFileInIgnoredFolder(filePath)) {
      return;
    }

    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = cache ? cache.frontmatter : null;
    if (!frontmatter) {
      return;
    }

    const groups = Array.isArray(this.settings.properties)
      ? this.settings.properties
      : [];

    let targetFolder = "";

    for (const group of groups) {
      const propName = String(group.name || "").trim();
      if (!propName) {
        continue;
      }

      const rawValue = frontmatter[propName];
      if (rawValue === null || rawValue === undefined) {
        continue;
      }

      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      const normalizedValues = values
        .map((value) => String(value).trim())
        .filter((value) => value.length > 0);

      if (normalizedValues.length === 0) {
        continue;
      }

      const mappings = Array.isArray(group.mappings) ? group.mappings : [];
      const mapping = mappings.find((item) => {
        const mappingValue = String(item.value || "").trim();
        return (
          mappingValue.length > 0 && normalizedValues.includes(mappingValue)
        );
      });

      if (!mapping) {
        continue;
      }

      targetFolder = String(mapping.folder || "").trim();
      if (targetFolder) {
        break;
      }
    }

    if (!targetFolder) {
      return;
    }

    const normalizedFolder = normalizePath(targetFolder);
    const targetPath = normalizePath(`${normalizedFolder}/${file.name}`);

    if (file.path === targetPath) {
      return;
    }

    const existingTarget = this.app.vault.getAbstractFileByPath(targetPath);
    if (existingTarget) {
      if (this.settings.autoAppendSuffix) {
        // Generate unique filename with suffix
        const finalPath = await this.generateUniqueFileName(
          normalizedFolder,
          file.name
        );
        
        try {
          this.movingPaths.add(file.path);
          await this.ensureFolder(normalizedFolder);
          await this.app.vault.rename(file, finalPath);
        } catch (error) {
          new Notice(`PropMove: failed to move ${file.name}`);
          console.error("PropMove move failed", error);
        } finally {
          this.movingPaths.delete(file.path);
        }
      } else {
        new Notice(`PropMove: target exists at ${targetPath}`);
        return;
      }
    } else {
      try {
        this.movingPaths.add(file.path);
        await this.ensureFolder(normalizedFolder);
        await this.app.vault.rename(file, targetPath);
      } catch (error) {
        new Notice(`PropMove: failed to move ${file.name}`);
        console.error("PropMove move failed", error);
      } finally {
        this.movingPaths.delete(file.path);
      }
    }
  }

  isFileInIgnoredFolder(filePath) {
    const ignoreFolders = Array.isArray(this.settings.ignoreFolders)
      ? this.settings.ignoreFolders
      : [];

    for (const ignoreFolder of ignoreFolders) {
      const normalizedIgnoreFolder = normalizePath(String(ignoreFolder || "").trim());
      if (!normalizedIgnoreFolder) {
        continue;
      }

      const normalizedFilePath = normalizePath(filePath);
      
      // Check if the file path starts with the ignore folder
      if (normalizedFilePath.startsWith(normalizedIgnoreFolder + "/") ||
          normalizedFilePath === normalizedIgnoreFolder) {
        return true;
      }
    }

    return false;
  }

  async generateUniqueFileName(folderPath, fileName) {
    const extension = fileName.split(".").pop();
    const baseName = fileName.slice(0, -(extension.length + 1));
    let counter = 1;
    
    while (true) {
      const newFileName = `${baseName} ${counter}.${extension}`;
      const fullPath = normalizePath(`${folderPath}/${newFileName}`);
      const existing = this.app.vault.getAbstractFileByPath(fullPath);
      
      if (!existing) {
        return fullPath;
      }
      
      counter++;
    }
  }

  async ensureFolder(folderPath) {
    const existing = this.app.vault.getAbstractFileByPath(folderPath);
    if (existing) {
      return;
    }

    await this.app.vault.createFolder(folderPath);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  migrateSettings() {
    const properties = Array.isArray(this.settings.properties)
      ? this.settings.properties
      : [];

    const legacyPropertyName = String(this.settings.propertyName || "").trim();
    const legacyMappings = Array.isArray(this.settings.mappings)
      ? this.settings.mappings
      : [];

    if (properties.length === 0 && legacyPropertyName) {
      properties.push({ name: legacyPropertyName, mappings: legacyMappings });
    }

    this.settings.properties = properties.map((group) => ({
      name: String(group.name || "").trim(),
      mappings: Array.isArray(group.mappings) ? group.mappings : []
    }));

    // Ensure ignoreFolders is properly initialized
    if (!Array.isArray(this.settings.ignoreFolders)) {
      this.settings.ignoreFolders = [];
    }
  }
};

class PropMoveSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "PropMove" });

    // Auto-append suffix setting
    new Setting(containerEl)
      .setName("Automatically append a unique suffix if filename exists")
      .setDesc(
        "When enabled, files are moved with a numeric suffix (e.g. 'note 1.md') if the target filename already exists. When disabled, the move is skipped and a notice is shown."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoAppendSuffix)
          .onChange(async (value) => {
            this.plugin.settings.autoAppendSuffix = value;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("hr");
    containerEl.createEl("h3", { text: "Ignore Folders" });
    
    containerEl.createEl("p", {
      text: "Add folders to exclude files from being moved. Files in these folders will be ignored even if they match a property mapping (e.g., template folders)."
    });

    const ignoreFolders = Array.isArray(this.plugin.settings.ignoreFolders)
      ? this.plugin.settings.ignoreFolders
      : [];

    if (ignoreFolders.length === 0) {
      containerEl.createEl("p", {
        text: "No folders are currently ignored.",
        cls: "setting-item-description"
      });
    }

    ignoreFolders.forEach((folderPath, index) => {
      const setting = new Setting(containerEl).setName(`Ignored Folder ${index + 1}`);

      setting.addText((text) =>
        text
          .setPlaceholder("templates")
          .setValue(folderPath || "")
          .onChange(async (value) => {
            ignoreFolders[index] = value;
            this.plugin.settings.ignoreFolders = ignoreFolders;
            await this.plugin.saveSettings();
          })
      );

      setting.addExtraButton((button) => {
        button
          .setIcon("trash")
          .setTooltip("Remove ignored folder")
          .onClick(async () => {
            ignoreFolders.splice(index, 1);
            this.plugin.settings.ignoreFolders = ignoreFolders;
            await this.plugin.saveSettings();
            this.display();
          });
      });
    });

    new Setting(containerEl).addButton((button) => {
      button
        .setButtonText("Add ignored folder")
        .setCta()
        .onClick(async () => {
          ignoreFolders.push("");
          this.plugin.settings.ignoreFolders = ignoreFolders;
          await this.plugin.saveSettings();
          this.display();
        });
    });

    containerEl.createEl("hr");
    containerEl.createEl("h3", { text: "Properties" });

    if (this.plugin.settings.properties.length === 0) {
      containerEl.createEl("p", {
        text: "Add one or more properties with value-to-folder mappings."
      });
    }

    this.plugin.settings.properties.forEach((group, groupIndex) => {
      if (groupIndex > 0) {
        containerEl.createEl("hr");
      }

      containerEl.createEl("h4", { text: `Property ${groupIndex + 1}` });

      const groupSetting = new Setting(containerEl)
        .setName("Property name")
        .setDesc("Frontmatter property to watch.");

      groupSetting.addText((text) =>
        text
          .setPlaceholder("type")
          .setValue(group.name || "")
          .onChange(async (value) => {
            group.name = value;
            await this.plugin.saveSettings();
          })
      );

      groupSetting.addExtraButton((button) => {
        button
          .setIcon("trash")
          .setTooltip("Remove property")
          .onClick(async () => {
            this.plugin.settings.properties.splice(groupIndex, 1);
            await this.plugin.saveSettings();
            this.display();
          });
      });

      const mappings = Array.isArray(group.mappings) ? group.mappings : [];
      if (mappings.length === 0) {
        containerEl.createEl("p", {
          text: "Add one or more mappings for this property."
        });
      }

      mappings.forEach((mapping, index) => {
        const setting = new Setting(containerEl).setName(`Mapping ${index + 1}`);

        setting.addText((text) =>
          text
            .setPlaceholder("task")
            .setValue(mapping.value || "")
            .onChange(async (value) => {
              mapping.value = value;
              await this.plugin.saveSettings();
            })
        );

        setting.addText((text) =>
          text
            .setPlaceholder("Projects/Tasks")
            .setValue(mapping.folder || "")
            .onChange(async (value) => {
              mapping.folder = value;
              await this.plugin.saveSettings();
            })
        );

        setting.addExtraButton((button) => {
          button
            .setIcon("trash")
            .setTooltip("Remove mapping")
            .onClick(async () => {
              mappings.splice(index, 1);
              group.mappings = mappings;
              await this.plugin.saveSettings();
              this.display();
            });
        });
      });

      new Setting(containerEl).addButton((button) => {
        button
          .setButtonText("Add mapping")
          .setCta()
          .onClick(async () => {
            mappings.push({ value: "", folder: "" });
            group.mappings = mappings;
            await this.plugin.saveSettings();
            this.display();
          });
      });
    });

    new Setting(containerEl).addButton((button) => {
      button
        .setButtonText("Add property")
        .setCta()
        .onClick(async () => {
          this.plugin.settings.properties.push({ name: "", mappings: [] });
          await this.plugin.saveSettings();
          this.display();
        });
    });
  }
}
