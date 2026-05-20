/**
 * Strip [[wiki-link]] wrapper from a string value.
 * Handles: [[Name]], [[Name|Alias]], [[Name#heading]]
 * Leaves plain text and partial links unchanged.
 * @param {string} value
 * @returns {string}
 */
function stripWikiLink(value) {
  const match = value.match(/^\[\[([^\]\|]+)(?:\|.*)?\]\]$/);
  return match ? match[1] : value;
}

module.exports = stripWikiLink;
