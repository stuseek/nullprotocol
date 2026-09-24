const { isDeepStrictEqual } = require('node:util');

function normalize(value) {
  if (typeof value === 'string') {
    return value
      .trim()
      .toLowerCase()
      .replace(/(?:\s+utc|z)$/, '');
  }
  return value;
}

function score(task, payload, toolCalls = [], answer = '') {
  if (task.category === 'tool') {
    return (
      toolCalls.length === 1 &&
      toolCalls[0].name === task.expectedCall.name &&
      isDeepStrictEqual(toolCalls[0].arguments, task.expectedCall.arguments) &&
      typeof answer === 'string' &&
      answer.toLowerCase().includes(task.expectedText.toLowerCase()) &&
      !(task.forbiddenAnswers || []).some(phrase => answer.toLowerCase().includes(phrase))
    );
  }
  if (task.category === 'decide') {
    return payload?.action === task.expected;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  const expectedKeys = Object.keys(task.expected).sort();
  if (!isDeepStrictEqual(Object.keys(payload).sort(), expectedKeys)) {
    return false;
  }
  return expectedKeys.every(key =>
    isDeepStrictEqual(normalize(payload[key]), normalize(task.expected[key]))
  );
}

module.exports = { score };
