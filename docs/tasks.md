# Saved tasks

A task is one operation saved on the agent together with what your code would otherwise send on every call: the extraction schema, the validation criteria or the offered actions. Your code names the task and sends the input. Anyone with Editor access can then change the task in the cabinet, and the next run uses the change without a deployment.

```js
await agent.tasks.set('read-request', {
  operation: 'extract',
  schema: { orderId: 'number', problem: 'string' }
});

const result = await agent.run('read-request', 'Order 1042 arrived with a broken mug.');
// { success: true, data: { orderId: 1042, problem: 'broken mug' },
//   task: { name: 'read-request', revision: 1, operation: 'extract' } }
```

`run` returns what the task's operation returns, plus `task` with the revision that ran. A task that does not exist returns `success: false` with `errorCode: 'task_not_found'`.

## What a task holds

| Operation | Saved with the task | Sent with each run |
| --- | --- | --- |
| `extract` | `schema` | the text or data to read |
| `summarize` | `maxLength` (200 when left out), `focus` | the content |
| `validate` | `criteria` | the subject, and `reference` in the options |
| `decide` | `actions`, each with an optional description and parameter schema | the situation to decide on |

Every task can also hold `contextKeys` and `knowledge: true`, which searches the agent's Knowledge with each run's input. A run's own options (`images`, `knowledge: { query }`, `contextKeys`, `reference`) are applied on top of the task's.

```js
await agent.tasks.set('check-reply', {
  operation: 'validate',
  criteria: 'The reply promises nothing the return policy does not allow.',
  knowledge: true
});
const verdict = await agent.run('check-reply', draft, { reference: order });
```

A `decide` task works with registered handlers as usual: pass the result to `agent.execute(decision)`.

## Managing tasks

```js
await agent.tasks.list();
const task = await agent.tasks.get('read-request');
await agent.tasks.set('read-request', { ...settings, ifRevision: task.revision });
await agent.tasks.delete('read-request');
```

`set` replaces the whole task and increases its revision. `ifRevision: null` only creates; a number replaces only that revision and otherwise fails with `task_revision_conflict`; left out, it overwrites. Names start with a lowercase letter and hold up to 64 lowercase letters, digits, dots, underscores or hyphens. An agent holds up to 32 tasks. An agent created without a key keeps its tasks in the process.

## Over HTTP

```sh
curl --fail-with-body --request POST 'https://api.nullprotocol.ai/v1/agents/support/tasks/read-request/run' \
  --header "Authorization: Bearer $NULLPROTOCOL_KEY" \
  --header 'Content-Type: application/json' \
  --header 'Idempotency-Key: ticket-8841' \
  --data-raw '{ "input": "Order 1042 arrived with a broken mug." }'
```

The body takes `input` and, optionally, `reference` (validate tasks only), `images`, `conversation` and `knowledge`. The response is `{ result, operationId, task: { name, revision, operation } }`. Retries follow the same [Idempotency-Key rules](http.md#retries-and-errors) as other runs. `GET`, `PUT` and `DELETE` on `/v1/agents/{agentId}/tasks/{name}` manage a task with the same fields as `tasks.set`.

## History and changes

Each operation in History names its task and revision and keeps the schema, criteria or actions it ran with, so an earlier result stays explainable after the task changes.

A task change applies to every caller from the next run. Changing the rules of a task is safe for its callers; removing or renaming an output field is not, because code that reads the field still expects it. Check `result.task.revision` when your code depends on a particular shape. A model can still be wrong about content: schemas check structure, and your code keeps the business rules.
