'use strict';

/**
 * Headless runner for the monitoring pipeline — handy for debugging without
 * launching Electron, and for CI smoke tests in demo mode.
 *
 *   node src/cli.js --demo          # run one cycle on bundled sample posts
 *   node src/cli.js                 # run one cycle against the live channel
 *   node src/cli.js --watch         # keep polling on the configured interval
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

  const pipeline = new Pipeline({ config, store, overrides });

  pipeline.on('status', (s) => console.log(`[${s.state}] ${s.message}`));
  pipeline.on('sighting', ({ sighting }) =>
    console.log(
      `  📍 ${sighting.location} (${sighting.region || '—'}) ` +
        `[${sighting.threatType}${sighting.count ? ' ×' + sighting.count : ''}] ` +
        `${sighting.lat.toFixed(3)},${sighting.lon.toFixed(3)} via ${sighting.geocodeSource}`
    )
  );
  pipeline.on('error', (err) => console.error('  ! ' + err.message));

  if (!config.get('demo') && !config.get('openrouterApiKey')) {
    console.error(
      'No OPENROUTER_API_KEY set. Use --demo for an offline run, or add a key to .env.'
    );
    process.exit(1);
  }

  if (args.watch) {
    console.log(
      `Watching @${config.get('telegramChannel')} every ${config.get(
        'pollIntervalSeconds'
      )}s. Ctrl+C to stop.`
    );
    pipeline.start();
    process.on('SIGINT', () => {
      pipeline.stop();
      process.exit(0);
    });
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
