/**
 * Persona authorisation helper for MCP tool calls in firtal-browser.
 *
 * MCP doesn't have HTTP status codes, so the helper throws an Error on
 * deny / unauthenticated / unreachable. The MCP framework returns the
 * thrown message as `isError: true` in the tool response. The thrown
 * Error's message embeds `decision_id=<id>` so callers can correlate
 * with persona's logbog.
 *
 * Usage (CommonJS):
 *
 *   const { personaCheckTool } = require('./persona-middleware');
 *
 *   server.setRequestHandler(CallToolRequestSchema, async (request) => {
 *     const { name, arguments: args } = request.params;
 *     await personaCheckTool('use', `firtal-browser:mcp:${name}`);
 *     return await backend.callTool(name, args);
 *   });
 *
 * Token source: `process.env.PERSONA_TOKEN`. If missing the helper throws.
 *
 * Persona endpoint: `process.env.PERSONA_URL` (defaults to
 * http://localhost:4500 for local dev).
 *
 * Hard rule from JEH-397 acceptance criterion 7: this file is the ONLY
 * persona-related code that lives in firtal-browser. We do NOT
 * re-implement the SDK's cache, retries, or actor lookup here.
 */

const NO_DECISION_ID = 'n/a';

/** Singleton clients per token so the SDK's 5-minute positive cache survives. */
const clientsByToken = new Map();

/** Lazy ESM import of the persona SDK (CJS → ESM bridge). */
let personaModulePromise = null;
function loadPersona() {
  if (!personaModulePromise) {
    // eslint-disable-next-line no-new-func
    personaModulePromise = (new Function('return import("@firtal-org/persona-sdk")'))();
  }
  return personaModulePromise;
}

function personaEndpoint() {
  return process.env.PERSONA_URL || 'http://localhost:4500';
}

async function clientFor(token) {
  let client = clientsByToken.get(token);
  if (!client) {
    const { createPersona } = await loadPersona();
    client = createPersona({ endpoint: personaEndpoint(), token });
    clientsByToken.set(token, client);
  }
  return client;
}

/**
 * Ask persona whether the bearer-token holder may perform `action` on
 * `resource`. Returns void on allow. Throws on deny / unauthenticated /
 * unreachable.
 */
async function personaCheckTool(action, resource) {
  const token = process.env.PERSONA_TOKEN;
  if (!token) {
    throw new Error(
      `persona: missing PERSONA_TOKEN env var (decision_id=${NO_DECISION_ID})`,
    );
  }

  const client = await clientFor(token);

  let result;
  try {
    result = await client.check({ action, resource });
  } catch (err) {
    throw new Error(
      `persona: unreachable (decision_id=${NO_DECISION_ID}): ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  if (result.allowed) return;

  if (
    result.reason &&
    result.reason.toLowerCase().startsWith('persona unreachable')
  ) {
    throw new Error(
      `persona: unreachable (decision_id=${result.decisionId || NO_DECISION_ID}): ` +
        result.reason,
    );
  }

  throw new Error(
    `persona: denied (decision_id=${result.decisionId || NO_DECISION_ID}): ` +
      (result.reason || 'denied'),
  );
}

/** Test-only: clear the SDK-client cache so a new PERSONA_URL or token is used. */
function __resetPersonaClientsForTests() {
  clientsByToken.clear();
  personaModulePromise = null;
}

module.exports = {
  personaCheckTool,
  __resetPersonaClientsForTests,
};
