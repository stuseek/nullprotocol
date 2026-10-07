# Workflow benchmark

48 everyday back-office tasks, run three ways on each model: one direct prompt, one direct prompt with step-by-step reasoning, and a flow where the model only reads text into a strict schema with `extract` and your code does the arithmetic and applies the rules.

Results from 2026-10-06, source commit `71cb1f3` plus this directory, one run per task:

| Model              | Direct | Direct, reasoning | NullProtocol flow |
| ------------------ | -----: | ----------------: | ----------------: |
| Qwen 2.5 3B, local |   3/48 |             10/48 |             47/48 |
| Qwen 2.5 7B, local |   9/48 |             18/48 |             48/48 |
| Mistral Large 3    |  13/48 |             44/48 |             48/48 |

By family, flow arm: invoices 11/12 on Qwen 3B and 12/12 on the other two; refunds, SLA deadlines and the ticket queue 12/12 on all three. The one Qwen 3B miss is an invoice line read wrongly; the flow accepted it, so check totals that matter against a second source.

Median time per task in the flow arm: 3.8 s for Qwen 3B and 6.2 s for Qwen 7B on one laptop, 2.6 s for Mistral Large 3 over its API. The flow makes 60 model calls for the 48 tasks: two per invoice, one for every other task.

## What the tasks are

`tasks.mjs` defines 12 tasks in each of four families. Gold answers are computed by code in the same file.

- **Invoice**: 4 to 8 product lines, an optional discount and a sales tax. Asked for the subtotal and the total.
- **Refund**: a shop policy (30-day window, 14 days for electronics, 15% fee on opened items, escalate above $200), the order record, and a customer message. Asked for refund, deny or escalate, and the amount.
- **SLA**: a ticket with its opening time and priority. Asked for the resolution deadline in business hours, Monday to Friday, 09:00 to 18:00.
- **Queue**: 18 to 22 tickets. Asked which ones have a given status and are older than a given number of days.

## The three arms

- **Direct**: one prompt with the whole problem and the answer shape. The answer is the last complete JSON object in the reply.
- **Direct, reasoning**: the same prompt, with the model told to show every calculation first and up to 3,000 output tokens.
- **Flow**: `extract` reads the text into a JSON Schema (product lines and terms; whether the item was used; opening time and priority; the ticket rows). Code then sums, compares dates and applies the policy. The refund flow takes category, price and delivery date from the order record, not from the model.

Both direct arms and the flow see the same task text. Local models run at temperature 0 with an 8,192-token context through Ollama; Mistral runs at temperature 0 through its API.

## How to read this

- The flow moves arithmetic, dates and rules out of the model and into code. The gain comes from that split, which `extract` and its schema checks make short to write; this run has no arm with the same flow written without the SDK.
- The flows were tuned while the set was being written: the refund flow on the first five refund cases, the invoice flow on a first batch of generated invoices. That batch was then replaced by invoices the flow had not seen (8 of 9 correct on Qwen 3B). The SLA and queue flows and the later refund cases ran unchanged from their first version.
- The refund policy and the business-hours rule are written by hand in the flow. A task whose rule cannot be put in code is outside this benchmark.
- Each task ran once per arm. The tasks are synthetic and share patterns, so these are counts on this set, not a general measure of any model.
- The first Qwen 7B flow run scored 40/48: eight queue tasks hit the SDK's 30-second request timeout on the test machine. The published run uses a 180-second timeout.
- The published flow rows predate token reporting in `extract`, so they list calls and time only; a new run records tokens too.

## Run it

```sh
ollama pull qwen2.5:3b-instruct
ollama create nullprotocol-bench-qwen3b -f bench/modelfiles/qwen3b.Modelfile
npm run bench -- ollama nullprotocol-bench-qwen3b flow
npm run bench -- ollama nullprotocol-bench-qwen3b direct
npm run bench -- ollama nullprotocol-bench-qwen3b reasoning
```

Use `mistral <model>` with `MISTRAL_API_KEY` or `anthropic <model>` with `ANTHROPIC_API_KEY` for hosted models; `.env` is read when present. Each run writes `bench/results/<model>.<arm>.jsonl`: a summary line, then one row per task with the model's reply, the parsed answer, the gold answer and the time. `RESCORE=1` re-scores a stored file without calling the model. The published rows are in [published](published).
