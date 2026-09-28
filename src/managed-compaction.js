const { ManagedModelError } = require('./managed-model');

const CHUNK_BYTES = 10000;
const CHUNK_MESSAGES = 16;
const MAX_SOURCE_MESSAGE_BYTES = 65536;

function shouldCompact(conversation) {
  if (!conversation) return false;
  const messages = conversation.messages || [];
  return (
    conversation.window?.truncated === true ||
    messages.length >= 30 ||
    Buffer.byteLength(JSON.stringify(messages)) >= 24000
  );
}

function targetSequence(conversation) {
  const messages = conversation.messages || [];
  if (messages.length > 12) return messages[messages.length - 13].seq;
  return conversation.window?.fromSeq ? conversation.window.fromSeq - 1 : 0;
}

function sourceChunk(messages) {
  const chunk = [];
  let bytes = 0;
  for (const message of messages) {
    const size = Buffer.byteLength(JSON.stringify(message));
    if (chunk.length && (chunk.length >= CHUNK_MESSAGES || bytes + size > CHUNK_BYTES)) break;
    if (!chunk.length && size > MAX_SOURCE_MESSAGE_BYTES) {
      throw new ManagedModelError('compaction_source_too_large');
    }
    chunk.push(message);
    bytes += size;
  }
  if (chunk.length > 1 && chunk.at(-1).role === 'user') chunk.pop();
  return chunk;
}

function compactionMessages(previousSummary, sources) {
  return [
    {
      role: 'system',
      content:
        'Compact the supplied conversation records into JSON only: {"facts":[{"value":{},"sourceSeqs":[1]}],"summary":"..."}. Preserve exact IDs, dates, quantities, preferences and commitments in facts. Each fact must cite source sequence numbers from these records. Never infer an action outcome from a request. Action outcomes are tracked separately; do not put them in facts. The summary must be brief and must preserve the meaning of the previous summary.'
    },
    {
      role: 'user',
      content: JSON.stringify({ previousSummary: previousSummary || null, sources })
    }
  ];
}

function parseCompaction(text, sources) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ManagedModelError('invalid_compaction');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !Array.isArray(parsed.facts) ||
    parsed.facts.length > 5 ||
    typeof parsed.summary !== 'string' ||
    !parsed.summary.trim() ||
    Buffer.byteLength(parsed.summary) > 4000
  ) {
    throw new ManagedModelError('invalid_compaction');
  }
  const validSequences = new Set(sources.map(message => message.seq));
  const facts = parsed.facts.map(fact => {
    if (
      !fact ||
      typeof fact !== 'object' ||
      Array.isArray(fact) ||
      !fact.value ||
      typeof fact.value !== 'object' ||
      Array.isArray(fact.value) ||
      Object.hasOwn(fact.value, 'actionOutcome') ||
      !Array.isArray(fact.sourceSeqs) ||
      fact.sourceSeqs.length < 1 ||
      fact.sourceSeqs.length > 16 ||
      new Set(fact.sourceSeqs).size !== fact.sourceSeqs.length ||
      fact.sourceSeqs.some(seq => !Number.isSafeInteger(seq) || !validSequences.has(seq)) ||
      Buffer.byteLength(JSON.stringify(fact.value)) > 2048
    ) {
      throw new ManagedModelError('invalid_compaction');
    }
    return { value: fact.value, sourceSeqs: fact.sourceSeqs };
  });
  return { facts, summary: parsed.summary.trim() };
}

function factItems(fact) {
  return Array.isArray(fact.value?.items)
    ? fact.value.items
    : [{ value: fact.value, sourceSeqs: fact.sourceSeqs }];
}

function consolidateFacts(existing, generated) {
  if (existing.length + generated.length <= 100) {
    return { factsAdd: generated, factsRemove: [] };
  }
  const candidates = existing.filter(
    fact =>
      typeof fact.id === 'string' &&
      !Object.hasOwn(fact.value || {}, 'actionOutcome') &&
      Array.isArray(fact.sourceSeqs)
  );
  const removed = new Set();
  const replacements = [];
  while (existing.length - removed.size + generated.length + replacements.length > 100) {
    let pair = null;
    for (let i = 0; i < candidates.length && !pair; i++) {
      if (removed.has(candidates[i].id)) continue;
      for (let j = i + 1; j < candidates.length; j++) {
        if (removed.has(candidates[j].id)) continue;
        const items = [...factItems(candidates[i]), ...factItems(candidates[j])];
        const sourceSeqs = [...new Set(items.flatMap(item => item.sourceSeqs))].sort(
          (a, b) => a - b
        );
        const value = { items };
        if (sourceSeqs.length <= 64 && Buffer.byteLength(JSON.stringify(value)) <= 2048) {
          pair = { left: candidates[i], right: candidates[j], value, sourceSeqs };
          break;
        }
      }
    }
    if (!pair || generated.length + replacements.length + 1 > 20) {
      throw new ManagedModelError('memory_capacity');
    }
    removed.add(pair.left.id);
    removed.add(pair.right.id);
    replacements.push({ value: pair.value, sourceSeqs: pair.sourceSeqs });
  }
  return { factsAdd: [...generated, ...replacements], factsRemove: [...removed] };
}

module.exports = {
  shouldCompact,
  targetSequence,
  sourceChunk,
  compactionMessages,
  parseCompaction,
  consolidateFacts
};
