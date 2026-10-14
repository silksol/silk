// Serve the test fixture site so you can try silk without touching the internet:
//   node examples/serve-fixture.js        (then, in another terminal)
//   node bin/silk.js http://127.0.0.1:4173 --delay 0
import { startSite } from '../fixtures/site.js';

const site = await startSite(Number(process.env.PORT) || 4173);
console.log(`Fixture site running at ${site.url} (Ctrl+C to stop)`);
