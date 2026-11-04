/* Headless check of the API tools: npm run check:apitools (part of verify). An API model connected by key can work in a 工作
   task through the workbench's own tools (docs/API-TOOLS.md). This runs, with no network, no Electron and no window:
     - the main-process loop against fake model services on 127.0.0.1, for all three protocols (apitools-check-loop.ts)
     - the tools in temp folders, the command runner, isPureGit, web.checkUrl, the tool table (apitools-check-tools.ts)
     - index.cjs's wiring with Electron faked (also in apitools-check-loop.ts)
     - the page side: the real live.ts against a fake desktop bridge (apitools-check-renderer.ts)
   Plain assertions, no test runner. driver-check-env.ts goes first: the state modules read the desktop bridge once, when they load. */
import './driver-check-env';
import { loopChecks, wiringChecks } from './apitools-check-loop';
import { rendererChecks } from './apitools-check-renderer';
import { toolChecks } from './apitools-check-tools';
import { reviewFileChecks } from './apitools-check-review-files';
import { cleanupTemps, installFakeBrowser, startHub, stopHub, tally } from './apitools-check-lib';

const t0 = Date.now();
installFakeBrowser();
await startHub();
try {
  await loopChecks();
  await toolChecks();
  await reviewFileChecks(); // the file-tool findings of the review: sensitive names, .git, protected files, edits before approval
  await wiringChecks();
  await rendererChecks();
} catch (e) {
  console.log(`  FAIL the check itself crashed — ${(e as Error)?.stack || e}`);
  tally.failures++;
}
await stopHub();
cleanupTemps();
console.log(tally.failures ? `\n${tally.failures} of ${tally.checks} check(s) failed (${Math.round((Date.now() - t0) / 1000)} s)` : `\nAll API-tools checks passed (${tally.checks} checks, ${Math.round((Date.now() - t0) / 1000)} s)`);
process.exit(tally.failures ? 1 : 0);
