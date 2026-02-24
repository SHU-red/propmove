const {
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  normalizePath,
  Notice,
  Command
} = require("obsidian");

const DEFAULT_SETTINGS = {
  properties: [],
  autoAppendSuffix: true,
  ignoreFolders: [],
  moveOnCreate: true,
  moveOnMetadataChange: true,
  moveOnStartup: true,
  manualTriggerOnly: false,
  debugLogging: false,
  processExistingFiles: false,
  processingDelay: 150,
  maxFilesPerBatch: 0,
  caseInsensitiveMatching: false
};

/**
 * FileProcessor handles the logic of moving files based on property rules
 */
class FileProcessor {
  constructor(app, settings, logger) {
    this.app = app;
    this.settings = settings;
    this.logger = logger;
  }

  /**
   * Determines the target folder for a file based on property mappings
   * @returns {string|null} The target folder path or null if no match found
   */
  findTargetFolder(frontmatter) {
    const groups = Array.isArray(this.settings.properties) ? this.settings.properties : [];

    for (const group of groups) {
      const propName = String(group.name || "").trim();
      if (!propName) continue;

      const rawValue = frontmatter[propName];
      if (rawValue === null || rawValue === undefined) continue;

      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      const normalizedValues = values
        .map((value) => String(value).trim())
        .filter((value) => value.length > 0);

      if (normalizedValues.length === 0) continue;

      const mappings = Array.isArray(group.mappings) ? group.mappings : [];
      const mapping = this.findMatchingMapping(mappings, normalizedValues);

      if (mapping) {
        const targetFolder = String(mapping.folder || "").trim();
        if (targetFolder) return targetFolder;
      }
    }

    return null;
  }

  /**
   * Find matching mapping considering case sensitivity setting
   */
  findMatchingMapping(mappings, normalizedValues) {
    for (const item of mappings) {
      const mappingValue = String(item.value || "").trim();
      if (mappingValue.length === 0) continue;

      const isMatch = this.settings.caseInsensitiveMatching
        ? normalizedValues.some(v => v.toLowerCase() === mappingValue.toLowerCase())
        : normalizedValues.includes(mappingValue);

      if (isMatch) return item;
    }
    return null;
  }

  /**
   * Interpolate variables in folder path template
   * Replaces {propertyName} with values from frontmatter
   * @param {string} path - Path template with {variable} placeholders
   * @param {Object} frontmatter - Frontmatter object with properties
   * @returns {string} Interpolated path
   */
  interpolateVariables(path, frontmatter) {
    if (!path || typeof path !== 'string') return path;

    return path.replace(/{(\w+)}/g, (match, propName) => {
      const value = frontmatter[propName];
      if (value === null || value === undefined) {
        this.logger.debug(`[INTERPOLATE] Property '${propName}' not found in frontmatter, keeping literal: ${match}`);
        return match; // Keep the placeholder if property not found
      }

      const normalized = String(value).trim();
      if (normalized.length === 0) {
        this.logger.debug(`[INTERPOLATE] Property '${propName}' is empty, keeping literal: ${match}`);
        return match;
      }

      this.logger.debug(`[INTERPOLATE] Replaced {${propName}} with '${normalized}'`);
      return normalized;
    });
  }

  /**
   * Preview what would happen if a file is processed
   * @returns {Object|null} Move preview or null if no move needed
   */
  previewMove(file, frontmatter) {
    if (!frontmatter) {
      this.logger.debug(`[PREVIEW] No frontmatter for ${file.path}`);
      return null;
    }

    const targetFolder = this.findTargetFolder(frontmatter);
    if (!targetFolder) {
      this.logger.debug(`[PREVIEW] No matching rule for ${file.path}`);
      return null;
    }

    // Interpolate variables in the target folder
    const interpolatedFolder = this.interpolateVariables(targetFolder, frontmatter);
    const normalizedFolder = normalizePath(interpolatedFolder);
    const targetPath = normalizePath(`${normalizedFolder}/${file.name}`);

    if (file.path === targetPath) {
      this.logger.debug(`[PREVIEW] File already in correct location: ${file.path}`);
      return { action: "skip", reason: "already_in_target" };
    }

    const existingTarget = this.app.vault.getAbstractFileByPath(targetPath);
    if (existingTarget) {
      if (this.settings.autoAppendSuffix) {
        return {
          action: "move_with_suffix",
          currentPath: file.path,
          targetPath: targetPath,
          targetFolder: normalizedFolder,
          fileName: file.name,
          template: targetFolder,
          interpolated: interpolatedFolder
        };
      } else {
        return {
          action: "skip",
          reason: "target_exists",
          targetPath: targetPath,
          template: targetFolder,
          interpolated: interpolatedFolder
        };
      }
    }

    return {
      action: "move",
      currentPath: file.path,
      targetPath: targetPath,
      targetFolder: normalizedFolder,
      template: targetFolder,
      interpolated: interpolatedFolder
    };
  }

  /**
   * Execute a file move operation with comprehensive error handling
   */
  async moveFile(file, targetFolder) {
    // Interpolate variables from file's frontmatter
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = cache ? cache.frontmatter : null;
    const interpolatedFolder = frontmatter 
      ? this.interpolateVariables(targetFolder, frontmatter)
      : targetFolder;

    const normalizedFolder = normalizePath(interpolatedFolder);
    const targetPath = normalizePath(`${normalizedFolder}/${file.name}`);

    if (file.path === targetPath) {
      this.logger.debug(`File already at target: ${file.path}`);
      return { success: true, action: "none", message: "File already in target location" };
    }

    try {
      await this.ensureFolder(normalizedFolder);

      const existingTarget = this.app.vault.getAbstractFileByPath(targetPath);
      if (existingTarget) {
        if (this.settings.autoAppendSuffix) {
          const finalPath = await this.generateUniqueFileName(normalizedFolder, file.name);
          await this.app.vault.rename(file, finalPath);
          this.logger.debug(`Moved ${file.path} to ${finalPath} (suffix added)`);
          return { success: true, action: "move_with_suffix", path: finalPath };
        } else {
          const msg = `Target file exists at ${targetPath}`;
          this.logger.debug(msg);
          return { success: false, action: "skip", message: msg };
        }
      } else {
        await this.app.vault.rename(file, targetPath);
        this.logger.debug(`Moved ${file.path} to ${targetPath}`);
        return { success: true, action: "move", path: targetPath };
      }
    } catch (error) {
      this.logger.error(`Failed to move ${file.name}: ${error.message}`);
      return { success: false, action: "error", message: error.message };
    }
  }

  /**
   * Check if a file is in an ignored folder
   */
  isFileInIgnoredFolder(filePath) {
    const ignoreFolders = Array.isArray(this.settings.ignoreFolders)
      ? this.settings.ignoreFolders
      : [];

    const normalizedFilePath = normalizePath(filePath);

    for (const ignoreFolder of ignoreFolders) {
      const normalizedIgnoreFolder = normalizePath(String(ignoreFolder || "").trim());
      if (!normalizedIgnoreFolder) continue;

      if (
        normalizedFilePath.startsWith(normalizedIgnoreFolder + "/") ||
        normalizedFilePath === normalizedIgnoreFolder
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Generate a unique filename by appending numeric suffixes
   */
  async generateUniqueFileName(folderPath, fileName) {
    const extension = fileName.split(".").pop();
    const baseName = fileName.slice(0, -(extension.length + 1));
    let counter = 1;
    const maxAttempts = 10000;

    while (counter <= maxAttempts) {
      const newFileName = `${baseName} ${counter}.${extension}`;
      const fullPath = normalizePath(`${folderPath}/${newFileName}`);
      const existing = this.app.vault.getAbstractFileByPath(fullPath);

      if (!existing) {
        this.logger.debug(`Generated unique filename: ${fullPath}`);
        return fullPath;
      }

      counter++;
    }

    throw new Error(`Could not generate unique filename after ${maxAttempts} attempts for ${fileName}`);
  }

  /**
   * Ensure a folder exists, creating it if necessary
   */
  async ensureFolder(folderPath) {
    const existing = this.app.vault.getAbstractFileByPath(folderPath);
    if (existing instanceof TFolder) {
      return;
    }

    try {
      await this.app.vault.createFolder(folderPath);
      this.logger.debug(`Created folder: ${folderPath}`);
    } catch (error) {
      // Folder might already exist due to race condition
      if (!this.app.vault.getAbstractFileByPath(folderPath)) {
        throw error;
      }
    }
  }

  /**
   * Validate that a file is eligible for processing
   */
  isEligibleForProcessing(file) {
    if (!(file instanceof TFile) || file.extension !== "md") {
      return false;
    }

    if (this.app.metadataCache.isUserIgnored(file.path)) {
      return false;
    }

    if (this.isFileInIgnoredFolder(file.path)) {
      return false;
    }

    return true;
  }
}

/**
 * Logger utility for consistent logging with optional debug mode
 */
class Logger {
  constructor(debugEnabled = false) {
    this.debugEnabled = debugEnabled;
  }

  debug(msg) {
    if (this.debugEnabled) {
      console.log(`[PropMove] ${msg}`);
    }
  }

  info(msg) {
    console.log(`[PropMove] ${msg}`);
  }

  error(msg) {
    console.error(`[PropMove] ${msg}`);
  }

  setDebugEnabled(enabled) {
    this.debugEnabled = enabled;
  }
}

module.exports = class PropMove extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.migrateSettings();
    this.pending = new Map();
    this.movingPaths = new Set();
    this.isStartup = true;

    // Initialize logger and file processor
    this.logger = new Logger(this.settings.debugLogging);
    this.fileProcessor = new FileProcessor(this.app, this.settings, this.logger);

    this.addSettingTab(new PropMoveSettingTab(this.app, this));

    // Register manual trigger command
    this.addCommand({
      id: "trigger-manual-process",
      name: "Process files according to property rules",
      callback: () => this.processAllFiles()
    });

    // Register preview command
    this.addCommand({
      id: "preview-moves",
      name: "Preview property-based moves (shows what would be moved)",
      callback: () => this.previewMoves()
    });

    // Register event handlers conditionally based on settings
    if (this.settings.moveOnCreate && !this.settings.manualTriggerOnly) {
      this.registerEvent(
        this.app.vault.on("create", (file) => {
          this.logger.debug(`File created, queuing process: ${file.path}`);
          this.queueProcess(file);
        })
      );
    }

    if (this.settings.moveOnMetadataChange && !this.settings.manualTriggerOnly) {
      this.registerEvent(
        this.app.metadataCache.on("changed", (file) => {
          this.logger.debug(`Metadata changed, queuing process: ${file.path}`);

          // Skip processing during startup if moveOnStartup is disabled
          if (this.isStartup && !this.settings.moveOnStartup) {
            this.logger.debug(`Skipping startup processing for: ${file.path}`);
            return;
          }

          this.queueProcess(file);
        })
      );
    }

    // Handle startup processing if enabled
    if (this.settings.moveOnStartup && !this.settings.manualTriggerOnly) {
      setTimeout(() => {
        this.isStartup = false;
        this.logger.debug("Startup complete");
      }, 2000); // Consider startup complete after 2 seconds
    } else {
      this.isStartup = false;
    }
  }

  onunload() {
    for (const timeoutId of this.pending.values()) {
      clearTimeout(timeoutId);
    }
    this.pending.clear();
    this.movingPaths.clear();
  }

  /**
   * Queue a file for processing with debouncing
   */
  queueProcess(file) {
    if (!this.fileProcessor.isEligibleForProcessing(file)) {
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
    }, this.settings.processingDelay);

    this.pending.set(file.path, timeoutId);
  }

  /**
   * Process all files according to property rules
   */
  async processAllFiles() {
    this.logger.debug("Starting manual processing of all files");

    const files = this.app.vault.getMarkdownFiles();
    let processedCount = 0;
    let movedCount = 0;
    let skippedCount = 0;
    const maxFiles = this.settings.maxFilesPerBatch > 0 ? this.settings.maxFilesPerBatch : files.length;

    for (const file of files) {
      if (processedCount >= maxFiles) {
        this.logger.debug(`Reached maximum files per batch: ${maxFiles}`);
        break;
      }

      // Skip files in ignored folders
      if (this.fileProcessor.isFileInIgnoredFolder(file.path)) {
        this.logger.debug(`Skipping ignored file: ${file.path}`);
        continue;
      }

      try {
        this.logger.debug(`Processing file: ${file.path}`);
        const result = await this.processFile(file.path);
        if (result && result.success) {
          movedCount++;
        } else {
          skippedCount++;
        }
        processedCount++;
      } catch (error) {
        this.logger.error(`Error processing file ${file.path}: ${error.message}`);
        skippedCount++;
      }
    }

    const message = `PropMove: Processed ${processedCount} files, moved ${movedCount}, skipped ${skippedCount}`;
    this.logger.info(message);
    new Notice(message);
  }

  /**
   * Preview what moves would be made without actually moving files
   */
  async previewMoves() {
    this.logger.debug("Starting preview of moves");

    const files = this.app.vault.getMarkdownFiles();
    const previews = [];
    let moveCount = 0;
    let skipCount = 0;

    for (const file of files) {
      if (!this.fileProcessor.isEligibleForProcessing(file)) {
        continue;
      }

      const cache = this.app.metadataCache.getFileCache(file);
      const frontmatter = cache ? cache.frontmatter : null;

      const preview = this.fileProcessor.previewMove(file, frontmatter);
      if (preview) {
        previews.push({
          file: file.path,
          ...preview
        });

        if (preview.action === "move" || preview.action === "move_with_suffix") {
          moveCount++;
        } else {
          skipCount++;
        }
      }
    }

    if (moveCount === 0 && skipCount === 0) {
      new Notice("PropMove: No files would be moved based on current rules");
      return;
    }

    // Log preview results
    previews.forEach(p => {
      if (p.action === "move") {
        const pathInfo = p.template && p.template !== p.interpolated 
          ? `${p.file} → ${p.targetPath} (template: ${p.template} → ${p.interpolated})`
          : `${p.file} → ${p.targetPath}`;
        this.logger.info(`[PREVIEW] MOVE: ${pathInfo}`);
      } else if (p.action === "move_with_suffix") {
        const pathInfo = p.template && p.template !== p.interpolated
          ? `${p.file} → ${p.targetFolder}/ (template: ${p.template} → ${p.interpolated})`
          : `${p.file} → ${p.targetFolder}/`;
        this.logger.info(`[PREVIEW] MOVE (with suffix): ${pathInfo}`);
      } else if (p.action === "skip") {
        this.logger.info(`[PREVIEW] SKIP: ${p.file} (${p.reason})`);
      }
    });

    const message = `PropMove Preview: ${moveCount} would move, ${skipCount} would skip. Check console for details.`;
    this.logger.info(message);
    new Notice(message);
  }

  /**
   * Process a single file and move it if applicable
   */
  async processFile(filePath) {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!this.fileProcessor.isEligibleForProcessing(file)) {
      return null;
    }

    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = cache ? cache.frontmatter : null;

    if (!frontmatter) {
      return null;
    }

    const targetFolder = this.fileProcessor.findTargetFolder(frontmatter);
    if (!targetFolder) {
      return null;
    }

    try {
      this.movingPaths.add(file.path);
      const result = await this.fileProcessor.moveFile(file, targetFolder);
      return result;
    } catch (error) {
      this.logger.error(`Failed to move ${file.name}: ${error.message}`);
      new Notice(`PropMove: Failed to move ${file.name}`);
      return { success: false, error: error.message };
    } finally {
      this.movingPaths.delete(file.path);
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // Update logger debug setting
    if (this.logger) {
      this.logger.setDebugEnabled(this.settings.debugLogging);
    }
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

    // Migrate new settings with defaults if they don't exist
    const newSettings = [
      "moveOnCreate",
      "moveOnMetadataChange",
      "moveOnStartup",
      "manualTriggerOnly",
      "debugLogging",
      "processingDelay",
      "maxFilesPerBatch",
      "caseInsensitiveMatching"
    ];

    newSettings.forEach(setting => {
      if (this.settings[setting] === undefined) {
        this.settings[setting] = DEFAULT_SETTINGS[setting];
      }
    });
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

    containerEl.createEl("h2", { text: "PropMove Settings" });

    // Manual trigger only setting (master switch)
    new Setting(containerEl)
      .setName("Manual trigger only")
      .setDesc("When enabled, files are only moved when manually triggered. All automatic triggers are disabled.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.manualTriggerOnly)
          .onChange(async (value) => {
            this.plugin.settings.manualTriggerOnly = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    containerEl.createEl("hr");
    containerEl.createEl("h3", { text: "Automatic Triggers" });

    containerEl.createEl("p", {
      text: "Configure when files should be automatically moved based on property changes.",
      cls: "setting-item-description"
    });

    // Trigger event settings
    const triggerSettings = [
      {
        name: "Move on file creation",
        desc: "Move files when they are first created",
        setting: "moveOnCreate",
        disabled: this.plugin.settings.manualTriggerOnly
      },
      {
        name: "Move on property change",
        desc: "Move files when their frontmatter properties are modified",
        setting: "moveOnMetadataChange",
        disabled: this.plugin.settings.manualTriggerOnly
      },
      {
        name: "Move on startup",
        desc: "Move files when Obsidian starts up (based on current property rules)",
        setting: "moveOnStartup",
        disabled: this.plugin.settings.manualTriggerOnly
      }
    ];

    triggerSettings.forEach((trigger) => {
      new Setting(containerEl)
        .setName(trigger.name)
        .setDesc(trigger.desc)
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings[trigger.setting])
            .setDisabled(trigger.disabled)
            .onChange(async (value) => {
              this.plugin.settings[trigger.setting] = value;
              await this.plugin.saveSettings();
            })
        );
    });

    // Manual trigger button
    new Setting(containerEl)
      .addButton((button) =>
        button
          .setButtonText("Process all files now")
          .setCta()
          .onClick(async () => {
            await this.plugin.processAllFiles();
          })
      );

    // Preview button
    new Setting(containerEl)
      .addButton((button) =>
        button
          .setButtonText("Preview moves (read-only)")
          .onClick(async () => {
            await this.plugin.previewMoves();
          })
      );

    containerEl.createEl("hr");

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

    // Case-insensitive matching
    new Setting(containerEl)
      .setName("Case-insensitive property matching")
      .setDesc(
        "When enabled, property values are matched case-insensitively (e.g., 'Task', 'task', 'TASK' all match)"
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.caseInsensitiveMatching)
          .onChange(async (value) => {
            this.plugin.settings.caseInsensitiveMatching = value;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("hr");

    // Performance settings
    containerEl.createEl("h3", { text: "Performance Settings" });

    new Setting(containerEl)
      .setName("Processing delay (ms)")
      .setDesc("Delay before processing file changes to allow for batch updates (default: 150ms)")
      .addText((text) =>
        text
          .setPlaceholder("150")
          .setValue(String(this.plugin.settings.processingDelay || 150))
          .onChange(async (value) => {
            const numValue = parseInt(value) || 150;
            this.plugin.settings.processingDelay = numValue;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Max files per manual batch")
      .setDesc("Maximum number of files to process in one manual trigger (0 = no limit)")
      .addText((text) =>
        text
          .setPlaceholder("0")
          .setValue(String(this.plugin.settings.maxFilesPerBatch || 0))
          .onChange(async (value) => {
            const numValue = parseInt(value) || 0;
            this.plugin.settings.maxFilesPerBatch = numValue;
            await this.plugin.saveSettings();
          })
      );

    // Debug setting
    new Setting(containerEl)
      .setName("Enable debug logging")
      .setDesc("Log detailed information to console for troubleshooting")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.debugLogging)
          .onChange(async (value) => {
            this.plugin.settings.debugLogging = value;
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
    containerEl.createEl("h3", { text: "Property Mappings" });

    containerEl.createEl("p", {
      text: "Use {propertyName} to create dynamic paths based on frontmatter values."
    });

    // Template variable help section
    const helpSection = containerEl.createDiv();
    helpSection.style.backgroundColor = "var(--background-secondary)";
    helpSection.style.padding = "12px";
    helpSection.style.borderRadius = "6px";
    helpSection.style.marginBottom = "16px";
    
    helpSection.createEl("strong", { text: "📌 Template Variables Guide:" });
    
    const examples = [
      "{project}/tasks → MyProject/tasks (if project=MyProject)",
      "{project}/tasks/{priority} → MyProject/tasks/high",
      "Archive/{status}/{date} → Archive/complete/2025-02-24",
      "Zones/{zone}/Projects/{project} → Zones/Dev/Projects/MyApp"
    ];
    
    const listContainer = helpSection.createDiv();
    listContainer.style.marginTop = "8px";
    examples.forEach(example => {
      const item = listContainer.createEl("div", { text: "• " + example });
      item.style.fontSize = "12px";
      item.style.marginBottom = "4px";
      item.style.color = "var(--text-muted)";
    });

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
        .setDesc("Frontmatter property to watch (e.g., 'type', 'status', 'category')");

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
          text: "Add one or more value-to-folder mappings for this property.",
          cls: "setting-item-description"
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
            .setPlaceholder("Projects/Tasks or {project}/tasks/{priority}")
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
