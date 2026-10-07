#!/usr/bin/env node
// verify.mjs — assertions the collector has to keep passing.
//
//   node verify.mjs
//
// This exists because of one bug. `parseFrontmatter` matched frontmatter with
// /^(key):\s*(.*)$/, and in JavaScript `\r` is a line terminator: `.` will not match it
// and `$` will not sit in front of it. On a CRLF file every line failed, and the function
// returned {} silently. With core.autocrlf=true and no .gitattributes, 431 of the original
// vault's 679 notes were CRLF on Windows and LF on a Linux checkout — so the graph produced
// different answers on different platforms and reported neither as an error.
//
// It cost 344 notes falsely reported as missing `level:`, every frontmatter `type:`
// ignored in favour of the folder fallback, and all four typed edge kinds never firing.
// The same bug had already been found and fixed in another script weeks earlier. A parser
// that fails silently needs a test that fails loudly.
//
// The second half runs against example-vault/, where each file exists to exercise one rule.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const VAULT = join(HERE, 'example-vault')

// graph-lib reads GRAPH_GENERATED once, at import, so it has to be set before the import.
process.env.GRAPH_GENERATED = 'builds/pipeline-snapshot'
const { parseFrontmatter, collect, resolve, findOrphans, findMissingLevel } = await import('./graph-lib.mjs')

let failed = 0
const check = (name, ok, detail = '') => {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || !detail ? '' : '  :: ' + detail))
  if (!ok) failed++
}

console.log('frontmatter')

const LF = '---\nlevel: 2\ntype: build\naliases: [builds/old-name, old-name]\n---\n\n# Title\n\nBody [[context/voice]].\n'
const CRLF = LF.replace(/\n/g, '\r\n')
const a = parseFrontmatter(LF)
const b = parseFrontmatter(CRLF)

check('LF frontmatter parses', a.data.level === '2' && a.data.type === 'build')
check('CRLF frontmatter parses', b.data.level === '2' && b.data.type === 'build',
  'got ' + JSON.stringify(b.data))
check('CRLF and LF agree on every key',
  JSON.stringify(Object.keys(a.data).sort()) === JSON.stringify(Object.keys(b.data).sort()),
  JSON.stringify(Object.keys(a.data)) + ' vs ' + JSON.stringify(Object.keys(b.data)))
check('CRLF and LF agree on every value',
  JSON.stringify(a.data) === JSON.stringify(b.data))
check('inline list parses', Array.isArray(a.data.aliases) && a.data.aliases.length === 2,
  JSON.stringify(a.data.aliases))
check('body survives with no leading delimiter', b.body.includes('# Title'))

console.log('example vault')

const vault = await collect(VAULT, 'brain')
const r = resolve(vault.nodes, vault.rawEdges)
const orphans = findOrphans(vault.nodes, r.edges)
const missing = findMissingLevel(vault.nodes)
const edgeTypes = new Set(r.edges.map((e) => e.type))
const withLevel = [...vault.nodes.values()].filter((n) => n.hasLevel).length
const has = (from, to, type = 'LINKS_TO') => r.edges.some((e) => e.from === from && e.to === to && e.type === type)

// .gitattributes keeps this file CRLF. If a checkout normalised it, the CRLF assertions
// below would pass against an LF file and prove nothing.
check('the CRLF fixture really is CRLF on disk',
  readFileSync(join(VAULT, 'builds/example-app.md'), 'utf8').includes('\r\n'),
  'normalised to LF; check .gitattributes')
check('a CRLF note reads its level: from disk', vault.nodes.get('builds/example-app')?.hasLevel === true)
check('a CRLF note reads its type: from disk', vault.nodes.get('builds/example-app')?.label === 'Build')
check('most notes read a level: from disk', withLevel > vault.nodes.size * 0.5,
  withLevel + ' of ' + vault.nodes.size + ' — if this drops, the CRLF bug is back')
check('dot-folders are not indexed', ![...vault.nodes.keys()].some((s) => s.startsWith('.')))
check('skills are indexed but exempt',
  [...vault.nodes.values()].some((n) => n.slug.startsWith('skills/') && n.exempt))
check('no skill is reported as an orphan', !orphans.some((o) => o.slug.startsWith('skills/')))
check('no skill is reported as missing level:', !missing.some((n) => n.slug.startsWith('skills/')))
check('_templates are exempt', vault.nodes.get('_template')?.exempt === true)
check('documentation about wikilinks produces no links to "wiki-links"',
  !r.dangling.some((d) => d.target === 'wiki-links' || d.target === 'wikilink'),
  r.dangling.filter((d) => /wiki/.test(d.target)).map((d) => d.from).join(', '))
check('scripts under systems/ are nodes', vault.nodes.has('systems/status'))
check('script slugs drop the extension', ![...vault.nodes.keys()].some((s) => /\.(sh|mjs|ps1)$/.test(s)))
check('a link to a script resolves', has('INDEX', 'systems/status'))
check('opaque archives are indexed but not parsed',
  vault.nodes.get('archive/agent-outputs/2026-01-01-run')?.opaque === true &&
  !r.dangling.some((d) => d.target === 'nonsense-from-a-model'))
check('generated snapshots are exempt, not re-stamped',
  vault.nodes.get('builds/pipeline-snapshot')?.exempt === true)
check('a link to an old slug resolves through an alias', has('companies/acme', 'builds/example-app'))
// Typed edges only fire on an explicit [[wikilink]] — see isWikilink in graph-lib.
check('a [[wikilinked]] typed field becomes a typed edge',
  has('people/ada-lovelace', 'companies/acme', 'WORKS_AT'), [...edgeTypes].join(', '))
check('prose in client:/company: produces no edge', !r.dangling.some((d) => d.target === 'internal'),
  'a bare prose value is being treated as a link target')
check('a link to a missing note is reported, not invented',
  r.dangling.some((d) => d.target === 'ideas/not-written-yet') &&
  !r.edges.some((e) => e.to === 'ideas/not-written-yet'))
check('an unlinked note is an orphan', orphans.some((o) => o.slug === 'notes/loose-thought'))

console.log('')
console.log(failed ? failed + ' assertion(s) FAILED' : 'all assertions passed')
console.log('  nodes=' + vault.nodes.size + ' edges=' + r.edges.length +
  ' dangling=' + r.dangling.length + ' orphans=' + orphans.length + ' missing-level=' + missing.length)
process.exit(failed ? 1 : 0)
