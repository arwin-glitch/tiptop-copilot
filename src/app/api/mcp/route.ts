import { handleMcpPost, mcpMethodNotAllowed } from '@/lib/mcp/http';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Copilot's MCP server (Streamable HTTP), for clients that send the token as
 * `Authorization: Bearer <token>`: Claude Code, the cloud routines, scripts.
 * claude.ai's custom connectors, which add a server by URL alone, use
 * /api/mcp/<token> instead. See docs/MCP.md and lib/mcp/http.ts.
 */
export async function POST(request: Request) {
  return handleMcpPost(request, null);
}

export async function GET() {
  return mcpMethodNotAllowed();
}

export async function DELETE() {
  return mcpMethodNotAllowed();
}
