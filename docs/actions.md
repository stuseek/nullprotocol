# Decisions and application actions

Use `decide` to choose one of the actions you offer and prepare its parameters. Use `execute` to run your registered handler. The handler can call an API, query your database, send a message or return a payload to your application.

## Prepare text and deliver it

```js
import { NullProtocol } from 'nullprotocol';

const agent = await NullProtocol.load({
  key: process.env.NULLPROTOCOL_KEY,
  agentId: process.env.NULLPROTOCOL_AGENT_ID
});

// Replace the console with your application's delivery function.
agent.registerAction('send_message', ({ text }) => {
  console.log(text);
  return { delivered: true };
}, {
  description: 'Prepare and send a short reply to the incoming message',
  input: {
    type: 'object',
    properties: { text: { type: 'string', minLength: 1 } },
    required: ['text'],
    additionalProperties: false
  }
});

const decision = await agent.decide('Hello!', ['send_message']);
if (!decision.success) throw new Error(`${decision.errorCode}: ${decision.error}`);

const execution = await agent.execute(decision);
if (!execution.success) throw new Error(`${execution.errorCode}: ${execution.error}`);
```

The model writes the reply in `decision.parameters.text`. `execute` calls the handler with those parameters; it does not generate another answer. This path needs one model reply when no repair or retry is needed.

Check `historyError` on both results if you need confirmed History recording. Handler failures return `success: false`, `outcome: 'failed'`; they do not turn an already successful decision into a failed decision.

## Search a catalogue or call an API

Register another action with the fields your application needs:

```js
agent.registerAction('search_catalog', ({ query, maxPrice }) =>
  catalogue.search({ query, maxPrice }), {
  description: 'Find products by name and optional maximum price',
  input: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1 },
      maxPrice: { type: 'number', minimum: 0 }
    },
    required: ['query'],
    additionalProperties: false
  }
});

const decision = await agent.decide('Find a blue mug under 20 EUR.', [
  'send_message',
  'search_catalog'
]);
if (!decision.success) throw new Error(decision.error);
const execution = await agent.execute(decision);
```

`catalogue` is supplied by your application. It may use HTTP or a parameterized database query. Credentials, tenant filters and the actual request stay in the handler. For an operation that needs policy documents too, pass `{ knowledge: true }` or an explicit query to `decide`.

`execute` returns the handler result. It does not automatically call the model again, execute a second action or save facts to memory. Your application can display products directly or pass the result to another operation. Each successful decision can be executed once, on the same SDK object that made it.

The runnable [actions example](../examples/actions.mjs) uses a small in-memory catalogue and outputs the prepared message or matching products. Replace those handlers with your own integrations.

## Checks and execution

- `decide` enforces the offered action names. Registered descriptions and schemas are shown to the model; parameter-schema enforcement happens in `execute`.
- `execute` validates parameters and the registered guard before invoking a handler. An unregistered action returns `action_not_registered`; invalid parameters return `invalid_parameters`.
- A pause or disabled action can stop execution after the decision was made. Editing the returned decision does not alter the saved choice or parameters.
- A failed handler is not retried by the SDK. A decision is consumed even if execution fails or is refused; use application-level idempotency when calling external services.

See the [full execution reference](operations.md#actions) for snapshots and outcomes. `decide` can also be used without a handler when you only need a payload; validate that payload in your application before using it.

## Optional generation inside a handler

A handler receives `(parameters, { decision, input, reply })`. Calling `reply(message)` explicitly makes another model request with the original decision's model, instructions, context and Knowledge selection. It does not discover tools or retrieve fresh data. Calls and reported usage are recorded with the action; they are not added back to the earlier SDK decision's `usage`. History totals include both.

## HTTP and SDK execution

The [HTTP run endpoint](http.md) returns the choice and parameters for `decide`. It does not have access to handlers registered in your process, accept their input schemas or execute them. An HTTP/serialized decision cannot be passed to SDK `execute`: it needs the original successful decision object from that agent instance. Your HTTP application's own handler can validate and act on the returned payload.

## Upgrading from SDK 2.3

SDK 2.3 has an implicit `chat` action. SDK 3 registers no default handlers. Existing applications can preserve the old behavior explicitly:

```js
agent.registerAction('chat', ({ message }, { input, reply }) =>
  reply(message ?? (typeof input === 'string' ? input : JSON.stringify(input))), {
  description: 'Answer in plain text',
  input: { type: 'object', properties: { message: { type: 'string' } } }
});
```

This handler deliberately performs another model request. To deliver a message already prepared by `decide`, register a handler such as `send_message` instead.

`decide` validates the selected action’s parameters against its supplied schema before returning success, including repair attempts for invalid parameters. An inline choice can supply `parameters: schema`; a registered handler’s `input` schema takes precedence. Invalid schemas fail before generation with `invalid_action_schema`. `execute` rechecks the current schema and guards before invoking the handler.
