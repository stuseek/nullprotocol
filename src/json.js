// JSON recovery shared by the primitives and managed runs: strips a Markdown
// fence, then takes the first complete JSON value if the model added prose.
function parseJSON(response) {
  if (typeof response === 'object') return response;
  const cleaned = response
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    // Models sometimes prefix JSON with a short explanation. Find the first
    // complete value without treating brackets inside JSON strings as syntax.
  }

  for (let start = 0; start < cleaned.length; start++) {
    if (cleaned[start] !== '{' && cleaned[start] !== '[') continue;
    const closing = [cleaned[start] === '{' ? '}' : ']'];
    let quoted = false;
    let escaped = false;
    let candidateEnd = null;
    for (let i = start + 1; i < cleaned.length; i++) {
      const char = cleaned[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{') closing.push('}');
      else if (char === '[') closing.push(']');
      else if (char === '}' || char === ']') {
        if (closing.pop() !== char) {
          throw new Error('Mismatched JSON brackets');
        }
        if (closing.length === 0) {
          candidateEnd = i;
          try {
            return JSON.parse(cleaned.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
    if (candidateEnd === null) break;
    start = candidateEnd;
  }
  throw new Error('No complete JSON value');
}

module.exports = { parseJSON };
