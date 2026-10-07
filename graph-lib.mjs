// graph-lib.mjs — turn a markdown vault into nodes and edges.
//
// The markdown IS the source of truth. This module only reads it. Everything the
// graph knows is re-derivable by running this again over the files, which is why
// graph-sync deletes its own prior output before writing rather than reconciling:
// a note deleted on disk must disappear from the graph, and diffing is a slower way
// to get a worse version of that guarantee.

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

// A wikilink names a note, not a file: [[builds/example-app]], never
// [[builds/example-app.md]]. Capture up to the first | or # so [[path|alias]] and
// [[path#heading]] both resolve on the path.
const WIKILINK = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g

// Folder -> node label. The vault's folder convention already gives every top-level
// folder a meaning; this table is that convention expressed as graph labels, so a note's
// label never has to be hand-maintained in frontmatter. Edit it to match your own folders.
const FOLDER_TYPE = {
  builds: 'Build', prospects: 'Prospect', clients: 'Client', people: 'Person',
  companies: 'Company', agencies: 'Agency', decisions: 'Decision', skills: 'Skill',
  research: 'Research', references: 'Reference', systems: 'System', ideas: 'Idea',
  meetings: 'Meeting', journal: 'JournalEntry', context: 'Context', tasks: 'Task',
  hypotheses: 'Hypothesis', drafts: 'Draft', reading: 'Reading', notes: 'Note',
  archive: 'Archive', backups: 'RawArchive', graph: 'System',
}

// Walked but never parsed for links. These hold raw agent output and CRM dumps — real
// content, but append-only sludge whose "links" are incidental strings rather than
// curated edges. Indexed as single nodes so nothing is invisible, bodies left alone so
// they cannot flood the graph with noise edges.
const OPAQUE_PREFIXES = ['archive/agent-outputs', 'backups']

// Frontmatter `type:` is hand-written and has drifted into near-duplicates: 30 notes say
// "task" and 10 say "tasks", 6 say "journal" and 3 "journal-entry". Left alone those
// become separate labels, and a query for one silently misses the other — the exact
// class of quiet wrongness a graph is supposed to eliminate. Canonicalise on read; the
// files are not worth rewriting for this.
const LABEL_ALIAS = {
  Tasks: 'Task', Journal: 'JournalEntry', Journalentry: 'JournalEntry',
  Builds: 'Build', Prospects: 'Prospect', People: 'Person', Persons: 'Person',
  Companies: 'Company', Clients: 'Client', Skills: 'Skill', Decisions: 'Decision',
  References: 'Reference', Systems: 'System', Ideas: 'Idea', Researches: 'Research',
}

// `.claude` is tooling configuration that can sit inside a vault — skill packages,
// settings, hooks. It is not knowledge and was never subject to the vault's rules, but indexing it made it 83 of the 117 reported orphans and 83 of the reported
// missing-`level:` notes, which buried the handful of real ones.
const SKIP_DIRS = new Set(['.git', 'node_modules', '.obsidian', '.firecrawl', 'dist', 'build', '.claude'])

// Indexed, but exempt from the two vault-wide rules — "everything connects to something"
// and "every note carries level:".
//
//   skills/**  a SKILL.md carries `name:` + `description:` by the skill spec; `level:`
//              would be wrong there, and nothing wikilinks a skill because skills are
//              reached by the resolver, not by navigation.
//   _prefixed  templates and folder READMEs. `_template.md` used to be skipped outright,
//              which made four section INDEXes dangle pointing at templates that exist.
//              Indexing them fixes those links; exempting them keeps them from becoming
//              orphans in exchange.
const EXEMPT_PREFIXES = ['skills/']

// Machine-generated snapshots, as a comma-separated list of slugs in GRAPH_GENERATED.
// A note an agent regenerates on a schedule tends to be rewritten from the agent's own
// template, which drops any frontmatter field the template does not know about. Stamping
// `level:` on one by hand lasts until the next regeneration and then silently vanishes.
//
// Exempting it is the honest description: it is generated data, not an authored note, and
// the leveling rule is about authored notes. **It is not the real fix.** The real fix is to
// teach the generator to emit `level:` (or to preserve unknown fields).
const GENERATED = (process.env.GRAPH_GENERATED || '').split(',').map((s) => s.trim()).filter(Boolean)
// The `_` test is per path SEGMENT, not just the basename: `partners/_template/README` is
// as much a template as `partners/_template.md` would be.
const isExempt = (slug) =>
  EXEMPT_PREFIXES.some((p) => slug === p.slice(0, -1) || slug.startsWith(p)) ||
  GENERATED.includes(slug) ||
  slug.split('/').some((seg) => seg.startsWith('_'))

// Non-markdown files worth being nodes. Notes link to scripts like [[systems/status]],
// which are real files — the links are right, and a collector that only reads .md is
// blind to them.
const SCRIPT_EXTS = ['.sh', '.mjs', '.ps1']
const SCRIPT_DIRS = ['systems/', 'scripts/']

// Frontmatter field naming alternative slugs a note answers to. This is the only way to
// repair a link whose source cannot be edited — `decisions/log.md` is append-only by rule,
// so a link it made to a note since renamed is permanent. An alias fixes it from the
// target's side. Obsidian reads the same field, so the vault agrees with the graph.
//
// `slug:` counts too. In the vault this was built for, 82 notes declared one and 12 of
// those disagreed with their path — `research/topic/findings.md` saying
// `slug: research/topic`, which is exactly what its inbound links call it. The declared slug is treated as an alias
// rather than as identity: identity stays the path, so a stale `slug:` can never make a
// note unreachable at the name it actually lives under.
const ALIAS_FIELDS = ['aliases', 'alias', 'slug']

// A typed frontmatter field only becomes an edge when it is written as an explicit
// [[wikilink]]. In the vault this was built for, `client:` was prose in all sixteen cases
// — "internal", "product (seats sold)", "template, genericized…". These are descriptions,
// not relationships. Accepting bare
// values because they happen to look slug-shaped is how `client: internal` became a link
// to a note called "internal" that nobody has ever written.
//
// The cost of the strict rule is that a typed edge has to be opted into. That is the right
// trade: the field keeps working as a readable property either way, and an edge means
// somebody meant it.
const isWikilink = (raw) => /^\[\[.+\]\]$/.test(String(raw).trim())

const unquote = (s) => s.replace(/^['"]|['"]$/g, '').trim()

/** Minimal YAML frontmatter reader.
 *
 * Deliberately not a YAML library. The vault's frontmatter is a flat block of
 * `key: value` with the occasional list, and every dependency added here is one more
 * thing that can fail to install on win32-arm64, a trap that has already been sprung
 * twice where this was written. Anything this cannot parse is simply not a field the graph indexes,
 * which is survivable; a broken install is not.
 */
export function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { data: {}, body: text }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { data: {}, body: text }
  const raw = text.slice(3, end)
  const body = text.slice(end + 4)
  const data = {}
  let listKey = null
  for (const rawLine of raw.split('\n')) {
    // Strip the trailing \r before matching. In JavaScript `\r` is a line terminator, so
    // `.` does not match it and `$` will not sit in front of it — which meant
    // /^(key):\s*(.*)$/ failed on EVERY line of EVERY CRLF file, and this function
    // silently returned {} for 431 of the vault's 679 notes. `core.autocrlf=true` with no
    // .gitattributes is why they are CRLF here and would be LF on a Linux checkout, so the
    // bug was invisible and platform-dependent. It cost: 344 notes reported as missing
    // `level:` that have it, every frontmatter `type:` ignored in favour of the folder
    // fallback, and all four typed edge kinds never firing once.
    //
    // The identical bug had been found and fixed in an older reindex script. Fixing the
    // symptom in one file and not grepping for the pattern is how it survived here. See the CRLF/LF assertion in verify.mjs.
    const line = rawLine.replace(/\r$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue
    const item = line.match(/^\s*-\s+(.*)$/)
    if (item && listKey) { data[listKey].push(unquote(item[1])); continue }
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!kv) continue
    const [, key, rest] = kv
    if (rest === '') { listKey = key; data[key] = []; continue }
    listKey = null
    if (rest.startsWith('[') && rest.endsWith(']')) {
      data[key] = rest.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter(Boolean)
    } else {
      data[key] = unquote(rest)
    }
  }
  return { data, body }
}

/** First markdown H1, else a title-cased slug. Titles are what a human reads in query
 *  output, so falling back to the slug beats leaving it blank. */
function deriveTitle(body, slug) {
  const h1 = body.match(/^#\s+(.+)$/m)
  if (h1) return h1[1].trim()
  const tail = slug.split('/').pop()
  return tail.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

async function walk(root, dir = root, out = []) {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) { await walk(root, full, out); continue }
    if (e.name.endsWith('.md')) { out.push(full); continue }
    // Scripts under systems/ and scripts/ are link targets, so they have to be nodes.
    // They are never parsed for links — a shell script's brackets are not wikilinks.
    const rel = toPosix(relative(root, full))
    if (SCRIPT_EXTS.some((x) => e.name.endsWith(x)) && SCRIPT_DIRS.some((d) => rel.startsWith(d))) out.push(full)
  }
  return out
}

const toPosix = (p) => p.split(sep).join('/')

/** Blank out fenced code blocks and inline code before scanning for wikilinks.
 *
 * Notes that document the wikilink convention write `[[wiki-links]]` as an example, and
 * scanning them produced links to notes named "wiki-links" and "wikilink" that nobody
 * ever intended to exist. Replacing with spaces rather than deleting keeps offsets stable
 * for anything that later wants them. */
function stripFences(body) {
  return body
    // HTML comments are not content. They hold the auto-index markers and template
    // instructions like "<!-- one line per member: - [[partners/name/README]] -->", whose
    // placeholder promptly resolved to nine ambiguous candidates.
    .replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length))
    .replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length))
    .replace(/(^|\n)( {4}|\t)[^\n]*/g, (m) => ' '.repeat(m.length))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length))
}

/** Read one vault and return its nodes and unresolved edges. `source` tags every node
 *  so several vaults can share one graph and be swept and re-synced apart. */
export async function collect(root, source) {
  const files = await walk(root)
  const nodes = new Map()
  const rawEdges = []

  for (const file of files) {
    const rel = toPosix(relative(root, file))
    const isMd = rel.endsWith('.md')
    // A wikilink names a note, not a file — [[systems/status]], never
    // [[systems/status.sh]] — so the slug drops the extension for scripts too.
    const slug = isMd ? rel.replace(/\.md$/, '') : rel.replace(/\.[a-z0-9]+$/i, '')
    const top = rel.split('/')[0]
    const opaque = OPAQUE_PREFIXES.some((p) => rel.startsWith(p + '/'))

    const info = await stat(file)

    // A script is a node so links to it resolve, but it is never read: its contents are
    // code, and code brackets are not wikilinks.
    if (!isMd) {
      nodes.set(slug, {
        slug, path: rel, title: slug.split('/').pop(), label: 'Script',
        level: null, hasLevel: false, exempt: true, aliases: [],
        updated: info.mtime.toISOString(), bytes: info.size, source, opaque: true,
      })
      continue
    }

    const text = await readFile(file, 'utf8')
    const { data, body } = parseFrontmatter(text)

    const declared = data.type
      ? String(data.type).replace(/(^|[-_ ])(\w)/g, (_, __, c) => c.toUpperCase())
      : (rel.includes('/') ? (FOLDER_TYPE[top] || 'Note') : 'Root')
    const label = LABEL_ALIAS[declared] || declared

    const aliases = ALIAS_FIELDS.flatMap((f) => {
      const v = data[f]
      if (!v) return []
      return (Array.isArray(v) ? v : String(v).split(',')).map((s) => unquote(String(s)).replace(/^\[\[|\]\]$/g, '')).filter(Boolean)
    })

    // INDEX files are genuine L1 hubs — they are how a section is navigated. Labeling
    // them Index keeps them from being mistaken for canonical entities while still
    // letting their many outbound links count as real structure.
    const isIndex = /(^|\/)INDEX$/i.test(slug)

    nodes.set(slug, {
      slug,
      path: rel,
      title: deriveTitle(body, slug),
      label: isIndex ? 'Index' : label,
      level: data.level !== undefined ? Number(data.level) : null,
      hasLevel: data.level !== undefined,
      exempt: isExempt(slug),
      aliases,
      updated: info.mtime.toISOString(),
      bytes: info.size,
      source,
      opaque,
    })

    if (opaque) continue

    for (const m of stripFences(body).matchAll(WIKILINK)) {
      const target = m[1].trim().replace(/\.md$/, '')
      if (target) rawEdges.push({ from: slug, toSlug: target, type: 'LINKS_TO' })
    }

    // Typed edges declared in frontmatter. Worth trusting for questions like "who works
    // where": a body wikilink says two notes are related, a frontmatter field says how.
    const TYPED = [['company', 'WORKS_AT'], ['supersedes', 'SUPERSEDES'], ['uses_skill', 'USES_SKILL'], ['client', 'FOR_CLIENT']]
    for (const [field, type] of TYPED) {
      const v = data[field]
      if (!v) continue
      for (const one of (Array.isArray(v) ? v : [v])) {
        const raw = String(one).trim()
        if (!isWikilink(raw)) continue
        const t = raw.replace(/^\[\[|\]\]$/g, '').replace(/\.md$/, '').trim()
        if (t) rawEdges.push({ from: slug, toSlug: t, type })
      }
    }
  }

  return { nodes, rawEdges }
}

/** Resolve link targets to real nodes.
 *
 * Wikilinks are written by hand and drift: [[voice]] for context/voice, or a link to a
 * note since renamed. Resolution tries exact slug, then a UNIQUE basename match, and
 * gives up rather than guessing between two candidates — a wrong edge is worse than a
 * reported dangling one, because it quietly makes the graph agree with a claim nobody
 * checked.
 */
export function resolve(nodes, rawEdges) {
  const byBase = new Map()
  const byLower = new Map()
  const byAlias = new Map()
  for (const [slug, n] of nodes) {
    const base = slug.split('/').pop().toLowerCase()
    if (!byBase.has(base)) byBase.set(base, [])
    byBase.get(base).push(slug)
    // Case-insensitive whole-slug match. [[builds/index]] means builds/INDEX; treating
    // that as dangling is pedantry, not a finding.
    if (!byLower.has(slug.toLowerCase())) byLower.set(slug.toLowerCase(), slug)
    for (const a of n.aliases || []) {
      const k = a.toLowerCase()
      if (!byAlias.has(k)) byAlias.set(k, [])
      byAlias.get(k).push(slug)
    }
  }

  const edges = []
  const dangling = []
  for (const e of rawEdges) {
    const t = e.toSlug
    if (nodes.has(t)) { edges.push({ ...e, to: t }); continue }
    const lower = byLower.get(t.toLowerCase())
    if (lower) { edges.push({ ...e, to: lower }); continue }
    // An alias declared on the target. Ambiguous aliases are refused for the same reason
    // ambiguous basenames are: a wrong edge is worse than a reported dangling one.
    const al = byAlias.get(t.toLowerCase())
    if (al && al.length === 1) { edges.push({ ...e, to: al[0] }); continue }
    // A link to a folder means that folder's own index page.
    const dirIndex = ['/README', '/INDEX', '/SKILL'].map((s) => byLower.get((t + s).toLowerCase())).find(Boolean)
    if (dirIndex) { edges.push({ ...e, to: dirIndex }); continue }
    const cands = byBase.get(t.split('/').pop().toLowerCase()) || []
    if (cands.length === 1) { edges.push({ ...e, to: cands[0] }); continue }
    dangling.push({ from: e.from, target: t, ambiguous: cands.length > 1, candidates: cands })
  }

  // The same note linking another five times is one relationship.
  const seen = new Set()
  const unique = edges.filter((e) => {
    const k = e.from + '|' + e.type + '|' + e.to
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  return { edges: unique, dangling }
}

/** Degree-zero nodes. The requirement is that nothing floats: every note either points
 *  at something or is pointed at.
 *
 *  Two exemptions, both because the rule was never about them. Opaque raw dumps are
 *  storage, not knowledge, and were never meant to carry links. Skill packages and
 *  `_`-prefixed templates are reached by the skill resolver and by copy-paste, not by
 *  navigation — see EXEMPT_PREFIXES. */
export function findOrphans(nodes, edges) {
  const linked = new Set()
  for (const e of edges) { linked.add(e.from); linked.add(e.to) }
  return [...nodes.values()].filter((n) => !n.opaque && !n.exempt && !linked.has(n.slug))
}

/** Notes subject to the `level:` rule that do not carry it. Same exemptions as orphans. */
export function findMissingLevel(nodes) {
  return [...nodes.values()].filter((n) => !n.opaque && !n.exempt && !n.hasLevel)
}
