#!/usr/bin/env node
// graph-sync.mjs — rebuild the knowledge graph from a markdown vault.
//
//   node graph-sync.mjs --dry-run         report what WOULD be written
//   node graph-sync.mjs                   wipe each source's nodes, rewrite
//   node graph-sync.mjs --json out.json   also dump the parsed graph
//
// Run it after any vault write. It is idempotent: same files in, same graph out.
//
// This holds the only write credential to the graph. Everything else that touches
// Neo4j — the MCP server Claude queries through — connects read-only, because the
// graph is a DERIVED INDEX. If the graph and the markdown ever disagree, the markdown
// is right by definition and the fix is to run this again, never to edit the graph.

import { writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collect, resolve, findOrphans } from './graph-lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// GRAPH_SOURCES="brain=/path/to/vault,shared=/path/to/team-vault". Each name tags its
// nodes, so two vaults can live in one graph and be re-synced apart. With nothing set,
// the bundled example vault is indexed so a fresh clone has something to look at.
const SOURCES = (process.env.GRAPH_SOURCES || 'brain=' + join(HERE, 'example-vault'))
  .split(',')
  .map((pair) => pair.trim())
  .filter(Boolean)
  .map((pair) => {
    const eq = pair.indexOf('=')
    if (eq < 1) throw new Error('GRAPH_SOURCES entry must be name=path, got: ' + pair)
    return { source: pair.slice(0, eq).trim(), root: resolvePath(pair.slice(eq + 1).trim()) }
  })

const args = process.argv.slice(2)
const DRY = args.includes('--dry-run')
const jsonIdx = args.indexOf('--json')
const JSON_OUT = jsonIdx !== -1 ? args[jsonIdx + 1] : null

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) : '0.0')

async function build() {
  const nodes = new Map()
  const rawEdges = []
  const present = []

  for (const { root, source } of SOURCES) {
    if (!existsSync(root)) continue
    present.push(source)
    const got = await collect(root, source)
    // Slugs are unique per source; namespace them so a note named the same in both
    // vaults stays two distinct nodes rather than silently overwriting.
    for (const [slug, node] of got.nodes) nodes.set(source + ':' + slug, { ...node, key: source + ':' + slug })
    for (const e of got.rawEdges) rawEdges.push({ ...e, source })
  }

  // Resolution is per-source: a link inside a private vault must never silently
  // resolve to a note in a shared one. They are separate repos with separate
  // audiences, and an edge across that boundary would be a claim nobody made.
  const edges = []
  const dangling = []
  for (const source of present) {
    const scoped = new Map()
    for (const [key, n] of nodes) if (n.source === source) scoped.set(n.slug, n)
    const scopedRaw = rawEdges.filter((e) => e.source === source)
    const r = resolve(scoped, scopedRaw)
    for (const e of r.edges) edges.push({ from: source + ':' + e.from, to: source + ':' + e.to, type: e.type, source })
    for (const d of r.dangling) dangling.push({ ...d, source })
  }

  const linked = new Set()
  for (const e of edges) { linked.add(e.from); linked.add(e.to) }
  // Same exemptions findOrphans applies — skill packages and `_`-prefixed templates were
  // never under the "everything connects to something" rule. This filter used to omit
  // `exempt` and reported 29 templates and skill files as orphans.
  const orphans = [...nodes.values()].filter((n) => !n.opaque && !n.exempt && !linked.has(n.key))

  return { nodes, edges, dangling, orphans, present }
}

function report({ nodes, edges, dangling, orphans, present }) {
  const byLabel = {}
  const byType = {}
  // Orphan and level counts are quoted against the notes actually subject to those rules.
  // Quoting them against every indexed file made skill packages 95 of 117 "orphans" and
  // 83 of the "missing level:" notes, which read as a discipline problem and was a scope
  // problem. See EXEMPT_PREFIXES in graph-lib.
  const governed = [...nodes.values()].filter((n) => !n.opaque && !n.exempt)
  const missing = governed.filter((n) => !n.hasLevel)
  for (const n of nodes.values()) byLabel[n.label] = (byLabel[n.label] || 0) + 1
  for (const e of edges) byType[e.type] = (byType[e.type] || 0) + 1

  console.log('sources      : ' + (present.join(', ') || '(none found)'))
  console.log('nodes        : ' + nodes.size + '  (' + governed.length + ' governed by the orphan/level rules)')
  console.log('edges        : ' + edges.length)
  console.log('orphans      : ' + orphans.length + '  (' + pct(orphans.length, governed.length) + '% of governed)')
  console.log('dangling     : ' + dangling.length + '  (wikilinks pointing at nothing)')
  console.log('missing level: ' + missing.length + '  (' + pct(missing.length, governed.length) + '% of governed)')
  if (missing.length) {
    console.log('')
    console.log('MISSING level: (stamp it, or delete the note):')
    for (const n of missing) console.log('  ' + n.source + ':' + n.path)
  }
  console.log('')
  console.log('by label:')
  for (const [k, v] of Object.entries(byLabel).sort((a, b) => b[1] - a[1])) {
    console.log('  ' + k.padEnd(14) + v)
  }
  console.log('by edge type:')
  for (const [k, v] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log('  ' + k.padEnd(14) + v)
  }
  if (orphans.length) {
    console.log('')
    console.log('ORPHANS (link these from somewhere real, or delete them):')
    for (const o of orphans) console.log('  ' + o.source + ':' + o.path)
  }
  if (dangling.length) {
    console.log('')
    console.log('DANGLING WIKILINKS (target does not exist — fix the link or write the note):')
    // Listed in full, not truncated. The point of the number is to drive it to zero, and
    // a list that hides two thirds of the work cannot be worked through.
    for (const d of dangling) {
      console.log('  ' + d.source + ':' + d.from + '  ->  [[' + d.target + ']]' + (d.ambiguous ? '  (AMBIGUOUS: ' + d.candidates.join(', ') + ')' : ''))
    }
  }
}

async function writeToNeo4j(graph) {
  const neo4j = (await import('neo4j-driver')).default
  const uri = process.env.NEO4J_URI || 'bolt://localhost:7687'
  const user = process.env.NEO4J_USER || 'neo4j'
  const pass = process.env.NEO4J_PASSWORD
  if (!pass) {
    console.error('NEO4J_PASSWORD is not set. Copy .env.example to .env and run')
    console.error('node --env-file=.env graph-sync.mjs (npm run sync does this), or use --dry-run.')
    process.exit(2)
  }

  const driver = neo4j.driver(uri, neo4j.auth.basic(user, pass))
  const session = driver.session()
  try {
    await session.run('CREATE CONSTRAINT note_key IF NOT EXISTS FOR (n:Note0) REQUIRE n.key IS UNIQUE').catch(() => {})

    for (const source of graph.present) {
      // Full rebuild per source, not a merge. A note deleted on disk has to vanish
      // from the graph too, and only a wipe guarantees that without tracking tombstones.
      await session.run('MATCH (n {source: $source}) DETACH DELETE n', { source })
    }

    const nodeRows = [...graph.nodes.values()].map((n) => ({
      key: n.key, slug: n.slug, path: n.path, title: n.title, label: n.label,
      level: n.level, updated: n.updated, bytes: n.bytes, source: n.source, opaque: n.opaque,
      exempt: !!n.exempt, aliases: n.aliases || [],
    }))

    // One type label per node plus the shared :BrainNode, set dynamically —
    // apoc.create.node keeps this a single pass instead of a query per distinct label.
    //
    // The type is ALSO written as a property, and that is the one queries should read.
    // Neo4j does not preserve the order labels were supplied in, so labels(n)[0] comes
    // back "BrainNode" about half the time — a bug that does not throw, it just quietly
    // reports the wrong type for every node it touches.
    await session.run(
      'UNWIND $rows AS r CALL apoc.create.node([r.label, "BrainNode"], {' +
      ' key:r.key, slug:r.slug, path:r.path, title:r.title, type:r.label, level:r.level,' +
      ' updated:r.updated, bytes:r.bytes, source:r.source, opaque:r.opaque,' +
      ' exempt:r.exempt, aliases:r.aliases' +
      '}) YIELD node RETURN count(node)',
      { rows: nodeRows }
    )

    await session.run(
      'UNWIND $rows AS r MATCH (a:BrainNode {key:r.from}), (b:BrainNode {key:r.to})' +
      ' CALL apoc.create.relationship(a, r.type, {source:r.source}, b) YIELD rel RETURN count(rel)',
      { rows: graph.edges }
    )

    const check = await session.run('MATCH (n:BrainNode) RETURN count(n) AS c')
    console.log('')
    console.log('written to ' + uri + ' — ' + check.records[0].get('c') + ' nodes, ' + graph.edges.length + ' edges')
  } finally {
    await session.close()
    await driver.close()
  }
}

const graph = await build()
report(graph)

if (JSON_OUT) {
  await writeFile(JSON_OUT, JSON.stringify({
    nodes: [...graph.nodes.values()],
    edges: graph.edges,
    orphans: graph.orphans.map((o) => o.key),
    dangling: graph.dangling,
  }, null, 2))
  console.log('')
  console.log('json written: ' + JSON_OUT)
}

if (!DRY) await writeToNeo4j(graph)
