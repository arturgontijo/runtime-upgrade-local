/**
 * Document the migrations that run when upgrading Asset Hub on a Chopsticks fork.
 *
 * What it does
 *   1. Captures pre-upgrade snapshot (spec_version, pallet list).
 *   2. Authorizes + applies the target WASM (dev_setStorage shortcut + applyAuthorizedUpgrade).
 *   3. Captures all events of the apply block (where single-block `Migrations` run from
 *      `frame_executive::Executive`).
 *   4. Steps blocks until `MultiBlockMigrations::UpgradeCompleted` (or MAX_BLOCKS),
 *      collecting `multiBlockMigrations.*` events + apply-block events.
 *   5. Reads `MultiBlockMigrations::Historic` (identifiers of completed migrations)
 *      and `Cursor` (active progress).
 *   6. Writes JSON + Markdown reports under artifacts/.
 *
 * Static source-of-truth references (asset-hub-westend 1019002, polkadot-stable2506):
 *   - Single-block tuple (`pub type Migrations`):
 *       polkadot-sdk/cumulus/parachains/runtimes/assets/asset-hub-westend/src/lib.rs:1518
 *   - Multi-block list (`pallet_migrations::Config::Migrations`):
 *       polkadot-sdk/cumulus/parachains/runtimes/assets/asset-hub-westend/src/lib.rs:1276
 *
 * Usage:
 *   node scripts/document-migrations.mjs <runtime.compact.compressed.wasm> [ws]
 *
 * Env:
 *   MAX_BLOCKS=200            blocks to step after apply (default 200)
 *   CHECK_VERSION=false       allow apply across spec_name (default true → safe)
 *   REPORT_JSON=path.json     default artifacts/migrations-report.json
 *   REPORT_MD=path.md         default artifacts/migrations-report.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { blake2AsHex, blake2AsU8a } from '@polkadot/util-crypto';
import { Keyring } from '@polkadot/keyring';

const wasmPath = process.argv[2];
const ws = process.argv[3] ?? 'ws://127.0.0.1:13100';
const maxBlocks = Number(process.env.MAX_BLOCKS ?? 200);
const checkVersion = process.env.CHECK_VERSION !== 'false';
const reportJson = process.env.REPORT_JSON ?? 'artifacts/migrations-report.json';
const reportMd = process.env.REPORT_MD ?? 'artifacts/migrations-report.md';

if (!wasmPath || !fs.existsSync(wasmPath)) {
  console.error('Usage: node scripts/document-migrations.mjs <runtime.wasm> [ws]');
  process.exit(1);
}

const keyring = new Keyring({ type: 'sr25519' });
const ALICE = keyring.addFromUri('//Alice');

const wasmBuf = fs.readFileSync(wasmPath);
const codeHash = blake2AsHex(wasmBuf);
const hashU8 = blake2AsU8a(wasmBuf, 256);

const api = await ApiPromise.create({ provider: new WsProvider(ws), noInitWarn: true });

function detectMigrationsPalletName(metadata) {
  const meta = metadata.asLatest;
  for (const p of meta.pallets) {
    if (p.events.isNone) continue;
    const eventTy = meta.lookup.getSiType(p.events.unwrap().type);
    const variants = eventTy.def.asVariant.variants.map(v => v.name.toString());
    if (variants.includes('UpgradeStarted') && variants.includes('UpgradeCompleted')) {
      return p.name.toString();
    }
  }
  return null;
}

function lcfirst(s) { return s ? s.charAt(0).toLowerCase() + s.slice(1) : s; }

async function getMetadataAt(hash) {
  return api.rpc.state.getMetadata(hash);
}

async function snapshot(hash) {
  const apiAt = await api.at(hash);
  const meta = await getMetadataAt(hash);
  const v = apiAt.runtimeVersion;
  const last = await apiAt.query.system.lastRuntimeUpgrade();
  const pallets = meta.asLatest.pallets.map(p => p.name.toString()).sort();
  let lastInfo = null;
  if (last.isSome) {
    const u = last.unwrap();
    lastInfo = {
      specVersion: u.specVersion.toNumber(),
      specName: u.specName.toUtf8?.() ?? u.specName.toString(),
    };
  }
  return {
    specName: v.specName.toString(),
    specVersion: v.specVersion.toNumber(),
    lastRuntimeUpgrade: lastInfo,
    pallets,
    metadata: meta,
  };
}

async function captureBlock(hash) {
  const apiAt = await api.at(hash);
  const blockNumber = (await apiAt.query.system.number()).toNumber();
  const events = await apiAt.query.system.events();
  const out = [];
  for (const r of events) {
    const { event } = r;
    out.push({
      block: blockNumber,
      blockHash: hash.toHex(),
      section: event.section,
      method: event.method,
      data: event.data.toHuman(),
    });
  }
  return { apiAt, blockNumber, events: out };
}

const preHead = await api.rpc.chain.getHeader();
const pre = await snapshot(preHead.hash);
delete pre.metadata;

console.log(`Pre-upgrade  : ${pre.specName} v${pre.specVersion}, ${pre.pallets.length} pallets`);
console.log(`Target WASM  : ${wasmBuf.length} bytes  blake2_256=${codeHash}`);

await api.rpc('dev_setStorage', {
  System: {
    Account: [
      [
        [ALICE.address],
        {
          providers: 1, consumers: 0, sufficients: 0,
          data: { free: 10_000n * 10n ** 18n, reserved: 0, frozen: 0, flags: 0 },
        },
      ],
    ],
  },
});

const inner = api.registry.createType('FrameSystemCodeUpgradeAuthorization', {
  codeHash: hashU8, checkVersion,
});
const opt = api.registry.createType('Option<FrameSystemCodeUpgradeAuthorization>', inner);
await api.rpc('dev_setStorage', { System: { AuthorizedUpgrade: opt.toHex() } });
await api.rpc('dev_newBlock', { count: 1 });

console.log('Submitting applyAuthorizedUpgrade…');
let inBlockHash = null;
api.tx.system
  .applyAuthorizedUpgrade(Array.from(wasmBuf))
  .signAndSend(ALICE, (r) => {
    if (r.dispatchError) console.error('dispatchError:', r.dispatchError.toString());
    if (r.status.isInBlock) inBlockHash = r.status.asInBlock;
  })
  .catch((e) => console.error('signAndSend error:', e));

for (let i = 0; i < 6 && !inBlockHash; i++) {
  await new Promise(r => setTimeout(r, 250));
  await api.rpc('dev_newBlock', { count: 1 });
}
if (!inBlockHash) {
  await api.disconnect();
  throw new Error('applyAuthorizedUpgrade was not included after 6 blocks');
}
console.log(`Apply block  : ${inBlockHash.toHex()}`);

const applyView = await captureBlock(inBlockHash);
const applyMeta = await getMetadataAt(inBlockHash);
const migrationsPalletName =
  detectMigrationsPalletName(applyMeta) ?? 'MultiBlockMigrations';
const palletKey = lcfirst(migrationsPalletName);
console.log(`MBM pallet   : ${migrationsPalletName} (api.query.${palletKey}.*)`);

const migrationEvents = [];
let upgradeCompleted = false;
let expectedMigrations = null;
const stepHashes = [inBlockHash.toHex()];

for (let i = 0; i < maxBlocks && !upgradeCompleted; i++) {
  await api.rpc('dev_newBlock', { count: 1 });
  const head = await api.rpc.chain.getHeader();
  stepHashes.push(head.hash.toHex());
  const view = await captureBlock(head.hash);
  for (const e of view.events) {
    if (e.section === palletKey) {
      migrationEvents.push(e);
      if (e.method === 'UpgradeStarted') {
        const m = e.data?.migrations ?? e.data?.[0];
        expectedMigrations = typeof m === 'string' ? Number(m.replace(/[, ]/g, '')) : m ?? null;
      }
      if (e.method === 'UpgradeCompleted') upgradeCompleted = true;
    } else if (e.section === 'system' && e.method === 'CodeUpdated') {
      migrationEvents.push(e);
    }
  }
}

let cursor = null, historic = [];
try {
  const head = await api.rpc.chain.getHeader();
  const apiAt = await api.at(head.hash);
  if (apiAt.query[palletKey]?.cursor) {
    cursor = (await apiAt.query[palletKey].cursor()).toHuman();
  }
  if (apiAt.query[palletKey]?.historic) {
    const entries = await apiAt.query[palletKey].historic.entries();
    historic = entries.map(([key]) => {
      const idU8 = key.args[0].toU8a();
      const ascii = Buffer.from(idU8).toString('utf8').replace(/[^\x20-\x7e]/g, '·');
      return { hex: '0x' + Buffer.from(idU8).toString('hex'), ascii };
    });
  }
} catch (e) {
  cursor = `error: ${e?.message ?? e}`;
}

const postHead = await api.rpc.chain.getHeader();
const post = await snapshot(postHead.hash);
delete post.metadata;
const added = post.pallets.filter(p => !pre.pallets.includes(p));
const removed = pre.pallets.filter(p => !post.pallets.includes(p));

const sourceMigrations = {
  comment:
    'Source-of-truth declarations from the runtime crate; verify path/lines for the' +
    ' build you upgraded to.',
  ref:
    'polkadot-sdk/cumulus/parachains/runtimes/assets/asset-hub-westend/src/lib.rs',
  singleBlock: {
    refLine: 1518,
    items: [
      'pallet_nfts::migration::v1::MigrateToV1',
      'pallet_collator_selection::migration::v2::MigrationToV2',
      'pallet_multisig::migrations::v1::MigrateToV1',
      'InitStorageVersions',
      'DeleteUndecodableStorage',
      'cumulus_pallet_xcmp_queue::migration::v4::MigrationToV4',
      'cumulus_pallet_xcmp_queue::migration::v5::MigrateV4ToV5',
      'pallet_assets::migration::next_asset_id::SetNextAssetId<50_000_000, TrustBackedAssets>',
      'pallet_session::migrations::v1::MigrateV0ToV1<InitOffenceSeverity>',
      'frame_support::migrations::RemovePallet<FastUnstake>',
      'pallet_xcm::migration::MigrateToLatestXcmVersion (permanent)',
      'cumulus_pallet_aura_ext::migration::MigrateV0ToV1',
    ],
  },
  multiBlock: {
    refLine: 1276,
    items: [
      'assets_common::migrations::foreign_assets_reserves::ForeignAssetsReservesMigration' +
        '<ForeignAssets, AssetHubWestendForeignAssetsReservesProvider>',
    ],
  },
};

const report = {
  generatedAt: new Date().toISOString(),
  endpoint: ws,
  wasm: { path: path.resolve(wasmPath), bytes: wasmBuf.length, blake2_256: codeHash },
  pre, post,
  palletDiff: { added, removed },
  applyBlock: {
    hash: inBlockHash.toHex(),
    number: applyView.blockNumber,
    events: applyView.events,
  },
  multiBlockMigrations: {
    palletName: migrationsPalletName,
    upgradeCompleted,
    expectedMigrations,
    cursor,
    historic,
    blocksObserved: stepHashes.length,
    events: migrationEvents,
  },
  sourceMigrations,
};

fs.mkdirSync(path.dirname(reportJson), { recursive: true });
fs.writeFileSync(reportJson, JSON.stringify(report, null, 2));

const md = [];
md.push(`# Asset Hub upgrade — migrations report`);
md.push('');
md.push(`Generated: ${report.generatedAt}`);
md.push(`Endpoint: \`${ws}\``);
md.push(`WASM: \`${path.basename(wasmPath)}\` (${wasmBuf.length} bytes, blake2_256 \`${codeHash}\`)`);
md.push('');
md.push(`## Spec versions`);
md.push(`- pre:  ${pre.specName} v${pre.specVersion}`);
md.push(`- post: ${post.specName} v${post.specVersion}`);
md.push(`- last_runtime_upgrade after: ${JSON.stringify(post.lastRuntimeUpgrade)}`);
md.push('');
md.push(`## Pallet diff`);
md.push(`- added (${added.length}): ${added.length ? added.join(', ') : '(none)'}`);
md.push(`- removed (${removed.length}): ${removed.length ? removed.join(', ') : '(none)'}`);
md.push('');
md.push(`## Single-block \`Migrations\` (frame_executive::Executive)`);
md.push(`Source: \`${sourceMigrations.ref}:${sourceMigrations.singleBlock.refLine}\``);
md.push('');
for (const m of sourceMigrations.singleBlock.items) md.push(`- ${m}`);
md.push('');
md.push(`### Apply-block events (block #${applyView.blockNumber})`);
md.push('| section | method | data |');
md.push('|---|---|---|');
for (const e of applyView.events) {
  md.push(`| ${e.section} | ${e.method} | \`${JSON.stringify(e.data).slice(0, 240)}\` |`);
}
md.push('');
md.push(`## Multi-block migrations (pallet \`${migrationsPalletName}\`)`);
md.push(`Source: \`${sourceMigrations.ref}:${sourceMigrations.multiBlock.refLine}\``);
md.push('');
for (const m of sourceMigrations.multiBlock.items) md.push(`- ${m}`);
md.push('');
md.push(`- expectedMigrations (from \`UpgradeStarted\`): ${expectedMigrations}`);
md.push(`- upgradeCompleted: ${upgradeCompleted}`);
md.push(`- blocks observed after apply: ${stepHashes.length - 1}`);
md.push(`- cursor (post): \`${JSON.stringify(cursor)}\``);
md.push(`- historic identifiers (${historic.length}):`);
for (const h of historic) md.push(`  - \`${h.hex}\` (\`${h.ascii}\`)`);
md.push('');
md.push(`### Recorded migration events`);
md.push('| block | section | method | data |');
md.push('|---|---|---|---|');
for (const e of migrationEvents) {
  md.push(`| ${e.block} | ${e.section} | ${e.method} | \`${JSON.stringify(e.data).slice(0, 240)}\` |`);
}
md.push('');
fs.writeFileSync(reportMd, md.join('\n'));

console.log(`Post-upgrade : ${post.specName} v${post.specVersion}`);
console.log(`Pallet diff  : +${added.length} -${removed.length}` +
  `${added.length ? ' (added: ' + added.join(', ') + ')' : ''}` +
  `${removed.length ? ' (removed: ' + removed.join(', ') + ')' : ''}`);
console.log(`MBM observed : completed=${upgradeCompleted}` +
  ` expected=${expectedMigrations ?? '?'} historic=${historic.length}`);
console.log(`Wrote        : ${reportJson}`);
console.log(`             : ${reportMd}`);

await api.disconnect();
