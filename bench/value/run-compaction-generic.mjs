#!/usr/bin/env node
// Pilot: the SDK's compaction prompt (base) against a domain-agnostic one
// (generic) on four hand-written chunks, local models only. Exactly
// chunks × 2 prompts × models × reps calls, no repair, no judge. The user
// message is what the SDK sends today: { previousSummary, sources }.
//
//   node bench/value/run-compaction-generic.mjs OUT.jsonl [--reps 2]
import { appendFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reason } from './compaction-checks.mjs';
import { modelURL } from './arms.mjs';

const require = createRequire(import.meta.url);
const { chunks, genericPrompt } = require('./compaction-generic');
const { compactionMessages } = require('../../src/managed-compaction');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = process.argv[2];
const repsAt = process.argv.indexOf('--reps');
const reps = repsAt === -1 ? 2 : Number(process.argv[repsAt + 1]);
const models = ['np-value-q3', 'np-value-q7'];
if (!out || existsSync(out)) throw new Error('Give a new output file');

const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
appendFileSync(
  out,
  `${JSON.stringify({
    manifest: {
      kind: 'compaction-generic-v1',
      commit: git(['rev-parse', 'HEAD']),
      dirty: Boolean(git(['status', '--porcelain', '--', 'bench/value', 'src'])),
      modelURL,
      models,
      reps,
      calls: chunks.length * 2 * models.length * reps,
      prompts: { base: compactionMessages(null, [])[0].content, generic: genericPrompt }
    }
  })}\n`
);

for (let rep = 0; rep < reps; rep++) {
  for (const model of models) {
    for (const chunk of chunks) {
      for (const arm of ['base', 'generic']) {
        const [system, user] = compactionMessages(null, chunk.sources);
        const messages = [
          arm === 'base' ? system : { role: 'system', content: genericPrompt },
          user
        ];
        const started = Date.now();
        const response = await fetch(`${modelURL}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages, max_tokens: 1024 })
        });
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content ?? '';
        const checked = reason(content, chunk.sources);
        const row = {
          reviewId: `${chunk.id}-${arm}-${model}-r${rep}`,
          chunk: chunk.id,
          arm,
          model,
          rep,
          ms: Date.now() - started,
          inputTokens: data.usage?.prompt_tokens ?? null,
          outputTokens: data.usage?.completion_tokens ?? null,
          valid: checked.reason === 'valid',
          reason: checked.reason,
          facts: checked.parsed?.facts ?? null,
          summary: checked.parsed?.summary ?? null,
          content
        };
        appendFileSync(out, `${JSON.stringify(row)}\n`);
        console.log(`${row.reviewId}: ${row.reason} ${row.facts?.length ?? '-'} facts ${row.ms}ms`);
      }
    }
  }
}
