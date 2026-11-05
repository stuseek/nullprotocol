# Knowledge

Available with SDK 2.3 and a server that has Knowledge enabled. Existing calls do not search Knowledge unless they request it.

An agent's Knowledge consists of its own documents and documents explicitly connected from its Space's library. Adding a shared document does not give every agent access to it. Sources from another agent or another Space are not searched. Equal titles do not replace one another: connections refer to document IDs.

Knowledge has Space and agent ownership, not per-`conversation` sources. A data scope ID does not change the agent's connected source set. Use scoped Context for entity-specific saved data.

In the cabinet, use **Knowledge** in the left menu for the shared library, or the agent's **Knowledge** tab for its own documents and connections. Add text or select a UTF-8 TXT/Markdown file, up to 1 MiB. Preparation is asynchronous. A replacement keeps the preceding prepared revision in use until the complete replacement is ready. An unprepared new connected source refuses Knowledge calls until preparation succeeds; ordinary calls continue normally.

```js
const extracted = await agent.extract(
  'Within how many days can unused goods be returned?',
  { days: 'number' },
  { knowledge: true }
);

const checked = await agent.validate(
  'Every claim must be supported by the supplied policies.',
  'Gift cards can be returned.',
  { knowledge: true }
);

const decision = await agent.decide(
  'The buyer wants to return a personalised mug.',
  ['request_details', 'send_to_support'],
  { knowledge: { query: 'Exceptions to the returns policy for personalised items' } }
);

const summary = await agent.summarize(message, {
  knowledge: { query: 'Returns terminology and product categories' }
});
```

`knowledge: true` derives a query from the substantive input: extract's data, summarize's content, decide's context, or validate's subject and criteria. It does not use the output schema, offered actions or agent instructions as the query. An explicit `{ query }` supplies the query directly. It must be non-empty and fit both 2000 UTF-16 characters and 6000 UTF-8 bytes. Longer inputs need an explicit short query; the operation input is never shortened to make it fit. Omitted or `false` means no Knowledge search.

The same option is accepted by the HTTP operation endpoint. Try agent exposes **Search Knowledge** and an optional query; Connect preserves both in its SDK and HTTP examples. A standalone agent without a saved Space cannot search hosted Knowledge.

Selected passages are reference data alongside existing Context. Knowledge does not convert or remove your saved reference texts, named data or notes. The selected material has its own bounded budget of 6000 UTF-16 characters including per-passage source labels; the existing reference-text budget is separate. The assembled prompt can still exceed the model's limits, in which case the operation fails without cutting mandatory input or context.

An explicit `validate.reference` remains present when Knowledge is requested. Search does not establish that an answer is absent or that all rules and exceptions were found. `validate` still returns the model's pass/fail/conditional recommendation. `summarize(content)` summarizes that content; selecting a few passages is not a summary of a whole document or library.

## Results and History

When a selection succeeds, `result.knowledge` contains the actual query, embedding profile, source names and revisions, and the exact passages with `[start, end)` UTF-16 ranges into each original revision. This describes material supplied to the operation; it does not prove the model used or correctly interpreted every passage. Repair attempts and an explicit handler `reply()` use that same selection. Returning an action's prepared parameters does not perform another search or generation.

History keeps an immutable server-issued snapshot. Editing, disconnecting, deleting or reindexing a document does not rewrite the selected evidence of an existing operation. The content follows the existing owner/admin access rules and operation retention period.

| Error code | Meaning |
| --- | --- |
| `invalid_knowledge_option` | Use a boolean or `{ query: string }`. |
| `knowledge_query_required` | A usable non-empty query is required. |
| `knowledge_query_too_large` | Supply a shorter explicit query. The operation input was not truncated. |
| `knowledge_empty` | This agent has no connected Knowledge sources. |
| `knowledge_not_ready` | Required source indexes are not ready. |
| `knowledge_prepare_failed` | A new connected source could not be prepared; retry preparation in the cabinet. |
| `knowledge_unavailable`, `knowledge_busy` | Search could not run. Retry later. |
| `knowledge_changed` | Source access changed while search was running. Retry the operation. |
| `knowledge_no_evidence` | No passages could be selected; this is not proof that the answer is absent. |

Search failures stop generation. They do not silently become a call without Knowledge.

## Data and usage

NullProtocol sends document sections and search queries to Mistral's embedding API (`mistral-embed-2312`). Vectors and source text are stored in the Space's Postgres database. Selected passages are then sent to the agent's configured generation model. There is no additional generative call to formulate search terms, no embedded encoder process, and no automatic memory write.

Embedding input tokens are counted separately from `result.usage`, which remains generation usage. `result.knowledgeUsage` includes reported search embedding usage or an uncounted request, including a failed search; the Space library shows preparation and search totals for the last 30 days. Unknown embedding usage remains unknown. This release does not introduce customer embedding charges or change credit billing.

Preparation reuses an identical text only within the same Space and embedding profile. Limits are 20 live documents per library/agent and 64 across a Space. Preparation resumes after a process restart, retries transient failures up to five attempts, and supports an explicit retry. Exact cosine search is used over permitted sources; no corpus-wide approximate index or complete-coverage guarantee is implied.
