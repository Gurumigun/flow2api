import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const start = source.indexOf('const pollProgress = async () =>');
const body = source.slice(start, source.indexOf('progressMonitor = setInterval', start));

test('a slow page progress probe cannot block extension heartbeats or start a duplicate probe', async () => {
  let release;
  let probes = 0;
  const snapshotReady = new Promise(resolve => {release=resolve;});
  const events = [];
  const chrome = {scripting:{executeScript:async request => {
    probes++;
    await snapshotReady;
    return [{result:{phase:'generating',updated_at:Date.now()+events.length}}];
  }}};
  const create = new Function('chrome','sendFlowSubmitProgress','sendActiveFlowSubmitHeartbeat','activeFlowSubmitBridges', `
    let newTabId=1, progressPollRunning=false, lastProgressUpdatedAt=0;
    const data={req_id:'request-1'}, socket={};
    ${body}
    return {pollProgress};
  `);
  const runner = create(
    chrome,
    (_data,_socket,phase)=>events.push(phase),
    ()=>events.push('extension_active'),
    new Map([[1, {lastPhase:'generating'}]]),
  );
  const firstPoll = runner.pollProgress();
  await runner.pollProgress();
  assert.deepEqual(events, ['extension_active', 'extension_active']);
  assert.equal(probes, 1);

  release();
  await firstPoll;
  assert.deepEqual(events, ['extension_active', 'extension_active', 'generating']);
});
