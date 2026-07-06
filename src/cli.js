'use strict';

/**
 * Headless runner for the monitoring pipeline — handy for debugging without
 * launching Electron, and for CI smoke tests in demo mode.
 *
 *   node src/cli.js --demo          # run one cycle on bundled sample posts
 *   node src/cli.js                 # one poll cycle against the live channels
 *   node src/cli.js --backfill      # deep-download the full history window
 *   node src/cli.js --watch         # backfill, then keep polling
 */

const path = require('path');
const os = require('os');
const { Config } = require('./config');
const { SightingStore } = require('./services/store');
const { Pipeline } = require('./services/pipeline');
const { demoFetchPosts, DemoLlmClient } = require('./services/demo');

function parseArgs(argv) {
  return {
    demo: argv.includes('--demo'),
    watch: argv.includes('--watch'),
    backfill: argv.includes('--backfill'),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = path.join(__dirname, '..');
  const userDataDir = path.join(os.tmpdir(), 'ddx-cli');

  const config = new Config({ rootDir, userDataDir });
  if (args.demo) config.update({ demo: true });

  const store = new SightingStore({
    filePath: path.join(userDataDir, 'sightings.json'),
    retentionHours: config.get('retentionHours'),
  });

  const overrides = {};
  if (config.get('demo')) {
    overrides.fetchPosts = demoFetchPosts;
    overrides.llm = new DemoLlmClient();
  }

  const pipeline = new Pipeline({ config, store, dataDir: userDataDir, overrides });

  pipeline.on('status', (s) => console.log(`[${s.state}] ${s.message}`));
  pipeline.on('backfill', (p) => {
    if (p.phase === 'fetch') console.log(`  … @${p.channel} page ${p.page} (${p.fetched} posts)`);
    if (p.phase === 'fetched') console.log(`  ✓ @${p.channel}: ${p.total} new post(s) in window`);
    if (p.phase === 'extract') console.log(`  → extracted ${p.done}/${p.total} (+${p.sightings} sightings)`);
  });
  pipeline.on('sighting', ({ sighting }) =>
    console.log(
      `  📍 ${sighting.location} (${sighting.region || '—'}) ` +
        `[${sighting.threatType}${sighting.count ? ' ×' + sighting.count : ''}] ` +
        `${sighting.lat.toFixed(3)},${sighting.lon.toFixed(3)} via ${sighting.geocodeSource}`
    )
  );
  pipeline.on('error', (err) => console.error('  ! ' + err.message));

  const check = await pipeline.checkBackend();
  if (!check.ok) {
    console.error(check.error + ' (or use --demo for an offline run)');
    process.exit(1);
  }
  console.log(`AI backend: ${check.backend}`);

  if (args.watch) {
    console.log(
      `Watching ${config.channels().map((c) => '@' + c).join(', ')} every ` +
        `${config.get('pollIntervalSeconds')}s. Ctrl+C to stop.`
    );
    pipeline.start();
    process.on('SIGINT', () => {
      pipeline.stop();
      process.exit(0);
    });
  } else if (args.backfill) {
    const res = await pipeline.backfill();
    const tracks = pipeline.tracks();
    console.log(
      `\nBackfill done. posts=${res.posts} sightings=${res.sightings} ` +
        `total=${store.all().length} tracks=${tracks.length}`
    );
  } else {
    const res = await pipeline.pollOnce();
    console.log(
      `\nDone. fetched=${res.fetched} processed=${res.processed} newSightings=${res.newSightings} total=${store.all().length}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
