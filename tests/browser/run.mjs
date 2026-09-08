import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {videoEnabled} from '../integration-mode.mjs';
const videoSuites = new Set(['extension.spec.mjs', 'history.spec.mjs', 'workflow.spec.mjs']);
const results=[];
for(const name of readdirSync(import.meta.dirname).filter(name=>name.endsWith('.spec.mjs')).sort()) {
 if (!videoEnabled && videoSuites.has(name)) {
  results.push({name,skipped:'Video integration is opt-in (STUDIO_TEST_VIDEO=1)'});
  continue;
 }
 const started=Date.now();
 const result=spawnSync(process.execPath,[join(import.meta.dirname,name)],{stdio:'inherit',env:process.env,timeout:180000});
 results.push({name,passed:result.status===0,seconds:Math.round((Date.now()-started)/100)/10});
 if(result.error)console.error(result.error.message);
}
console.log(JSON.stringify({browserSuites:results,passed:results.filter(result=>result.passed).length,skipped:results.filter(result=>result.skipped).length,total:results.length},null,2));
if(results.some(result=>!result.passed&&!result.skipped))process.exitCode=1;
