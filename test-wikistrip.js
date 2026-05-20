// Test: stripWikiLink
// Tests the actual function used by main.js (lib/strip-wiki-link.js)
// Run: node test-wikistrip.js

const stripWikiLink = require('./lib/strip-wiki-link');

// --- stripWikiLink unit tests ---
const unitTests = [
  // [input, expected, description]
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

// --- Integration: full interpolateVariables pipeline ---
// Replicates the exact interpolation logic from main.js
// Uses the SAME stripWikiLink import — verifies the function
// behaves correctly when called from the interpolation path.
function interpolateVariables(path, frontmatter) {
  return path.replace(/{(\w+)}/g, (match, propName) => {
    const value = frontmatter[propName];
    if (value === null || value === undefined) return match;
    let normalized = String(value).trim();
    if (!normalized) return match;
    normalized = stripWikiLink(normalized);
    return normalized;
  });
}

const integrationTests = [
  // [path, frontmatter, expected, description]
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

const total = unitTests.length + integrationTests.length;
console.log(`\n${pass}/${total} passed`);
process.exit(fail > 0 ? 1 : 0);
