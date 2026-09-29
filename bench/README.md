# Local comparison pilot

This is a small development sample for finding failures, not evidence for a model-parity claim. It uses 12 fixed tasks: extraction, action choice, tool use, and retrieval from a longer input. The direct arm calls Ollama's OpenAI-compatible endpoint with the **same prompts and sampling settings** as the SDK arm, then uses `JSON.parse` without shape checks. The SDK arm uses its normal parsing, schema checks, action allowlist, and tool loop. Each structured task gets one model call; a tool task gets at most three.

The scorer in `score.js` checks task facts independently of the SDK's `success` flag. `accepted` means parseable JSON in the direct arm and validated output in the SDK arm, so compare `correct` separately. `silentWrong` means an arm accepted an incorrect answer. Tool scoring requires both the expected tool call and a consistent final answer. The fixture has only two tool tasks and a simple text check; inspect those raw outputs. The sample is too small for a marketing percentage or an assertion that 3B matches 7B. Ollama's reported prompt tokens and latency can vary with prompt caching.

The [recorded pilot](published/local-pilot-2026-09-24.jsonl) ran against commit `020e413` on September 24, 2026. Each model and arm saw each task once:

| Local model | Direct call | SDK |
| --- | ---: | ---: |
| Qwen 2.5 3B Instruct | 7/12 correct | 11/12 correct |
| Qwen 2.5 7B Instruct | 12/12 correct | 12/12 correct |

The four 3B decision outputs were correct decisions wrapped in single-element arrays; the SDK unwrapped and checked them. Both arms repeated the same wrong status after an order lookup with 3B. These are development tasks, not a held-out evaluation. Inspect the raw rows with `npm run bench:report -- bench/published/local-pilot-2026-09-24.jsonl`.

Install the OpenAI peer dependency, then prepare the two local models. The derived names set an 8192-token context window without copying model weights:

```sh
ollama pull qwen2.5:3b-instruct
ollama pull qwen2.5:7b-instruct
ollama create nullprotocol-bench-qwen3b -f bench/modelfiles/qwen3b.Modelfile
ollama create nullprotocol-bench-qwen7b -f bench/modelfiles/qwen7b.Modelfile
npm run bench:local
npm run bench:report -- bench/results/PILOT_FILE.jsonl
```

The runner refuses a nonlocal endpoint or a model without `num_ctx 8192`. It records the model digests, source and task hashes, every model response, finish reason, token counts when reported, and per-task scores. Raw runs stay under ignored `bench/results/`; inspect them before sharing. Do not put private application data in tasks.

For a publishable comparison, follow [the larger benchmark plan](https://github.com/stuseek/nullprotocol-web/blob/main/docs/benchmark-plan.md): freeze a held-out set before running it, use enough tasks per category, account for context truncation and model calls, and publish prompts, raw rows, and uncertainty intervals.

## Frozen 48-task comparison

`frozen-tasks.js` defines 12 tasks each for extraction, action choice, tool use, and retrieval from a noisy document. This set extends patterns explored in the pilot, so it is **not independent held-out data**. Freeze and review the tasks, runner, and scorer in a commit before running either model. Then use the same local setup as above and run `npm run bench:frozen`; the runner writes raw JSONL under ignored `bench/results/`. Use `npm run bench:report -- PATH` on the result. The report verifies the task hash, source commit, and expected rows. For structured tasks it compares direct JSON parsing, provider JSON mode, and the SDK; tool tasks use direct and SDK only. Publish the raw output and exact source commit with any task-specific results. One run per task is not a general model-quality estimate.

The first [frozen run and interpretation](published/frozen-qwen-2026-09-24.md) are published with the [raw results](published/frozen-qwen-2026-09-24.jsonl). In this set, SDK parsing recovered three 3B decisions wrapped in single-element arrays; direct JSON mode matched SDK's strict score on every structured task. Wrong action choices still passed the SDK allowlist. The interpretation separates strict tool-output formatting from whether the correct tool and fact were used.

## Frozen tasks on Claude

`bench/run-anthropic.js` runs the same 48 tasks and prompts against Claude, with a direct Messages API arm (`JSON.parse` only) and the SDK arm. Both arms get the frozen call budgets (1 structured, 3 tool), no transport retries and a 120-second timeout; the direct-json arm is omitted because the Messages API has no schema-less JSON mode. The runner sends no sampling parameters; thinking and effort stay at each model's own default, and each call may use 4,096 output tokens instead of the local run's 280. That difference belongs in any interpretation, and a run is not a model-parity claim.

Commit the source, set `ANTHROPIC_API_KEY`, and choose models explicitly:

```sh
NULLPROTOCOL_BENCH_MODELS=claude-opus-5 npm run bench:anthropic
node bench/run-anthropic.js --report bench/results/frozen-anthropic-TIMESTAMP.jsonl
```

Run the report from a source checkout: it checks the task hash and that the source commit exists, requires exactly one row per model, task and arm, re-scores every row and its `silentWrong` flag, and prints correct answers per model, arm and category with the number of accepted but wrong answers.
