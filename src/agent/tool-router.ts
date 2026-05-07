import type { McpConnection } from '../mcp/types.js';

const TOOL_NAME_SEP = '__';

export function findToolSchema(
  connections: McpConnection[],
  fullName: string
): Record<string, any> | null {
  const sepIdx = fullName.indexOf(TOOL_NAME_SEP);
  if (sepIdx > 0) {
    const serverName = fullName.slice(0, sepIdx);
    const toolName = fullName.slice(sepIdx + TOOL_NAME_SEP.length);
    const conn = connections.find((c) => c.name === serverName);
    const tool = conn?.tools.find((t) => t.name === toolName);
    if (tool?.inputSchema) return tool.inputSchema as Record<string, any>;
  }
  for (const conn of connections) {
    const tool = conn.tools.find((t) => t.name === fullName);
    if (tool?.inputSchema) return tool.inputSchema as Record<string, any>;
  }
  return null;
}

export function routeToolCall(
  connections: McpConnection[],
  fullName: string
): { conn: McpConnection; toolName: string } | null {
  // Try exact match with prefix (e.g. fs__list_directory)
  const sepIdx = fullName.indexOf(TOOL_NAME_SEP);
  if (sepIdx > 0) {
    const serverName = fullName.slice(0, sepIdx);
    const toolName = fullName.slice(sepIdx + TOOL_NAME_SEP.length);
    const conn = connections.find((c) => c.name === serverName);
    if (conn && conn.tools.some((t) => t.name === toolName)) {
      return { conn, toolName };
    }
  }
  // Fallback: model called tool without prefix (e.g. list_directory)
  for (const conn of connections) {
    const tool = conn.tools.find((t) => t.name === fullName);
    if (tool) return { conn, toolName: fullName };
  }
  return null;
}
