// Minimal MCP server over stdio, used only by the external-MCP spec.
// Deliberately tiny: one tool with a required string argument, so the JSON
// Schema → Zod conversion and the call round-trip are both exercised.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'fixture-server', version: '1.0.0' })

server.registerTool(
  'echo',
  {
    description: 'Echo a message back',
    inputSchema: { message: z.string().describe('Text to echo') },
  },
  async ({ message }) => ({
    content: [{ type: 'text', text: `echo:${message}` }],
  }),
)

server.registerTool(
  'add',
  {
    description: 'Add two numbers',
    inputSchema: { a: z.number(), b: z.number() },
  },
  async ({ a, b }) => ({
    content: [{ type: 'text', text: String(a + b) }],
  }),
)

await server.connect(new StdioServerTransport())
