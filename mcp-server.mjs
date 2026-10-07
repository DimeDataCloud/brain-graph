#!/usr/bin/env node
// mcp-server.mjs — how Claude asks the vault graph a question.
//
// Register it in .mcp.json as "brain-graph" (see README). Everything here is READ-ONLY, and not
// only by convention: run() refuses any statement containing a write clause before it
// reaches the driver. The graph is a derived index rebuilt by graph-sync.mjs from the
// markdown; a write that landed here would be silently destroyed by the next sync, so
// the honest thing is to make it impossible rather than let it look like it worked.
//
// The point of these tools is the questions grep cannot answer: not "which files
// mention this prospect" but "what is connected to this prospect, and how far".

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import neo4j from 'neo4j-driver'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

function password() {
  if (process.env.NEO4J_PASSWORD) return process.env.NEO4J_PASSWORD
  try {
    const env = readFileSync(join(HERE, '.env'), 'utf8')
    const m = env.match(/^NEO4J_PASSWORD=(.*)$/m)
    if (m) return m[1].trim()
  } catch { /* fall through to the explicit error below */ }
  throw new Error('NEO4J_PASSWORD not set and the .env next to mcp-server.mjs is unreadable. See .env.example')
}

const driver = neo4j.driver(
  process.env.NEO4J_URI || 'bolt://localhost:7687',
  neo4j.auth.basic(process.env.NEO4J_USER || 'neo4j', password())
)

// Cheap, deliberately blunt guard. A read-only Neo4j role would be the rigorous version
// and is worth adding if this ever leaves the laptop; on a single-user local index the
// cost of that setup buys nothing this does not already prevent.
const WRITE_CLAUSE = /\b(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|LOAD\s+CSV|CALL\s+\{[^}]*\b(CREATE|MERGE|DELETE|SET)\b)/i

async function run(cypher, params = {}) {
  if (WRITE_CLAUSE.test(cypher)) {
    throw new Error(
      'This server is read-only. The graph is a derived index — rebuild it from the ' +
      'markdown instead: node graph-sync.mjs'
    )
  }
  const session = driver.session({ defaultAccessMode: neo4j.session.READ })
  try {
    const res = await session.run(cypher, params)
    return res.records.map((r) => {
      const o = {}
      for (const k of r.keys) {
        const v = r.get(k)
        o[k] = v && typeof v === 'object' && v.properties ? v.properties : (neo4j.isInt(v) ? v.toNumber() : v)
      }
      return o
    })
  } finally {
    await session.close()
  }
}

const TOOLS = [
  {
    name: 'query_graph',
    description:
      'Run read-only Cypher against the knowledge graph. Nodes carry {key, slug, path, ' +
      'title, level, updated, source} and all share the :BrainNode label plus one type label ' +
      '(Build, Prospect, Person, Company, Decision, Skill, Research, Reference, System, Index, ...). ' +
      'Edges: LINKS_TO (wikilinks), WORKS_AT, SUPERSEDES, USES_SKILL, FOR_CLIENT. ' +
      'source is the vault name given in GRAPH_SOURCES (default "brain").',
    inputSchema: {
      type: 'object',
      properties: { cypher: { type: 'string' }, params: { type: 'object' } },
      required: ['cypher'],
    },
  },
  {
    name: 'entity_neighbors',
    description:
      'Everything connected to one note, out to N hops. The main reason this graph exists: ' +
      'answers "what touches this prospect/build/decision" in one call instead of chasing ' +
      'wikilinks by hand. Pass the slug as it appears in the vault, e.g. "builds/example-app".',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        hops: { type: 'number', description: 'default 1, max 3 — beyond that everything connects to everything' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'find_orphans',
    description:
      'Notes with no inbound and no outbound links. These are the failures of the ' +
      '"everything connects to something" rule — each one should be linked from a real ' +
      'note or deleted. Raw archive dumps are excluded; they were never meant to link.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'shortest_path',
    description: 'How two notes relate, if at all. Returns the chain of notes between them.',
    inputSchema: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      required: ['from', 'to'],
    },
  },
  {
    name: 'recent_by_type',
    description: 'Most recently updated notes of a given label — e.g. what moved in builds/ this week.',
    inputSchema: {
      type: 'object',
      properties: { type: { type: 'string' }, limit: { type: 'number' } },
      required: ['type'],
    },
  },
  {
    name: 'graph_stats',
    description: 'Node and edge counts by label/type, plus orphan count. A health check on the vault.',
    inputSchema: { type: 'object', properties: {} },
  },
]

const HANDLERS = {
  query_graph: ({ cypher, params }) => run(cypher, params || {}),

  entity_neighbors: async ({ slug, hops }) => {
    const depth = Math.min(Math.max(Number(hops) || 1, 1), 3)
    // Depth is interpolated, not parameterised: Cypher does not accept a parameter in a
    // variable-length pattern. It is clamped to 1..3 integers above, so nothing user-shaped
    // reaches the query text.
    return run(
      // Aliases count as names. A note renamed since the link was written answers to both,
      // which is the whole point of storing them — asking for [[builds/old-app]] should
      // reach the renamed note that carries that alias rather than returning nothing.
      'MATCH (a:BrainNode) WHERE a.slug = $slug OR a.key = $slug OR $slug IN a.aliases ' +
      'MATCH p = (a)-[*1..' + depth + ']-(b:BrainNode) ' +
      'WITH DISTINCT b, min(length(p)) AS dist ' +
      'RETURN b.slug AS slug, b.title AS title, b.type AS type, b.source AS source, dist ' +
      'ORDER BY dist, slug',
      { slug }
    )
  },

  // `exempt` matters as much as `opaque` here. Skill packages and `_`-prefixed templates are
  // indexed but were never under the "everything connects to something" rule — see
  // EXEMPT_PREFIXES in graph-lib. Without this clause the MCP server answered 28 where
  // `graph-sync --dry-run` answered 0, which is worse than either number being wrong: two
  // tools disagreeing on the same question makes both untrustworthy.
  find_orphans: () =>
    run(
      'MATCH (n:BrainNode) WHERE NOT (n)--() AND n.opaque = false AND n.exempt = false ' +
      'RETURN n.source AS source, n.path AS path, n.title AS title, n.type AS type ORDER BY path'
    ),

  shortest_path: ({ from, to }) =>
    run(
      'MATCH (a:BrainNode), (b:BrainNode) ' +
      'WHERE (a.slug = $from OR a.key = $from OR $from IN a.aliases) ' +
      '  AND (b.slug = $to OR b.key = $to OR $to IN b.aliases) ' +
      'MATCH p = shortestPath((a)-[*..8]-(b)) ' +
      'RETURN [n IN nodes(p) | n.slug] AS chain, length(p) AS hops',
      { from, to }
    ),

  recent_by_type: ({ type, limit }) =>
    run(
      'MATCH (n:BrainNode) WHERE n.type = $type ' +
      'RETURN n.slug AS slug, n.title AS title, n.updated AS updated, n.source AS source ' +
      'ORDER BY n.updated DESC LIMIT $limit',
      { type, limit: neo4j.int(Math.min(Number(limit) || 10, 100)) }
    ),

  graph_stats: async () => {
    const [labels, rels, orphans, governed, missingLevel] = await Promise.all([
      run('MATCH (n:BrainNode) RETURN n.type AS label, count(*) AS n ORDER BY n DESC'),
      run('MATCH ()-[r]->() RETURN type(r) AS type, count(*) AS n ORDER BY n DESC'),
      run('MATCH (n:BrainNode) WHERE NOT (n)--() AND n.opaque = false AND n.exempt = false RETURN count(n) AS n'),
      run('MATCH (n:BrainNode) WHERE n.opaque = false AND n.exempt = false RETURN count(n) AS n'),
      run('MATCH (n:BrainNode) WHERE n.opaque = false AND n.exempt = false AND n.level IS NULL RETURN count(n) AS n'),
    ])
    return {
      byLabel: labels,
      byEdgeType: rels,
      orphanCount: orphans[0] ? orphans[0].n : 0,
      governedCount: governed[0] ? governed[0].n : 0,
      missingLevelCount: missingLevel[0] ? missingLevel[0].n : 0,
    }
  },
}

const server = new Server({ name: 'brain-graph', version: '1.0.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const handler = HANDLERS[req.params.name]
  if (!handler) throw new Error('unknown tool: ' + req.params.name)
  try {
    const result = await handler(req.params.arguments || {})
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  } catch (err) {
    // Surfaced as tool content rather than thrown: the caller can read the reason and
    // adjust, which a transport-level failure would not let it do.
    return { content: [{ type: 'text', text: 'graph error: ' + err.message }], isError: true }
  }
})

await server.connect(new StdioServerTransport())
