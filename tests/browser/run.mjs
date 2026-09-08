import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
const results=[];
for(const name of readdirSync(import.meta.dirname).filter(name=>name.endsWith('.spec.mjs')).sort()) {
 const started=Date.now();
 const result=spawnSync(process.execPath,[join(import.meta.dirname,name)],{stdio:'inherit',env:process.env,timeout:180000});
 results.push({name,passed:result.status===0,seconds:Math.round((Date.now()-started)/100)/10});
 if(result.error)console.error(result.error.message);
}
console.log(JSON.stringify({browserSuites:results,passed:results.filter(result=>result.passed).length,total:results.length},null,2));
if(results.some(result=>!result.passed))process.exitCode=1;
