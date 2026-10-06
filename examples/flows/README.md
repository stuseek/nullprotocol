# Flows

Three small workflows in the shape the [benchmark](../../bench/README.md) measures: the model reads text into a strict schema with `extract`, and your code does the arithmetic and applies the rules.

| File | The model reads | The code does |
| --- | --- | --- |
| [refund.mjs](refund.mjs) | Whether the item was used, from the customer's message | The refund policy: window, restocking fee, escalation limit |
| [invoice.mjs](invoice.mjs) | Product lines, discount and tax | Subtotal and total |
| [sla.mjs](sla.mjs) | When a ticket was opened and its priority | The deadline in business hours |

They run on a local model with no account and no key:

```sh
ollama pull qwen2.5:3b-instruct
node examples/flows/refund.mjs
```

`NULLPROTOCOL_MODEL` and `NULLPROTOCOL_MODEL_URL` choose another model or server; [model.mjs](model.mjs) holds the one client all three share. In your own project, import from `nullprotocol` the same way.

A schema check catches a malformed reply, not a wrong reading: on the benchmark's invoices a 3B model misread one line in twelve. Check amounts that matter against a second source.
