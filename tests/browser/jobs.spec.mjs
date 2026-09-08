import assert from 'node:assert/strict';
import {startFixture,attachVideo,videoEnabled} from './fixture.mjs';
const fixture=await startFixture();
const job={job_id:'synthetic-job',request_id:'synthetic-request',studio:'image',kind:'consult',state:'interrupted',phase:'generation',origin:{chat_id:'original-chat'},retry_action:'rerun_inference',error:{code:'server_restarted',retryable:true}};
try {
 await fixture.context.route('**/promptstudio/jobs',route=>route.fulfill({json:{version:1,durable:true,jobs:[job]}}));
 await fixture.context.route('**/promptstudio/jobs/diagnostics',route=>route.fulfill({headers:{'Content-Type':'application/json','Content-Disposition':'attachment; filename="diagnostics.json"'},body:JSON.stringify({version:1,content_included:false,jobs:[{state:'interrupted',phase:'generation',error:{code:'server_restarted'}}]})}));
 const page=await fixture.newPage();
 await page.locator('#promptstudio-kobold-control > summary').click();
 await page.locator('#promptstudio-job-refresh').click();
 await page.waitForFunction(()=>document.querySelector('#promptstudio-job-activity').textContent.includes('Interrupted'));
 assert.match(await page.locator('#promptstudio-job-activity').textContent(),/original-cha.*Interrupted by server restart.*Retry reruns inference/);
 let downloadPromise=page.waitForEvent('download');await page.locator('#promptstudio-job-diagnostics').click();let download=await downloadPromise;
 assert.equal(download.suggestedFilename(),'promptstudio-diagnostics.json');
 if (videoEnabled) {
   await attachVideo(page);await page.locator('#psvstudio-kobold-control > summary').click();
   await page.locator('#psvstudio-job-refresh').click();
   await page.waitForFunction(()=>document.querySelector('#psvstudio-job-activity').textContent.includes('Interrupted'));
   assert.match(await page.locator('#psvstudio-job-activity').textContent(),/Image chat: original-cha.*Interrupted/);
   downloadPromise=page.waitForEvent('download');await page.locator('#psvstudio-job-diagnostics').click();download=await downloadPromise;
   assert.equal(download.suggestedFilename(),'promptstudio-diagnostics.json');
 }
 assert.deepEqual(fixture.errors,[]);
 console.log('Both studios expose originating-job interruption/retry semantics and local bounded diagnostic download.');
} finally {await fixture.close();}
