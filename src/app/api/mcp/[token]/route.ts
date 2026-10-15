import { handleMcpPost, mcpMethodNotAllowed } from '@/lib/mcp/http';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Copilot's MCP server with the token in the path, for claude.ai custom
 * connectors, which take a URL and nothing else. The URL is the secret: it is
 * shown once in Settings, never logged by the app, and revoking the token
 * there kills it. The path token is used even if the client also sends an
 * Authorization header of its own.
 */
export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  return handleMcpPost(request, token);
}

export async function GET() {
  return mcpMethodNotAllowed();
}

export async function DELETE() {
  return mcpMethodNotAllowed();
}
