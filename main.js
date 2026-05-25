const {
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  normalizePath,
  Notice,
  Command,
  Modal
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
  caseInsensitiveMatching: false,
  autoCreateFolders: true
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
      const mapping = this.findMatchingMapping(mappings, normalizedValues, rawValue, propName);

      if (mapping) {
        const targetFolder = String(mapping.folder || "").trim();
        if (targetFolder) return targetFolder;
      }
    }

    return null;
  }

  /**
   * Find matching mapping considering case sensitivity setting
   * Supports: wildcard '*', operator field (equals, contains, is-empty, is-not-empty)
   */
  findMatchingMapping(mappings, normalizedValues, rawFrontmatterValue, propName) {
    for (const item of mappings) {
      const operator = (item.operator || "equals").trim();
      const mappingValue = String(item.value || "").trim();

      // --- Presence operators (ignore value field) ---
      if (operator === "is-empty") {
        if (normalizedValues.length === 0) {
          this.logger.debug(`[MATCH] is-empty matched for "${propName}"`);
          return item;
        }
        continue;
      }

      if (operator === "is-not-empty") {
        if (normalizedValues.length > 0) {
          this.logger.debug(`[MATCH] is-not-empty matched for "${propName}"`);
          return item;
        }
        continue;
      }

      // --- Value operators ---
      if (mappingValue.length === 0) continue;

      // Wildcard match - '*' matches any non-empty value
      if (mappingValue === "*") {
        if (normalizedValues.length > 0) {
          this.logger.debug(`[MATCH] Wildcard matched with value: ${normalizedValues[0]}`);
          return item;
        }
        continue;
      }

      let isMatch;
      if (operator === "contains") {
        const check = this.settings.caseInsensitiveMatching
          ? mappingValue.toLowerCase()
          : mappingValue;
        isMatch = normalizedValues.some(v => {
          const val = this.settings.caseInsensitiveMatching ? v.toLowerCase() : v;
          return val.includes(check);
        });
      } else {
        // Default: equals
        isMatch = this.settings.caseInsensitiveMatching
          ? normalizedValues.some(v => v.toLowerCase() === mappingValue.toLowerCase())
          : normalizedValues.includes(mappingValue);
      }

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

      let normalized = String(value).trim();
      if (normalized.length === 0) {
        this.logger.debug(`[INTERPOLATE] Property '${propName}' is empty, keeping literal: ${match}`);
        return match;
      }

      normalized = stripWikiLink(normalized);
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

    // Check if folder exists
    const folderExists = this.app.vault.getAbstractFileByPath(normalizedFolder) instanceof TFolder;
    if (!folderExists && !this.settings.autoCreateFolders) {
      return {
        action: "skip",
        reason: "folder_not_exist_no_create",
        targetFolder: normalizedFolder,
        template: targetFolder,
        interpolated: interpolatedFolder
      };
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
      // Try to ensure folder exists
      const folderCreated = await this.ensureFolder(normalizedFolder, this.settings.autoCreateFolders);
      
      if (!folderCreated) {
        const msg = `Target folder does not exist and autoCreateFolders is disabled: ${normalizedFolder}`;
        this.logger.debug(msg);
        return { success: false, action: "skip", message: msg };
      }

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
   * @param {string} folderPath - Path to the folder
   * @param {boolean} autoCreate - Whether to create folder if it doesn't exist
   * @returns {Promise<boolean>} True if folder exists or was created, false otherwise
   */
  async ensureFolder(folderPath, autoCreate = true) {
    const existing = this.app.vault.getAbstractFileByPath(folderPath);
    if (existing instanceof TFolder) {
      return true;
    }

    if (!autoCreate) {
      this.logger.debug(`Folder does not exist and autoCreateFolders is disabled: ${folderPath}`);
      return false;
    }

    try {
      await this.app.vault.createFolder(folderPath);
      this.logger.debug(`Created folder: ${folderPath}`);
      return true;
    } catch (error) {
      // Folder might already exist due to race condition
      if (this.app.vault.getAbstractFileByPath(folderPath)) {
        return true;
      }
      throw error;
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

/**
 * Strip [[wiki-link]] wrapper from a string value.
 * Handles: [[Name]], [[Name|Alias]], [[Name#heading]]
 * Leaves plain text and partial links unchanged.
 */
function stripWikiLink(value) {
  const match = value.match(/^\[\[([^\]\|]+)(?:\|.*)?\]\]$/);
  return match ? match[1] : value;
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

    // Register process folder command
    this.addCommand({
      id: "process-folder",
      name: "Process files in specific folder",
      callback: () => this.promptFolderAndProcess()
    });

    // Register preview folder command
    this.addCommand({
      id: "preview-folder",
      name: "Preview moves in specific folder",
      callback: () => this.promptFolderAndPreview()
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

    // Track folder renames and auto-update mapping paths
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFolder) {
          this.handleFolderRename(file.path, oldPath);
        }
      })
    );

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

  /**
   * Handle folder rename by updating all mapping paths that reference the old path.
   * Covers exact folder match and nested subfolder references.
   */
  handleFolderRename(newPath, oldPath) {
    const oldNormalized = normalizePath(oldPath);
    const newNormalized = normalizePath(newPath);

    let updated = 0;

    this.settings.properties.forEach(group => {
      // Skip properties with auto-update disabled
      if (group.autoUpdatePaths === false) {
        return;
      }

      (group.mappings || []).forEach(mapping => {
        const oldFolder = normalizePath(mapping.folder);

        // Exact match or parent folder
        if (
          oldFolder === oldNormalized ||
          oldFolder.startsWith(oldNormalized + "/")
        ) {
          // Replace the old folder path with the new one
          mapping.folder = newNormalized + oldFolder.slice(oldNormalized.length);
          updated++;
          this.logger.debug(
            `[RENAME] Updated mapping path: "${oldFolder}" -> "${mapping.folder}"`
          );
        }
      });
    });

    // Also check ignoreFolders
    for (let i = 0; i < this.settings.ignoreFolders.length; i++) {
      const oldIgnore = normalizePath(this.settings.ignoreFolders[i]);
      if (
        oldIgnore === oldNormalized ||
        oldIgnore.startsWith(oldNormalized + "/")
      ) {
        this.settings.ignoreFolders[i] =
          newNormalized + oldIgnore.slice(oldNormalized.length);
        updated++;
        this.logger.debug(
          `[RENAME] Updated ignore folder: "${oldIgnore}" -> "${this.settings.ignoreFolders[i]}"`
        );
      }
    }

    if (updated > 0) {
      this.saveSettings();
      this.logger.info(
        `[RENAME] Updated ${updated} path(s) after "${oldNormalized}" -> "${newNormalized}"`
      );
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
    await this.processFiles(this.app.vault.getMarkdownFiles());
  }

  /**
   * Process files in a specific folder (including subfolders).
   * @param {string} folderPath - Folder path to process
   */
  async processFolder(folderPath) {
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder)) {
      new Notice(`PropMove: Folder not found: ${folderPath}`);
      return;
    }

    const normalizedFolder = normalizePath(folderPath);
    const files = this.app.vault.getMarkdownFiles().filter(f =>
      f.path.startsWith(normalizedFolder + '/')
    );

    if (files.length === 0) {
      new Notice(`PropMove: No markdown files in "${folderPath}"`);
      return;
    }

    await this.processFiles(files);
  }

  /**
   * Core file processing loop with chunking for performance.
   * @param {TFile[]} files - Files to process
   */
  async processFiles(files) {
    this.logger.debug("Starting manual processing of all files");

    let processedCount = 0;
    let movedCount = 0;
    let skippedCount = 0;
    const maxFiles = this.settings.maxFilesPerBatch > 0 ? this.settings.maxFilesPerBatch : files.length;

    for (const file of files) {
      // Yield to UI thread every 50 files to keep the UI responsive
      if (processedCount % 50 === 0 && processedCount > 0) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }

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
    await this.previewFiles(this.app.vault.getMarkdownFiles());
  }

  /**
   * Preview moves in a specific folder (including subfolders).
   * @param {string} folderPath - Folder path to preview
   */
  async previewFolder(folderPath) {
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder)) {
      new Notice(`PropMove: Folder not found: ${folderPath}`);
      return;
    }

    const normalizedFolder = normalizePath(folderPath);
    const files = this.app.vault.getMarkdownFiles().filter(f =>
      f.path.startsWith(normalizedFolder + '/')
    );

    if (files.length === 0) {
      new Notice(`PropMove: No markdown files in "${folderPath}"`);
      return;
    }

    await this.previewFiles(files);
  }

  /**
   * Core preview loop.
   * @param {TFile[]} files - Files to preview
   */
  async previewFiles(files) {
    this.logger.debug("Starting preview of moves");

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
        if (p.reason === "folder_not_exist_no_create") {
          this.logger.info(`[PREVIEW] SKIP: ${p.file} (folder does not exist: ${p.targetFolder})`);
        } else {
          this.logger.info(`[PREVIEW] SKIP: ${p.file} (${p.reason})`);
        }
      }
    });

    const message = `PropMove Preview: ${moveCount} would move, ${skipCount} would skip. Check console for details.`;
    this.logger.info(message);
    new Notice(message);
  }

  /**
   * Prompt user to select a folder and process it.
   */
  promptFolderAndProcess() {
    const folders = this.collectAllFolders();
    const modal = new FolderPickerModal(this.app, folders, (folder) => {
      if (folder) {
        this.processFolder(folder);
      }
    });
    modal.open();
  }

  /**
   * Prompt user to select a folder and preview moves.
   */
  promptFolderAndPreview() {
    const folders = this.collectAllFolders();
    const modal = new FolderPickerModal(this.app, folders, (folder) => {
      if (folder) {
        this.previewFolder(folder);
      }
    });
    modal.open();
  }

  /**
   * Collect all folder paths recursively for suggestions.
   * @returns {string[]} All folder paths in the vault
   */
  collectAllFolders() {
    const folders = [];
    const root = this.app.vault.getRoot();

    const traverse = (folder) => {
      if (folder instanceof TFolder) {
        folders.push(folder.path);
        folder.children.forEach(traverse);
      }
    };

    if (root) {
      root.children.forEach(traverse);
    }

    return folders;
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
      
      // Notify user of specific failures
      if (!result.success && result.message) {
        if (result.message.includes("folder does not exist")) {
          new Notice(`PropMove: ${result.message}`);
        } else if (result.action === "error") {
          new Notice(`PropMove: Failed to move ${file.name}`);
        }
      }
      
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
      mappings: (Array.isArray(group.mappings) ? group.mappings : []).map((m) => ({
        value: String(m.value || "").trim(),
        folder: String(m.folder || ""),
        operator: m.operator || "equals" // default equals
      })),
      autoUpdatePaths: group.autoUpdatePaths !== false // default true
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
      "caseInsensitiveMatching",
      "autoCreateFolders"
    ];

    newSettings.forEach(setting => {
      if (this.settings[setting] === undefined) {
        this.settings[setting] = DEFAULT_SETTINGS[setting];
      }
    });
  }
};

// Export for testing
module.exports.stripWikiLink = stripWikiLink;

/**
 * Collect all unique frontmatter property keys from the vault
 */
function collectVaultPropertyKeys(app) {
  let propKeys = [];
  if (typeof app.metadataCache.getAllMetadataProperties === 'function') {
    const vaultProps = app.metadataCache.getAllMetadataProperties();
    propKeys = Object.keys(vaultProps).sort();
  } else {
    const seen = new Set();
    for (const file of app.vault.getMarkdownFiles()) {
      const cache = app.metadataCache.getFileCache(file);
      if (cache && cache.frontmatter) {
        for (const key of Object.keys(cache.frontmatter)) {
          seen.add(key);
        }
      }
    }
    propKeys = Array.from(seen).sort();
  }
  return propKeys;
}

/**
 * Collect all unique values for a given property key from the vault
 */
function collectVaultPropertyValues(app, propName) {
  const values = new Set();
  if (!propName) return [];
  for (const file of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(file);
    if (cache && cache.frontmatter && cache.frontmatter[propName] !== undefined) {
      const raw = cache.frontmatter[propName];
      const vals = Array.isArray(raw) ? raw : [raw];
      for (const v of vals) {
        const trimmed = String(v).trim();
        if (trimmed.length > 0) {
          values.add(trimmed);
        }
      }
    }
    // Fallback: read file directly if cache is empty
    if (values.size === 0) {
      try {
        const content = app.vault.readCachedFile(file) || app.vault.readAsync(file);
        if (content) {
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
          if (fmMatch) {
            const frontmatter = fmMatch[1];
            const lineMatch = frontmatter.match(new RegExp('^' + propName + ':\\s*(.+)$', 'm'));
            if (lineMatch) {
              const val = lineMatch[1].trim();
              if (val) values.add(val);
            }
          }
        }
      } catch (e) {}
    }
  }
  return Array.from(values).sort();
}

/**
 * Collect all folder paths from the vault (excluding vault root)
 */
function collectVaultFolders(app) {
  const folders = [];
  const rootPath = app.vault.getRoot()?.path || '';
  for (const item of app.vault.getAllLoadedFiles()) {
    if (item instanceof TFolder && item.path !== rootPath && item.path !== '') {
      folders.push(item.path);
    }
  }
  return folders.sort();
}

/**
 * PropMoveSuggestInput - Custom autocomplete input with scrollable dropdown.
 * Replaces HTML <datalist> which cannot be constrained with max-height.
 *
 * Features:
 * - Scrollable suggestion list with configurable max-height
 * - Filters suggestions as user types
 * - Arrow key navigation (up/down) + Enter to select
 * - Escape to close
 * - Click outside to close
 * - Allows arbitrary typed values (not restricted to suggestions)
 */
/**
 * PropMoveSuggestInput - Custom autocomplete input with scrollable dropdown.
 * Replaces HTML <datalist> which cannot be constrained with max-height.
 *
 * Features:
 * - Scrollable suggestion list attached to document.body (avoids parent overflow clipping)
 * - Filters suggestions as user types
 * - Arrow key navigation (up/down) + Enter to select
 * - Escape to close
 * - Click outside to close
 * - Allows arbitrary typed values (not restricted to suggestions)
 */
/**
 * Create a suggest input: text field + scrollable dropdown suggestions.
 * - Text input allows arbitrary typed values (not restricted to suggestions).
 * - Dropdown is attached to document.body to avoid parent overflow clipping.
 * - Filters suggestions as user types.
 * - Arrow key navigation (up/down) + Enter to select.
 * - Escape to close. Click outside to close.
 */
function createSuggestInput(container, options) {
  const wrapper = container.createDiv('suggest-input-wrapper');
  wrapper.style.position = 'relative';
  wrapper.style.width = options.wrapperWidth || '100%';
  if (options.wrapperFlex !== null && options.wrapperFlex !== undefined) {
    wrapper.style.flex = options.wrapperFlex;
  }
  if (options.wrapperMinWidth) {
    wrapper.style.minWidth = options.wrapperMinWidth;
  }

  // Text input - user can type anything
  const input = wrapper.createEl('input', { type: 'text' });
  input.style.width = '100%';
  input.style.boxSizing = 'border-box';
  input.style.padding = '4px 8px';
  input.style.fontSize = '13px';
  input.style.background = 'var(--background-primary)';
  input.style.border = '1px solid var(--background-modifier-border)';
  input.style.borderRadius = '4px';
  input.style.outline = 'none';

  // Mutable suggestions ref so updateSuggestions can change what showDropdown sees
  const suggestionsRef = { current: options.suggestions || [] };
  const initialValue = options.initialValue || '';
  input.value = initialValue;

  // Dropdown list - attached to body to escape overflow:hidden parents
  let dropdown = null;
  let highlightedIndex = -1;

  function showDropdown() {
    if (dropdown) {
      dropdown.remove();
    }
    highlightedIndex = -1;

    // Filter suggestions based on current input
    const filter = input.value.toLowerCase();
    const filtered = suggestionsRef.current.filter(s => s.toLowerCase().includes(filter));
    if (filtered.length === 0) return;

    dropdown = document.body.createDiv('propmove-suggest-dropdown');
    dropdown.style.position = 'absolute';
    dropdown.style.zIndex = '10000';
    dropdown.style.maxHeight = '200px';
    dropdown.style.overflowY = 'auto';
    dropdown.style.border = '1px solid var(--background-modifier-border)';
    dropdown.style.borderRadius = '4px';
    dropdown.style.background = 'var(--background-secondary)';
    dropdown.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
    dropdown.style.minWidth = '150px';

    const rect = input.getBoundingClientRect();
    dropdown.style.top = (rect.bottom + 2) + 'px';
    dropdown.style.left = rect.left + 'px';
    dropdown.style.width = rect.width + 'px';

    for (const s of filtered) {
      const item = dropdown.createDiv('propmove-suggest-item');
      item.textContent = s;
      item.style.padding = '6px 10px';
      item.style.cursor = 'pointer';
      item.style.fontSize = '13px';
      item.onmouseover = () => {
        highlightedIndex = [...dropdown.children].indexOf(item);
        updateHighlight();
      };
      item.onclick = () => {
        input.value = s;
        dropdown.remove();
        dropdown = null;
        if (options.onInput) options.onInput(s);
        if (options.onSelect) options.onSelect(s);
      };
    }

    positionDropdown();
  }

  function positionDropdown() {
    if (!dropdown) return;
    const rect = input.getBoundingClientRect();
    dropdown.style.top = (rect.bottom + 2) + 'px';
    dropdown.style.left = rect.left + 'px';
    dropdown.style.width = rect.width + 'px';
  }

  function hideDropdown() {
    if (dropdown) {
      dropdown.remove();
      dropdown = null;
    }
    highlightedIndex = -1;
  }

  function updateHighlight() {
    if (!dropdown) return;
    const items = dropdown.children;
    for (let i = 0; i < items.length; i++) {
      if (i === highlightedIndex) {
        items[i].style.background = 'var(--background-modifier-hover)';
      } else {
        items[i].style.background = '';
      }
    }
  }

  // Show dropdown on focus
  input.onfocus = () => showDropdown();

  // Filter on input
  input.oninput = () => {
    if (options.onInput) options.onInput(input.value);
    showDropdown();
  };

  // Keyboard navigation
  input.onkeydown = (e) => {
    if (!dropdown) return;
    const items = dropdown.children;
    if (!items.length) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      highlightedIndex = (highlightedIndex + 1) % items.length;
      updateHighlight();
      items[highlightedIndex].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlightedIndex = highlightedIndex <= 0 ? items.length - 1 : highlightedIndex - 1;
      updateHighlight();
      items[highlightedIndex].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      if (highlightedIndex >= 0 && items[highlightedIndex]) {
        e.preventDefault();
        const val = items[highlightedIndex].textContent;
        input.value = val;
        hideDropdown();
        if (options.onSelect) options.onSelect(val);
      }
    } else if (e.key === 'Escape') {
      hideDropdown();
    }
  };

  // Click outside to close
  const clickOutside = (e) => {
    if (!wrapper.contains(e.target)) {
      hideDropdown();
    }
  };
  document.addEventListener('click', clickOutside);

  // Reposition on scroll/resize
  window.addEventListener('scroll', positionDropdown, true);
  window.addEventListener('resize', positionDropdown);

  return {
    input,
    wrapper,
    updateSuggestions: function(newSuggestions) {
      suggestionsRef.current = newSuggestions || [];
      // Re-show dropdown if open
      if (dropdown) showDropdown();
    },
    destroy: function() {
      document.removeEventListener('click', clickOutside);
      window.removeEventListener('scroll', positionDropdown, true);
      window.removeEventListener('resize', positionDropdown);
      hideDropdown();
      if (wrapper && wrapper.parentNode) {
        wrapper.parentNode.removeChild(wrapper);
      }
    },
    getValue: function() {
      return input.value;
    }
  };
}


class PropMoveSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.suggestInputs = [];
  }

  display() {
    // Clean up old suggest inputs to prevent memory leaks
    for (const input of this.suggestInputs) {
      input.destroy();
    }
    this.suggestInputs = [];
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

    // Automatic Triggers section (hidden when manual trigger only is enabled)
    if (!this.plugin.settings.manualTriggerOnly) {
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
          setting: "moveOnCreate"
        },
        {
          name: "Move on property change",
          desc: "Move files when their frontmatter properties are modified",
          setting: "moveOnMetadataChange"
        },
        {
          name: "Move on startup",
          desc: "Move files when Obsidian starts up (based on current property rules)",
          setting: "moveOnStartup"
        }
      ];

      triggerSettings.forEach((trigger) => {
        new Setting(containerEl)
          .setName(trigger.name)
          .setDesc(trigger.desc)
          .addToggle((toggle) =>
            toggle
              .setValue(this.plugin.settings[trigger.setting])
              .onChange(async (value) => {
                this.plugin.settings[trigger.setting] = value;
                await this.plugin.saveSettings();
              })
          );
      });
    }

    containerEl.createEl("hr");
    containerEl.createEl("h3", { text: "Manual Triggers" });

    // Process all files button
    new Setting(containerEl)
      .setName("Process all files")
      .setDesc("Move all files based on current property rules")
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
      .setName("Preview moves")
      .setDesc("Show what moves would be made without actually moving files")
      .addButton((button) =>
        button
          .setButtonText("Preview moves (read-only)")
          .onClick(async () => {
            await this.plugin.previewMoves();
          })
      );

    // Process folder button
    new Setting(containerEl)
      .setName("Process folder")
      .setDesc("Select a specific folder to process files in")
      .addButton((button) =>
        button
          .setButtonText("Process folder...")
          .onClick(() => {
            this.plugin.promptFolderAndProcess();
          })
      );

    containerEl.createEl("hr");
    containerEl.createEl("h3", { text: "Move Behavior" });

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

    // Auto-create folders setting
    new Setting(containerEl)
      .setName("Automatically create target folders")
      .setDesc(
        "When enabled, missing target folders are created automatically. When disabled, files are not moved if the target folder doesn't exist and you'll be notified."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoCreateFolders)
          .onChange(async (value) => {
            this.plugin.settings.autoCreateFolders = value;
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
    containerEl.createEl("h3", { text: "Mappings" });

    containerEl.createEl("p", {
      text: "Use {propertyName} to create dynamic paths based on frontmatter values."
    });

    // Template variable help section
    const helpSection = containerEl.createDiv();
    helpSection.style.backgroundColor = "var(--background-secondary)";
    helpSection.style.padding = "12px";
    helpSection.style.borderRadius = "6px";
    helpSection.style.marginBottom = "16px";
    
    helpSection.createEl("strong", { text: "📌 Template Variables & Wildcards Guide:" });
    
    const examples = [
      "{project}/tasks → MyProject/tasks (if project=MyProject)",
      "{project}/tasks/{priority} → MyProject/tasks/high",
      "Archive/{status}/{date} → Archive/complete/2025-02-24",
      "Zones/{zone}/Projects/{project} → Zones/Dev/Projects/MyApp",
      "* as property value → matches ANY non-empty property value"
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
        text: "Add one or more properties with value-to-folder mappings.",
        cls: "setting-item-description"
      });
    }

    this.plugin.settings.properties.forEach((group, groupIndex) => {
      // Card container
      const card = containerEl.createDiv();
      card.style.background = "var(--background-secondary)";
      card.style.borderRadius = "8px";
      card.style.padding = "16px";
      card.style.marginBottom = "12px";

      // Card header: title + trash
      const header = card.createDiv();
      header.style.display = "flex";
      header.style.justifyContent = "space-between";
      header.style.alignItems = "center";
      header.style.marginBottom = "12px";
      header.style.borderBottom = "1px solid var(--background-modifier-border)";
      header.style.paddingBottom = "8px";

      const title = header.createEl("strong", {
        text: `Mapping ${groupIndex + 1}`
      });
      title.style.fontSize = "14px";

      const trashBtn = header.createEl("button");
      trashBtn.innerHTML = "<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='3 6 5 6 21 6'></polyline><path d='M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'></path></svg>";
      trashBtn.style.background = "none";
      trashBtn.style.border = "none";
      trashBtn.style.cursor = "pointer";
      trashBtn.style.color = "var(--text-muted)";
      trashBtn.style.padding = "4px";
      trashBtn.style.display = "flex";
      trashBtn.style.alignItems = "center";
      trashBtn.title = "Remove mapping";
      trashBtn.onclick = async () => {
        this.plugin.settings.properties.splice(groupIndex, 1);
        await this.plugin.saveSettings();
        this.display();
      };

      // Property name input
      const nameRow = card.createDiv();
      nameRow.style.display = "flex";
      nameRow.style.alignItems = "center";
      nameRow.style.gap = "8px";
      nameRow.style.marginBottom = "12px";

      const nameLabel = nameRow.createEl("span", {
        text: "Property name"
      });
      nameLabel.style.fontSize = "13px";
      nameLabel.style.fontWeight = "500";

      // Declare valueSuggestInputs array here so name input callbacks can reference it
      const valueSuggestInputs = [];

      // Property name suggest input with scrollable dropdown
      const nameSuggest = createSuggestInput(nameRow, {
        suggestions: collectVaultPropertyKeys(this.app),
        placeholder: "type",
        initialValue: group.name || "",
        onInput: async (val) => {
          group.name = val.trim();
          await this.plugin.saveSettings();
          // Update value suggestions dynamically when property name changes
          const propName = group.name || "";
          const vals = collectVaultPropertyValues(this.app, propName);
          vals.unshift("*");
          for (const vSuggest of valueSuggestInputs) {
            vSuggest.updateSuggestions(vals);
          }
        },
        onSelect: async (val) => {
          group.name = val.trim();
          await this.plugin.saveSettings();
          // Update value suggestions dynamically when property name is selected
          const propName = group.name || "";
          const vals = collectVaultPropertyValues(this.app, propName);
          vals.unshift("*");
          for (const vSuggest of valueSuggestInputs) {
            vSuggest.updateSuggestions(vals);
          }
        }
      });
      this.suggestInputs.push(nameSuggest);

      // Auto-update toggle
      const toggleRow = card.createDiv();
      toggleRow.style.display = "flex";
      toggleRow.style.alignItems = "center";
      toggleRow.style.gap = "8px";
      toggleRow.style.marginBottom = "8px";

      const toggleCheckbox = toggleRow.createEl("input", {
        type: "checkbox"
      });
      toggleCheckbox.checked = group.autoUpdatePaths !== false;
      toggleCheckbox.onchange = async () => {
        group.autoUpdatePaths = toggleCheckbox.checked;
        await this.plugin.saveSettings();
      };

      const toggleLabel = toggleRow.createEl("span", {
        text: "Update paths on folder rename"
      });
      toggleLabel.style.fontSize = "12px";
      toggleLabel.title = "When a folder is renamed in the vault, automatically update target paths for this property";

      const mappings = Array.isArray(group.mappings) ? group.mappings : [];

      // Collect initial value suggestions from vault for current property
      const initialVals = collectVaultPropertyValues(this.app, group.name || "");
      initialVals.unshift("*");

      // Collect folder suggestions
      const folderSuggestions = collectVaultFolders(this.app);

      // Mappings section container (scrollable to prevent overflow)
      const mappingsContainer = card.createDiv();
      mappingsContainer.style.marginTop = "12px";
      mappingsContainer.style.maxHeight = "350px";
      mappingsContainer.style.overflowY = mappings.length > 8 ? "auto" : "visible";

      // Mappings header
      const mappingsHeader = mappingsContainer.createDiv();
      mappingsHeader.style.display = "flex";
      mappingsHeader.style.justifyContent = "space-between";
      mappingsHeader.style.marginBottom = "4px";

      const mappingsTitle = mappingsHeader.createEl("span", {
        text: mappings.length === 0
          ? "Add value-to-folder mappings below"
          : `${mappings.length} mapping${mappings.length > 1 ? "s" : ""}`
      });
      mappingsTitle.style.fontSize = "11px";
      mappingsTitle.style.color = "var(--text-muted)";

      if (mappings.length > 0) {
        // Column headers
        const colHeaders = mappingsContainer.createDiv();
        colHeaders.style.display = "flex";
        colHeaders.style.gap = "8px";
        colHeaders.style.marginBottom = "4px";
        colHeaders.style.paddingLeft = "2px";

        const valHeader = colHeaders.createEl("span", { text: "Value" });
        valHeader.style.fontSize = "11px";
        valHeader.style.fontWeight = "600";
        valHeader.style.color = "var(--text-muted)";
        valHeader.style.width = "30%";

        const opHeader = colHeaders.createEl("span", { text: "Match" });
        opHeader.style.fontSize = "11px";
        opHeader.style.fontWeight = "600";
        opHeader.style.color = "var(--text-muted)";
        opHeader.style.width = "90px";
        opHeader.style.minWidth = "90px";

        const folderHeader = colHeaders.createEl("span", { text: "Target folder" });
        folderHeader.style.fontSize = "11px";
        folderHeader.style.fontWeight = "600";
        folderHeader.style.color = "var(--text-muted)";
        folderHeader.style.flex = "1";
      }

      // Mapping rows
      // valueSuggestInputs already declared above for name input callbacks
      mappings.forEach((mapping, index) => {
        const row = mappingsContainer.createDiv();
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.gap = "8px";
        row.style.marginBottom = "4px";

        // Value input with autocomplete dropdown
        const valueSuggest = createSuggestInput(row, {
          suggestions: initialVals,
          placeholder: "task or *",
          initialValue: mapping.value || "",
          wrapperWidth: "30%",
          wrapperMinWidth: "80px",
          onInput: async (val) => {
            mapping.value = val;
            await this.plugin.saveSettings();
          },
          onSelect: async (val) => {
            mapping.value = val;
            await this.plugin.saveSettings();
          }
        });
        valueSuggestInputs.push(valueSuggest);
        this.suggestInputs.push(valueSuggest);

        // Operator select
        const operatorSelect = row.createEl("select");
        operatorSelect.style.width = "90px";
        operatorSelect.style.minWidth = "90px";
        operatorSelect.style.padding = "4px";
        operatorSelect.style.fontSize = "12px";
        operatorSelect.style.background = "var(--background-primary)";
        operatorSelect.style.border = "1px solid var(--background-modifier-border)";
        operatorSelect.style.borderRadius = "4px";
        const currentOp = mapping.operator || "equals";
        for (const op of ["equals", "contains", "is empty", "is not empty"]) {
          const opt = operatorSelect.createEl("option", {
            text: op.replace(/-/g, " ").replace(/^\w/, c => c.toUpperCase()),
            value: op.replace(/ /g, "-")
          });
          if (op.replace(/ /g, "-") === currentOp) opt.selected = true;
        }
        operatorSelect.onchange = async () => {
          mapping.operator = operatorSelect.value;
          await this.plugin.saveSettings();
        };

        // Folder input with autocomplete dropdown
        const folderSuggest = createSuggestInput(row, {
          suggestions: folderSuggestions,
          placeholder: "Projects/Tasks",
          initialValue: mapping.folder || "",
          wrapperFlex: "1",
          onInput: async (val) => {
            mapping.folder = val;
            await this.plugin.saveSettings();
          },
          onSelect: async (val) => {
            mapping.folder = val;
            await this.plugin.saveSettings();
          }
        });
        this.suggestInputs.push(folderSuggest);

        const mapTrash = row.createEl("button");
        mapTrash.innerHTML = "<svg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><line x1='18' y1='6' x2='6' y2='18'></line><line x1='6' y1='6' x2='18' y2='18'></line></svg>";
        mapTrash.style.background = "none";
        mapTrash.style.border = "none";
        mapTrash.style.cursor = "pointer";
        mapTrash.style.color = "var(--text-muted)";
        mapTrash.style.padding = "4px";
        mapTrash.style.display = "flex";
        mapTrash.style.alignItems = "center";
        mapTrash.title = "Remove mapping";
        mapTrash.onclick = async () => {
          mappings.splice(index, 1);
          group.mappings = mappings;
          await this.plugin.saveSettings();
          this.display();
        };
      });

      // Add mapping button
      const addMapRow = card.createDiv();
      addMapRow.style.marginTop = "8px";
      addMapRow.style.marginBottom = "4px";

      const addMapBtn = addMapRow.createEl("button");
      addMapBtn.textContent = "+ Add mapping";
      addMapBtn.style.background = "none";
      addMapBtn.style.border = "none";
      addMapBtn.style.cursor = "pointer";
      addMapBtn.style.color = "var(--text-accent)";
      addMapBtn.style.fontSize = "12px";
      addMapBtn.style.padding = "4px 0";
      addMapBtn.onclick = async () => {
        mappings.push({ value: "", folder: "" });
        group.mappings = mappings;
        await this.plugin.saveSettings();
        this.display();
      };
    });

    new Setting(containerEl).addButton((button) => {
      button
        .setButtonText("Add mapping")
        .setCta()
        .onClick(async () => {
          this.plugin.settings.properties.push({ name: "", mappings: [] });
          await this.plugin.saveSettings();
          this.display();
        });
    });
  }

}

/**
 * Simple folder picker modal with autocomplete.
 */
class FolderPickerModal extends Modal {
  constructor(app, folders, onSubmit) {
    super(app);
    this.folders = folders;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Select Folder" });

    const input = contentEl.createEl("input", {
      type: "text",
      placeholder: "Type to search folders..."
    });
    input.setAttribute("autofocus", "");

    // Dropdown for suggestions
    const dropdown = contentEl.createDiv("folder-picker-dropdown");
    dropdown.style.maxHeight = "200px";
    dropdown.style.overflowY = "auto";
    dropdown.style.border = "1px solid var(--background-modifier-border)";
    dropdown.style.borderRadius = "4px";
    dropdown.style.padding = "4px 0";
    dropdown.style.display = "none";

    const showSuggestions = (filter = "") => {
      dropdown.empty();
      const filtered = this.folders.filter(f =>
        f.toLowerCase().includes(filter.toLowerCase())
      ).slice(0, 20); // Limit to 20 suggestions

      if (filtered.length === 0) {
        dropdown.style.display = "none";
        return;
      }

      dropdown.style.display = "block";

      filtered.forEach(folder => {
        const item = dropdown.createDiv("folder-picker-item");
        item.textContent = folder || "/ (root)";
        item.style.padding = "4px 8px";
        item.style.cursor = "pointer";

        item.onclick = () => {
          this.close();
          this.onSubmit(folder);
        };

        item.onmouseover = () => {
          item.style.backgroundColor = "var(--background-modifier-hover)";
        };

        item.onmouseout = () => {
          item.style.backgroundColor = "";
        };
      });
    };

    input.addEventListener("input", () => {
      showSuggestions(input.value);
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const value = input.value.trim();
        // Check if value matches a folder
        const match = this.folders.find(f => f === value);
        if (match !== undefined) {
          this.close();
          this.onSubmit(match);
        }
      } else if (e.key === "Escape") {
        this.close();
      }
    });

    // Submit button
    const btnContainer = contentEl.createDiv({
      style: "margin-top: 16px; text-align: right;"
    });

    const btn = btnContainer.createEl("button", {
      text: "Process Folder",
      cls: "mod-cta"
    });

    btn.onclick = () => {
      const value = input.value.trim();
      const match = this.folders.find(f => f === value);
      if (match !== undefined) {
        this.close();
        this.onSubmit(match);
      } else {
        new Notice("Folder not found");
      }
    };

    // Show all suggestions initially
    showSuggestions();

    // Focus input
    setTimeout(() => input.focus(), 50);
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
