// node bench/run.mjs <ollama|mistral|anthropic> <model> <direct|reasoning|flow>
// Writes bench/results/<model>.<arm>.jsonl: a summary line, then one row per task with the model's reply.
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tasks, refundRule, slaDeadline, days, r2 } from './tasks.mjs';
const require = createRequire(import.meta.url);
const results = new URL('./results/', import.meta.url);
const [provider, model, arm] = process.argv.slice(2);
const local = provider === 'ollama';
// Ollama and Mistral both speak the OpenAI chat API.
const compatible = {
  ollama: { baseURL: 'http://127.0.0.1:11434/v1', apiKey: 'ollama' },
  mistral: { baseURL: 'https://api.mistral.ai/v1', apiKey: process.env.MISTRAL_API_KEY }
}[provider];
const usage = { calls: 0, input: 0, output: 0 };

// Direct arms: one prompt with the whole problem, the answer taken from the last JSON object in the reply.
const SYSTEM = {
  direct: 'You are a careful operations assistant. Answer with one JSON object only.',
  reasoning:
    'You are a careful operations assistant. First reason step by step, showing every calculation. Then write FINAL: followed by one JSON object.'
};
async function ask(system, user, maxTokens) {
  usage.calls += 1;
  if (compatible) {
    const OpenAI = require('openai');
    const client = new OpenAI(compatible);
    const res = await client.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    });
    usage.input += res.usage?.prompt_tokens ?? 0;
    usage.output += res.usage?.completion_tokens ?? 0;
    return res.choices[0].message.content;
  }
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new (Anthropic.default ?? Anthropic)({ apiKey: process.env.ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }]
  });
  usage.input += res.usage.input_tokens;
  usage.output += res.usage.output_tokens;
  return res.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
}
// The last complete JSON object in the reply, so reasoning text, Markdown fences and earlier drafts do not count against the model.
export const lastJson = text => {
  for (let end = text.lastIndexOf('}'); end >= 0; end = text.lastIndexOf('}', end - 1)) {
    for (
      let start = text.lastIndexOf('{', end);
      start >= 0;
      start = text.lastIndexOf('{', start - 1)
    ) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        /* try a wider slice */
      }
    }
  }
  return null;
};

// Flow arm: the model reads the text into a strict schema with NullProtocol extract; code computes and applies the rules.
const { NullProtocol } = require('..');
const ai =
  arm === 'flow'
    ? await NullProtocol.create(
        compatible
          ? {
              provider: 'openai-compatible',
              ...compatible,
              model,
              temperature: 0,
              maxTokens: 2000,
              timeout: 180000
            }
          : {
              provider: 'anthropic',
              apiKey: process.env.ANTHROPIC_API_KEY,
              model,
              maxTokens: 2000,
              timeout: 180000
            }
      )
    : null;
const extract = async (text, schema) => {
  usage.calls += 1;
  const r = await ai.extract(text, schema);
  usage.input += r.usage?.inputTokens ?? 0;
  usage.output += r.usage?.outputTokens ?? 0;
  if (!r.success) throw new Error(r.error);
  return r.data;
};
const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const flows = {
  // Two narrow reads: the product lines, then the terms printed under them.
  async invoice(t) {
    const lines = await extract(t.material, {
      type: 'object',
      required: ['items'],
      properties: {
        items: {
          type: 'array',
          description:
            'Only the product lines that have a quantity and a unit price. Not the discount or tax lines.',
          items: {
            type: 'object',
            required: ['name', 'quantity', 'unitPrice'],
            properties: {
              name: {
                type: 'string',
                description: 'The full product name as printed, including any numbers in it'
              },
              quantity: { type: 'number', description: 'The number after "qty"' },
              unitPrice: { type: 'number', description: 'The price after "at"' }
            }
          }
        }
      }
    });
    const terms = await extract(t.material, {
      type: 'object',
      required: ['discountPercent', 'taxPercent'],
      properties: {
        discountPercent: {
          type: 'number',
          description:
            'The number written before the % sign on the discount line, for example 10 for "10% off". 0 when the invoice has no discount line.'
        },
        taxPercent: {
          type: 'number',
          description:
            'The number written before the % sign on the sales tax line, for example 8.5 for "8.5%".'
        }
      }
    });
    const subtotal = r2(lines.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0));
    return {
      subtotal,
      total: r2(subtotal * (1 - terms.discountPercent / 100) * (1 + terms.taxPercent / 100))
    };
  },
  // The order system is the source for category, price and delivery date; the model only reads the message.
  async refund(t) {
    const d = await extract(t.material.split('Customer message:\n')[1], {
      type: 'object',
      required: ['evidence', 'condition'],
      properties: {
        evidence: {
          type: 'string',
          description: 'The exact words of the customer about the state of the item'
        },
        condition: {
          type: 'string',
          enum: ['untouched', 'used'],
          description:
            'untouched: still sealed, wrapped, never unpacked, or tags still on. used: opened, assembled, set up, built or tried.'
        }
      }
    });
    return refundRule({ ...t.raw, opened: d.condition === 'used' });
  },
  async sla(t) {
    const d = await extract(t.material.split('\n\n')[1], {
      type: 'object',
      required: ['createdAt', 'priority'],
      properties: {
        createdAt: {
          type: 'string',
          description: 'When the ticket was opened, as YYYY-MM-DDTHH:MM',
          pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$'
        },
        priority: { type: 'string', enum: ['P1', 'P2', 'P3'] }
      }
    });
    return { deadline: slaDeadline(d.createdAt, d.priority) };
  },
  async queue(t) {
    const d = await extract(t.material, {
      type: 'object',
      required: ['today', 'tickets'],
      properties: {
        today: DATE,
        tickets: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'status', 'created'],
            properties: {
              id: { type: 'string' },
              status: { type: 'string', enum: ['open', 'closed', 'pending'] },
              created: DATE
            }
          }
        }
      }
    });
    const ids = d.tickets
      .filter(x => x.status === t.raw.status && days(x.created, d.today) > t.raw.min)
      .map(x => x.id)
      .sort();
    return { ids, count: ids.length };
  }
};

if (process.env.RESCORE) {
  const { readFileSync } = await import('node:fs');
  const file = new URL(`${model.replace(/[^a-z0-9.]+/gi, '-')}.${arm}.jsonl`, results);
  const [summary, ...old] = readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l));
  const rows = old.map(r => {
    const t = tasks.find(x => x.id === r.id);
    const answer = r.text ? lastJson(r.text) : r.answer;
    const ok = !!answer && !!t.check(answer, t.gold);
    return {
      ...r,
      answer,
      ok,
      error: null,
      outcome: ok ? 'correct' : answer ? 'wrong' : 'no answer'
    };
  });
  const by = {};
  rows.forEach(r => {
    by[r.family] ??= [0, 0];
    by[r.family][1] += 1;
    by[r.family][0] += r.ok;
  });
  Object.assign(summary, {
    correct: rows.filter(r => r.ok).length,
    wrong: rows.filter(r => r.outcome === 'wrong').length,
    noAnswer: rows.filter(r => r.outcome === 'no answer').length,
    families: Object.fromEntries(Object.entries(by).map(([k, [a, b]]) => [k, `${a}/${b}`]))
  });
  writeFileSync(file, [summary, ...rows].map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log(JSON.stringify(summary));
  process.exit(0);
}
const rows = [];
const only = process.env.ONLY;
for (const t of tasks.filter(t => !only || t.family === only)) {
  if (!local) await new Promise(r => setTimeout(r, 1200));
  const start = Date.now();
  const before = { ...usage };
  let answer = null,
    error = null,
    text;
  try {
    if (arm === 'flow') answer = await flows[t.family](t);
    else {
      text = await ask(
        SYSTEM[arm],
        `${t.material}\n\n${t.question}\nAnswer as JSON: ${t.shape}`,
        arm === 'reasoning' ? 3000 : 600
      );
      answer = lastJson(text);
    }
  } catch (e) {
    error = e.message;
  }
  const ok = !!answer && !!t.check(answer, t.gold);
  rows.push({
    id: t.id,
    family: t.family,
    ok,
    outcome: ok ? 'correct' : error || !answer ? 'no answer' : 'wrong',
    gold: t.gold,
    answer,
    error,
    text,
    ms: Date.now() - start,
    calls: usage.calls - before.calls,
    input: usage.input - before.input,
    output: usage.output - before.output
  });
  console.log(
    ok ? 'PASS' : error ? 'ERR ' : 'FAIL',
    t.id,
    JSON.stringify(answer ?? error ?? text).slice(0, 150)
  );
}
const by = {};
rows.forEach(r => {
  by[r.family] ??= [0, 0];
  by[r.family][1] += 1;
  by[r.family][0] += r.ok;
});
const summary = {
  provider,
  model,
  arm,
  correct: rows.filter(r => r.ok).length,
  wrong: rows.filter(r => r.outcome === 'wrong').length,
  noAnswer: rows.filter(r => r.outcome === 'no answer').length,
  total: rows.length,
  families: Object.fromEntries(Object.entries(by).map(([k, [a, b]]) => [k, `${a}/${b}`])),
  ...usage,
  medianMs: [...rows].sort((a, b) => a.ms - b.ms)[Math.floor(rows.length / 2)].ms,
  at: new Date().toISOString()
};
console.log(JSON.stringify(summary));
mkdirSync(results, { recursive: true });
writeFileSync(
  new URL(`${model.replace(/[^a-z0-9.]+/gi, '-')}.${arm}.jsonl`, results),
  [summary, ...rows].map(r => JSON.stringify(r)).join('\n') + '\n'
);
