// Tests for main.js: stripWikiLink, interpolateVariables, mapping operators,
// folder rename updates.
// Run: node test-wikistrip.js

// Mock obsidian module BEFORE requiring main.js
const Module = require('module');
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent) {
  if (request === 'obsidian') return '/mock/obsidian.js';
  return originalResolveFilename.apply(this, arguments);
};

const mockObsidian = {
  Plugin: class Plugin {},
  PluginSettingTab: class PluginSettingTab {},
  Setting: class Setting {},
  TFile: class TFile {},
  TFolder: class TFolder {},
  normalizePath: (p) => p,
  Notice: class Notice {},
  Command: class Command {},
  Modal: class Modal {},
};
require.cache['/mock/obsidian.js'] = { exports: mockObsidian };

const { stripWikiLink, FileProcessor } = require('./main.js');

// --- Shared test helpers ---
const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

function makeProcessor(settings) {
  return new FileProcessor({ vault: {}, metadataCache: {} }, settings, noopLogger);
}

// --- stripWikiLink unit tests ---
const unitTests = [
  ['[[MyProject]]', 'MyProject', 'basic wiki-link'],
  ['[[My Project|MP]]', 'My Project', 'wiki-link with alias'],
  ['PlainName', 'PlainName', 'plain text untouched'],
  ['[[Note#heading]]', 'Note#heading', 'wiki-link with heading anchor'],
  ['[[My Project]]', 'My Project', 'wiki-link with space'],
  ['text [[link]] more', 'text [[link]] more', 'partial link untouched'],
  ['[[A|B]]', 'A', 'alias stripped'],
  [']', ']', 'single bracket no match'],
  ['[[[]', '[[[]', 'malformed brackets no match'],
  [']]', ']]', 'just closing brackets'],
  ['[[]]', '[[]]', 'no closing brackets'],
  ['', '', 'empty string'],
];

let pass = 0, fail = 0;
for (const [input, expected, desc] of unitTests) {
  const result = stripWikiLink(input);
  const ok = result === expected;
  if (ok) pass++; else fail++;
  console.log(ok ? 'PASS' : 'FAIL', desc);
  if (!ok) {
    console.log(`  input:    ${JSON.stringify(input)}`);
    console.log(`  expected: ${expected}`);
    console.log(`  got:      ${result}`);
  }
}

// --- Integration: full interpolateVariables pipeline (real FileProcessor) ---
function interpolateVariables(path, frontmatter, ruleContext) {
  return makeProcessor({ properties: [], caseInsensitiveMatching: false })
    .interpolateVariables(path, frontmatter, null, ruleContext);
}

const integrationTests = [
  ['Projects/{project}/tasks', { project: '[[MyProject]]' }, 'Projects/MyProject/tasks', 'interpolate wiki-link in path'],
  ['{a}/{b}', { a: '[[Alpha]]', b: '[[Beta]]' }, 'Alpha/Beta', 'multiple wiki-link vars'],
  ['Projects/{project}', { project: 'PlainName' }, 'Projects/PlainName', 'interpolate plain text'],
  ['{project}', { project: '' }, '{project}', 'empty value kept literal'],
  ['{project}', { project: null }, '{project}', 'null value kept literal'],
  ['{missing}', { project: 'val' }, '{missing}', 'missing key kept literal'],
];

for (const [path, fm, expected, desc] of integrationTests) {
  const result = interpolateVariables(path, fm);
  const ok = result === expected;
  if (ok) pass++; else fail++;
  console.log(ok ? 'PASS' : 'FAIL', desc);
  if (!ok) {
    console.log(`  input:    path="${path}" fm=${JSON.stringify(fm)}`);
    console.log(`  expected: ${expected}`);
    console.log(`  got:      ${result}`);
  }
}

// --- Multi-value (Obsidian "List") interpolation: real FileProcessor ---
// [path, frontmatter, ruleContext, expected, desc]
const arrayInterpolationTests = [
  ['{type}', { type: ['book'] }, undefined, 'book', 'single-element list'],
  ['{type}', { type: ['book', 'note'] }, undefined, 'book', 'multi-value list uses first value (no comma folder)'],
  ['{type}', { type: ['', 'note'] }, undefined, 'note', 'blank first element skipped'],
  ['{type}', { type: ['', ''] }, undefined, '{type}', 'all-blank list kept literal'],
  ['{type}', { type: [] }, undefined, '{type}', 'empty list kept literal'],
  ['{type}/{name}', { type: ['book', 'note'], name: 'x' }, undefined, 'book/x', 'multi-value alongside scalar var'],
  ['Shelf/{type}', { type: ['book', 'note'] }, { property: 'type', value: 'note' }, 'Shelf/note', 'matched element wins over first'],
  ['{type}', { type: ['book', 'note'] }, { property: 'status', value: 'note' }, 'book', 'rule on another property falls back to first'],
  ['{type}', { type: ['[[Alpha]]', '[[Beta]]'] }, undefined, 'Alpha', 'list of wiki-links'],
];

for (const [path, fm, ctx, expected, desc] of arrayInterpolationTests) {
  const result = interpolateVariables(path, fm, ctx);
  const ok = result === expected;
  if (ok) pass++; else fail++;
  console.log(ok ? 'PASS' : 'FAIL', desc);
  if (!ok) {
    console.log(`  input:    path="${path}" fm=${JSON.stringify(fm)} ctx=${JSON.stringify(ctx)}`);
    console.log(`  expected: ${expected}`);
    console.log(`  got:      ${result}`);
  }
}

// --- handleFolderRename unit tests ---
// Simulates the rename handler logic without Obsidian
function normalizePathMock(p) {
  return p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function simulateHandleFolderRename(settings, newPath, oldPath) {
  const oldNormalized = normalizePathMock(oldPath);
  const newNormalized = normalizePathMock(newPath);
  let updated = 0;

  settings.properties.forEach(group => {
    // Respect per-property autoUpdatePaths flag
    if (group.autoUpdatePaths === false) {
      return;
    }

    (group.mappings || []).forEach(mapping => {
      const oldFolder = normalizePathMock(mapping.folder);
      if (
        oldFolder === oldNormalized ||
        oldFolder.startsWith(oldNormalized + "/")
      ) {
        mapping.folder = newNormalized + oldFolder.slice(oldNormalized.length);
        updated++;
      }
    });
  });

  // Also check ignoreFolders
  for (let i = 0; i < settings.ignoreFolders.length; i++) {
    const oldIgnore = normalizePathMock(settings.ignoreFolders[i]);
    if (
      oldIgnore === oldNormalized ||
      oldIgnore.startsWith(oldNormalized + "/")
    ) {
      settings.ignoreFolders[i] =
        newNormalized + oldIgnore.slice(oldNormalized.length);
      updated++;
    }
  }

  return updated;
}

// Deep clone helper for test isolation
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

const baseSettings = {
  properties: [
    {
      name: "status",
      autoUpdatePaths: true,
      mappings: [
        { value: "inbox", folder: "Notes/Inbox" },
        { value: "done", folder: "Notes/Archive" },
        { value: "active", folder: "Projects/Active" }
      ]
    },
    {
      name: "type",
      autoUpdatePaths: true,
      mappings: [
        { value: "task", folder: "Tasks/Inbox" },
        { value: "*", folder: "Notes/{type}" }
      ]
    }
  ],
  ignoreFolders: ["Notes/Templates", "Scratch"]
};

const renameTests = [
  {
    desc: "Exact match - folder renamed directly",
    settings: baseSettings,
    oldPath: "Notes/Inbox",
    newPath: "Journal/Inbox",
    expect: {
      mappings: [
        { folder: "Journal/Inbox" },   // changed
        { folder: "Notes/Archive" },   // unchanged
        { folder: "Projects/Active" }, // unchanged
        { folder: "Tasks/Inbox" },     // unchanged
        { folder: "Notes/{type}" }    // unchanged
      ],
      ignores: ["Notes/Templates", "Scratch"],
      updated: 1
    }
  },
  {
    desc: "Parent folder renamed - all children update",
    settings: baseSettings,
    oldPath: "Notes",
    newPath: "Journal",
    expect: {
      mappings: [
        { folder: "Journal/Inbox" },   // changed (child)
        { folder: "Journal/Archive" }, // changed (child)
        { folder: "Projects/Active" }, // unchanged
        { folder: "Tasks/Inbox" },     // unchanged
        { folder: "Journal/{type}" }  // changed (child)
      ],
      ignores: ["Journal/Templates", "Scratch"],
      updated: 4 // 3 mappings + 1 ignore
    }
  },
  {
    desc: "Unrelated rename - no changes",
    settings: baseSettings,
    oldPath: "Random/Folder",
    newPath: "Other/Folder",
    expect: {
      mappings: [
        { folder: "Notes/Inbox" },
        { folder: "Notes/Archive" },
        { folder: "Projects/Active" },
        { folder: "Tasks/Inbox" },
        { folder: "Notes/{type}" }
      ],
      ignores: ["Notes/Templates", "Scratch"],
      updated: 0
    }
  },
  {
    desc: "Prefix match prevented - partial name overlap",
    settings: {
      properties: [
        {
          name: "cat",
          mappings: [{ value: "x", folder: "Notes/Inbox" }]
        }
      ],
      ignoreFolders: []
    },
    oldPath: "Note",        // partial match of "Notes"
    newPath: "Journal",
    expect: {
      mappings: [{ folder: "Notes/Inbox" }],
      ignores: [],
      updated: 0
    }
  },
  {
    desc: "Root folder rename",
    settings: {
      properties: [
        {
          name: "tag",
          mappings: [
            { value: "a", folder: "Inbox" },
            { value: "b", folder: "Inbox/Sub" }
          ]
        }
      ],
      ignoreFolders: []
    },
    oldPath: "Inbox",
    newPath: "Tray",
    expect: {
      mappings: [
        { folder: "Tray" },
        { folder: "Tray/Sub" }
      ],
      ignores: [],
      updated: 2
    }
  },
  {
    desc: "Deeply nested parent rename",
    settings: {
      properties: [
        {
          name: "z",
          mappings: [
            { value: "a", folder: "A/B/C/D" },
            { value: "b", folder: "A/B/C/D/E" },
            { value: "c", folder: "A/B/X" }
          ]
        }
      ],
      ignoreFolders: []
    },
    oldPath: "A/B",
    newPath: "A/Z",
    expect: {
      mappings: [
        { folder: "A/Z/C/D" },
        { folder: "A/Z/C/D/E" },
        { folder: "A/Z/X" }
      ],
      ignores: [],
      updated: 3
    }
  },
  {
    desc: "ignoreFolders updated on rename",
    settings: {
      properties: [],
      ignoreFolders: ["Notes/Templates", "Scratch"]
    },
    oldPath: "Notes",
    newPath: "Journal",
    expect: {
      mappings: [],
      ignores: ["Journal/Templates", "Scratch"],
      updated: 1
    }
  },
  {
    desc: "autoUpdatePaths=false skips property",
    settings: {
      properties: [
        {
          name: "status",
          autoUpdatePaths: true,
          mappings: [{ value: "x", folder: "Notes/Inbox" }]
        },
        {
          name: "type",
          autoUpdatePaths: false,
          mappings: [{ value: "y", folder: "Notes/Types" }]
        }
      ],
      ignoreFolders: []
    },
    oldPath: "Notes",
    newPath: "Journal",
    expect: {
      mappings: [
        { folder: "Journal/Inbox" },  // updated (autoUpdatePaths=true)
        { folder: "Notes/Types" }     // unchanged (autoUpdatePaths=false)
      ],
      ignores: [],
      updated: 1
    }
  },
  {
    desc: "all properties disabled - no updates",
    settings: {
      properties: [
        {
          name: "a",
          autoUpdatePaths: false,
          mappings: [{ value: "x", folder: "Notes/A" }]
        }
      ],
      ignoreFolders: ["Notes/B"]
    },
    oldPath: "Notes",
    newPath: "Journal",
    expect: {
      mappings: [{ folder: "Notes/A" }],
      ignores: ["Journal/B"],  // ignores still update (no per-item flag)
      updated: 1
    }
  }
];

for (const test of renameTests) {
  const settings = deepClone(test.settings);
  const updated = simulateHandleFolderRename(settings, test.newPath, test.oldPath);
  const ok = updated === test.expect.updated;

  // Deep check actual values
  let valuesOk = true;
  let detail = '';

  if (ok) {
    // Check mapping values
    let i = 0;
    for (const group of settings.properties) {
      for (const m of (group.mappings || [])) {
        if (test.expect.mappings[i]) {
          if (m.folder !== test.expect.mappings[i].folder) {
            valuesOk = false;
            detail = `mapping[${i}]: expected ${test.expect.mappings[i].folder}, got ${m.folder}`;
          }
        }
        i++;
      }
    }
    // Check ignore values
    for (let j = 0; j < test.expect.ignores.length; j++) {
      if (settings.ignoreFolders[j] !== test.expect.ignores[j]) {
        valuesOk = false;
        detail = `ignore[${j}]: expected ${test.expect.ignores[j]}, got ${settings.ignoreFolders[j]}`;
      }
    }
  }

  const totalOk = ok && valuesOk;
  if (totalOk) pass++; else fail++;
  console.log(totalOk ? 'PASS' : 'FAIL', test.desc);
  if (!totalOk) {
    console.log(`  updated: expected ${test.expect.updated}, got ${updated}`);
    console.log(`  valuesOk: ${valuesOk} ${detail}`);
  }
}

// --- Operator matching tests (real FileProcessor.findMatchingMapping) ---
function simulateFindMatchingMapping(mappings, normalizedValues, settings) {
  const processor = makeProcessor({
    properties: [],
    mappings: [],
    caseInsensitiveMatching: !!settings.caseInsensitiveMatching
  });
  const result = processor.findMatchingMapping(mappings, normalizedValues, null, 'test');
  return result ? result.mapping : null;
}

const operatorTests = [
  { desc: "equals default (no operator field)",
    mappings: [{ value: "inbox", folder: "Inbox" }],
    values: ["inbox"], settings: {},
    expectFolder: "Inbox" },
  { desc: "equals no match",
    mappings: [{ value: "inbox", folder: "Inbox" }],
    values: ["archive"], settings: {},
    expectFolder: null },
  { desc: "equals case insensitive",
    mappings: [{ value: "inbox", folder: "Inbox", operator: "equals" }],
    values: ["INBOX"], settings: { caseInsensitiveMatching: true },
    expectFolder: "Inbox" },
  { desc: "equals case sensitive no match",
    mappings: [{ value: "inbox", folder: "Inbox", operator: "equals" }],
    values: ["INBOX"], settings: { caseInsensitiveMatching: false },
    expectFolder: null },
  { desc: "contains single value",
    mappings: [{ value: "task", folder: "Tasks", operator: "contains" }],
    values: ["my task note"], settings: {},
    expectFolder: "Tasks" },
  { desc: "contains no match",
    mappings: [{ value: "urgent", folder: "Urgent", operator: "contains" }],
    values: ["normal task"], settings: {},
    expectFolder: null },
  { desc: "contains in array",
    mappings: [{ value: "physics", folder: "Science", operator: "contains" }],
    values: ["tag1", "my physics note", "tag3"], settings: {},
    expectFolder: "Science" },
  { desc: "contains case insensitive",
    mappings: [{ value: "task", folder: "Tasks", operator: "contains" }],
    values: ["MY TASK"], settings: { caseInsensitiveMatching: true },
    expectFolder: "Tasks" },
  { desc: "is-empty matches empty",
    mappings: [{ value: "", folder: "Inbox", operator: "is-empty" }],
    values: [], settings: {},
    expectFolder: "Inbox" },
  { desc: "is-empty no match on value",
    mappings: [{ value: "", folder: "Inbox", operator: "is-empty" }],
    values: ["something"], settings: {},
    expectFolder: null },
  { desc: "is-not-empty matches value",
    mappings: [{ value: "", folder: "Categorized", operator: "is-not-empty" }],
    values: ["anything"], settings: {},
    expectFolder: "Categorized" },
  { desc: "is-not-empty no match on empty",
    mappings: [{ value: "", folder: "Categorized", operator: "is-not-empty" }],
    values: [], settings: {},
    expectFolder: null },
  { desc: "first matching operator wins",
    mappings: [
      { value: "draft", folder: "Drafts", operator: "equals" },
      { value: "", folder: "Inbox", operator: "is-empty" }
    ],
    values: ["draft"], settings: {},
    expectFolder: "Drafts" },
  { desc: "fallback to is-empty when equals misses",
    mappings: [
      { value: "draft", folder: "Drafts", operator: "equals" },
      { value: "", folder: "Inbox", operator: "is-empty" }
    ],
    values: [], settings: {},
    expectFolder: "Inbox" },
  { desc: "wildcard still works alongside operators",
    mappings: [
      { value: "high", folder: "Urgent", operator: "equals" },
      { value: "*", folder: "Normal" }
    ],
    values: ["medium"], settings: {},
    expectFolder: "Normal" }
];

for (const test of operatorTests) {
  const result = simulateFindMatchingMapping(test.mappings, test.values, test.settings);
  const actualFolder = result ? result.folder : null;
  const ok = actualFolder === test.expectFolder;
  if (ok) pass++; else fail++;
  console.log(ok ? 'PASS' : 'FAIL', test.desc);
  if (!ok) {
    console.log(`  expected: ${test.expectFolder}`);
    console.log(`  got:      ${actualFolder}`);
  }
}

// --- Matched-value tests: real findMatchingMapping return shape ---
const matchValueTests = [
  { desc: "equals returns the matched element",
    mappings: [{ value: 'note', folder: 'X' }],
    values: ['book', 'note'], settings: {}, expectValue: 'note' },
  { desc: "contains returns the matched element",
    mappings: [{ value: 'book', folder: 'X', operator: 'contains' }],
    values: ['note', 'bookish'], settings: {}, expectValue: 'bookish' },
  { desc: "wildcard returns null matchedValue",
    mappings: [{ value: '*', folder: 'X' }],
    values: ['book', 'note'], settings: {}, expectValue: null },
  { desc: "is-not-empty returns null matchedValue",
    mappings: [{ value: '', folder: 'X', operator: 'is-not-empty' }],
    values: ['a', 'b'], settings: {}, expectValue: null },
];

for (const test of matchValueTests) {
  const processor = makeProcessor({ properties: [], caseInsensitiveMatching: !!test.settings.caseInsensitiveMatching });
  const result = processor.findMatchingMapping(test.mappings, test.values, null, 'test');
  const actual = result ? result.matchedValue : null;
  const ok = actual === test.expectValue;
  if (ok) pass++; else fail++;
  console.log(ok ? 'PASS' : 'FAIL', test.desc);
  if (!ok) {
    console.log(`  expected: ${JSON.stringify(test.expectValue)}`);
    console.log(`  got:      ${JSON.stringify(actual)}`);
  }
}

// --- End-to-end target resolution: real findTargetFolder + interpolateVariables ---
const targetFolderTests = [
  { desc: "reported bug: wildcard + {type} on multi-value List",
    settings: { properties: [{ name: 'type', mappings: [{ value: '*', folder: 'Notes/{type}' }] }] },
    frontmatter: { type: ['book', 'note'] },
    expect: 'Notes/book' },
  { desc: "equals on later element uses matched value",
    settings: { properties: [{ name: 'type', mappings: [{ value: 'note', folder: 'Shelf/{type}' }] }] },
    frontmatter: { type: ['book', 'note'] },
    expect: 'Shelf/note' },
  { desc: "wildcard scalar unchanged",
    settings: { properties: [{ name: 'type', mappings: [{ value: '*', folder: 'Notes/{type}' }] }] },
    frontmatter: { type: 'book' },
    expect: 'Notes/book' },
  { desc: "static folder unaffected by multi-value",
    settings: { properties: [{ name: 'type', mappings: [{ value: '*', folder: 'Notes' }] }] },
    frontmatter: { type: ['book', 'note'] },
    expect: 'Notes' },
];

for (const test of targetFolderTests) {
  const processor = makeProcessor({ caseInsensitiveMatching: false, ...test.settings });
  const resolved = processor.findTargetFolder(test.frontmatter);
  const actual = resolved
    ? processor.interpolateVariables(resolved.targetFolder, test.frontmatter, null, {
        property: resolved.ruleName,
        value: resolved.ruleValue
      })
    : null;
  const ok = actual === test.expect;
  if (ok) pass++; else fail++;
  console.log(ok ? 'PASS' : 'FAIL', test.desc);
  if (!ok) {
    console.log(`  expected: ${test.expect}`);
    console.log(`  got:      ${actual}`);
  }
}

const total = unitTests.length + integrationTests.length + arrayInterpolationTests.length +
  renameTests.length + operatorTests.length + matchValueTests.length + targetFolderTests.length;
console.log(`\n${pass}/${total} passed`);
process.exit(fail > 0 ? 1 : 0);
