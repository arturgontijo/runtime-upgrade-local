/**
 * Extract migration-related lines from polkadot-parachain (or other Substrate) logs.
 *
 * FRAME logs most storage migrations at INFO via VersionedMigration (`🚚 Pallet …`).
 * Multi-block migrations (MBM) usually log at DEBUG (`Progressing MBM #n`, `Onboarding …`);
 * events are on-chain — use `npm run zombienet:watch` for those.
 *
 * Usage:
 *   node zombienet/scripts/scrape-para-migrations-from-log.mjs <logfile> [logfile...]
 *   cat alice.log | node zombienet/scripts/scrape-para-migrations-from-log.mjs
 *
 * Env:
 *   JSON_OUT=1             Print one JSON object to stdout (still prints summary on stderr).
 *   INCLUDE_SKIPPED=1      Include VersionedMigration "can be removed" (already upgraded) lines.
 *   INCLUDE_STORAGE_PURGE=1
 *                          Include generic storage purge lines (Removed … keys 🧹), not only migrations.
 */
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';

function stripAnsi(s) {
  return s.replace(/\u001b\[[\d;]*m/g, '');
}

/** @type {{ name: string, re: RegExp }[]} */
const RULES = [
  {
    name: 'versioned_migration',
    re: /🚚\s*Pallet\s+"([^"]+)"\s+VersionedMigration\s+migrating\s+storage\s+version\s+from\s+(\d+)\s+to\s+(\d+)/,
  },
  {
    name: 'versioned_migration_skipped',
    re: /🚚\s*Pallet\s+"([^"]+)"\s+VersionedMigration\s+migration\s+(\d+)->(\d+)\s+can\s+be\s+removed/,
  },
  {
    name: 'reset_pallet',
    re: /ResetPallet<([^>]+)>:/,
  },
  {
    name: 'mbm_onboarding',
    re: /Onboarding\s+(\d+)\s+new\s+MBM\s+migrations/,
  },
  {
    name: 'mbm_progress',
    re: /Progressing\s+MBM\s+#(\d+)/,
  },
  {
    name: 'mbm_fatal',
    re: /(?:Migration\s+stuck\.|Ongoing\s+migrations\s+interrupted)/,
  },
  {
    name: 'versioned_migration_ascii',
    // Fallback if terminal stripped emoji
    re: /Pallet\s+"([^"]+)"\s+VersionedMigration\s+migrating\s+storage\s+version\s+from\s+(\d+)\s+to\s+(\d+)/,
  },
  {
    name: 'storage_purge',
    re: /Removed\s+.+\s+keys\s+🧹/,
  },
];

function classify(clean) {
  for (const { name, re } of RULES) {
    const m = clean.match(re);
    if (!m) continue;
    if (name === 'versioned_migration_skipped') {
      return {
        kind: name,
        pallet: m[1],
        from: Number(m[2]),
        to: Number(m[3]),
        detail: `${m[1]} ${m[2]}→${m[3]} (skipped / already migrated)`,
      };
    }
    if (name === 'versioned_migration' || name === 'versioned_migration_ascii') {
      return {
        kind: 'versioned_migration',
        pallet: m[1],
        from: Number(m[2]),
        to: Number(m[3]),
        detail: `${m[1]} storage ${m[2]}→${m[3]}`,
      };
    }
    if (name === 'reset_pallet') {
      return { kind: name, pallet: m[1], detail: `ResetPallet<${m[1]}>` };
    }
    if (name === 'mbm_onboarding') {
      return { kind: name, count: Number(m[1]), detail: `MBM onboarding: ${m[1]} migrations` };
    }
    if (name === 'mbm_progress') {
      return { kind: name, index: Number(m[1]), detail: `MBM progress index ${m[1]}` };
    }
    if (name === 'mbm_fatal') {
      return { kind: name, detail: clean.trim() };
    }
    if (name === 'storage_purge') {
      return { kind: name, detail: clean.trim() };
    }
  }
  return null;
}

async function* iterateLines(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo += 1;
    yield { lineNo, line, source: filePath };
  }
}

async function* iterateStdin() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo += 1;
    yield { lineNo, line, source: '(stdin)' };
  }
}

function parseArgs() {
  const files = process.argv.slice(2).filter(a => a !== '--');
  return files;
}

const files = parseArgs();
const jsonOut = process.env.JSON_OUT === '1';
const includeSkipped = process.env.INCLUDE_SKIPPED === '1';
const includeStoragePurge = process.env.INCLUDE_STORAGE_PURGE === '1';

async function main() {
  /** @type {{ source: string, lineNo: number, raw: string } & Record<string, unknown>} */
  const matches = [];

  async function scan(sourceIter, displaySource) {
    for await (const { lineNo, line, source } of sourceIter) {
      const clean = stripAnsi(line);
      const hit = classify(clean);
      if (!hit) continue;
      if (hit.kind === 'versioned_migration_skipped' && !includeSkipped) continue;
      if (hit.kind === 'storage_purge' && !includeStoragePurge) continue;

      matches.push({
        source: displaySource ?? source,
        lineNo,
        raw: line.trimEnd(),
        ...hit,
      });
    }
  }

  if (files.length === 0) {
    await scan(iterateStdin(), '(stdin)');
  } else {
    for (const f of files) {
      const resolved = path.resolve(f);
      if (!fs.existsSync(resolved)) {
        console.error(`missing file: ${resolved}`);
        process.exit(1);
      }
      await scan(iterateLines(resolved), resolved);
    }
  }

  const executed = matches.filter(m => m.kind === 'versioned_migration');
  const uniqueMigrations = [];
  const seen = new Set();
  for (const m of executed) {
    const key = `${m.pallet}:${m.from}:${m.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueMigrations.push({ pallet: m.pallet, from: m.from, to: m.to });
  }

  console.error('');
  console.error(
    `Found ${matches.length} migration-related log line(s) (${executed.length} VersionedMigration executed).`,
  );
  if (uniqueMigrations.length > 0) {
    console.error('');
    console.error('Versioned migrations (deduped pallet/from/to):');
    for (const u of uniqueMigrations) {
      console.error(`  - ${u.pallet}: storage ${u.from} → ${u.to}`);
    }
  }
  console.error('');
  console.error('All matching lines:');
  for (const m of matches) {
    const loc = m.lineNo ? `${m.source}:${m.lineNo}` : m.source;
    console.error(`  [${loc}] ${m.detail ?? m.kind}`);
    console.error(`    ${m.raw}`);
  }

  if (jsonOut) {
    const payload = {
      summary: {
        lineCount: matches.length,
        versionedMigrationExecuted: executed.length,
        uniqueVersionedMigrations: uniqueMigrations,
      },
      matches,
    };
    console.log(JSON.stringify(payload, null, 2));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
