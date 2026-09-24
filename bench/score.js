const { isDeepStrictEqual } = require('node:util');

function normalize(value) {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return /^\d{1,2}:\d{2}(?::\d{2})?(?:\s+utc|z)$/.test(normalized)
      ? normalized.replace(/(?:\s+utc|z)$/, '')
      : normalized;
  }
  return value;
}

function score(task, payload, toolCalls = [], answer = '') {
  if (task.category === 'tool') {
    const expectedText = task.expectedText?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const answerCorrect = task.expectedAnswer
      ? normalize(answer) === normalize(task.expectedAnswer)
      : typeof answer === 'string' &&
        new RegExp(`(^|[^a-z0-9])${expectedText}(?=$|[^a-z0-9])`, 'i').test(answer) &&
        !(task.forbiddenAnswers || []).some(phrase =>
          answer.toLowerCase().includes(phrase.toLowerCase())
        );
    return (
      toolCalls.length === 1 &&
      toolCalls[0].name === task.expectedCall.name &&
      isDeepStrictEqual(toolCalls[0].arguments, task.expectedCall.arguments) &&
      answerCorrect
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
