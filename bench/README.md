# Local comparison pilot

This is a small development sample for finding failures, not evidence for a model-parity claim. It uses 12 fixed tasks: extraction, action choice, tool use, and retrieval from a longer input. The direct arm calls Ollama's OpenAI-compatible endpoint with the **same prompts and sampling settings** as the SDK arm, then uses `JSON.parse` without shape checks. The SDK arm uses its normal parsing, schema checks, action allowlist, and tool loop. Each structured task gets one model call; a tool task gets at most three.

The scorer in `score.js` checks task facts independently of the SDK's `success` flag. `accepted` means parseable JSON in the direct arm and validated output in the SDK arm, so compare `correct` separately. `silentWrong` means an arm accepted an incorrect answer. Tool scoring requires both the expected tool call and a consistent final answer. The fixture has only two tool tasks and a simple text check; inspect those raw outputs. The sample is too small for a marketing percentage or an assertion that 3B matches 7B. Ollama's reported prompt tokens and latency can vary with prompt caching.

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
