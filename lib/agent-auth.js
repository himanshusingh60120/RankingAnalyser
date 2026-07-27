// lib/agent-auth.js
// Shared-secret auth for the local crawl agent. The agent sends
//   Authorization: Bearer <AGENT_TOKEN>
// Returns a 401 Response if the token is missing/wrong, or null if OK.

export function requireAgent(request) {
  const expected = process.env.AGENT_TOKEN || "";
  if (!expected) {
    return new Response(JSON.stringify({ error: "AGENT_TOKEN not set on the server." }), {
      status: 503, headers: { "Content-Type": "application/json" },
    });
  }
  const got = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (got !== expected) {
    return new Response(JSON.stringify({ error: "Unauthorized (bad agent token)." }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}
