import assert from 'node:assert/strict';
import {startFixture, attachVideo, config, videoEnabled} from './fixture.mjs';

const fixture = await startFixture();
let indexed = false, fail = true, videoIndexed = false;
const batches = [];
try {
  fixture.chats = {revision: 4, activeChatId: 'saved-0', chats: Array.from({length:205}, (_,i) => ({
    id:`saved-${i}`, createdAt:i+1, updatedAt:i+1, mainPrompt:`Saved main ${i}`, finalPrompt:`Saved final ${i}`,
    currentPrompt:`Saved final ${i}`, messages:[{id:`m-${i}`,role:'user',text:`Saved input ${i}`,createdAt:i+1}],
  }))};
  fixture.projects = {revision:3, active_project_id:'saved-video', projects:[{id:'saved-video',name:'Saved Video session',
    document:structuredClone(config.default_document),generations:[],created_at:1,updated_at:1}]};
  await fixture.context.route('**/promptstudio/prompt-studio/chats?*', async route => {
    if(indexed) return route.continue();
    await route.fulfill({status:202,json:{revision:4,total:205,chats:[],maintenance_required:true,summary_records_remaining:205}});
  });
  await fixture.context.route('**/promptstudio/prompt-studio/chats/maintenance', async route => {
    if(fail) return route.fulfill({status:503,json:{error:'Synthetic index failure. Retry loading saved sessions.'}});
    const {offset,limit}=route.request().postDataJSON();batches.push({offset,limit});
    indexed=offset+limit>=205;
    await route.fulfill({json:{nextOffset:Math.min(offset+limit,205),hasMore:!indexed}});
  });
  await fixture.context.route('**/promptstudio-video/projects?*', async route => {
    if(videoIndexed) return route.continue();
    await route.fulfill({status:202,json:{revision:3,total:1,projects:[],maintenance_required:true,summary_records_remaining:1}});
  });
  await fixture.context.route('**/promptstudio-video/projects/maintenance', async route => {
    videoIndexed=true;await route.fulfill({json:{nextOffset:1,hasMore:false}});
  });
  const page=await fixture.newPage();
  assert.equal(await page.locator('.promptstudio-popout-loading').count(),0);
  assert.ok(await page.locator('#promptstudio-prompt-studio').evaluate(node=>node.getBoundingClientRect().top<=32));
  const notice=page.locator('.promptstudio-chat-sidebar [data-history-maintenance]');
  assert.equal(await notice.isVisible(),true);
  assert.match(await notice.innerText(),/Synthetic index failure/);
  assert.equal(fixture.requests.filter(request=>request.path.endsWith('/chats')&&request.method==='POST').length,0);
  fail=false;
  await notice.getByRole('button',{name:'Prepare history index'}).click();
  await page.waitForFunction(()=>!document.querySelector('.promptstudio-chat-sidebar [data-history-maintenance]'));
  assert.deepEqual(batches,[{offset:0,limit:100},{offset:100,limit:100},{offset:200,limit:100}]);
  assert.equal(await page.locator('#promptstudio-main-prompt').inputValue(),'Saved main 0');
  assert.equal(fixture.chats.chats.length,205);
  if (videoEnabled) {
    await attachVideo(page);
    assert.equal(videoIndexed,true);
    assert.equal(await page.locator('#psvstudio-project-title').inputValue(),'Saved Video session');
  }
  await page.reload();await page.waitForFunction(()=>window.studioReady);
  assert.equal(await page.locator('.promptstudio-popout-loading').count(),0);
  assert.equal(await page.locator('#promptstudio-main-prompt').inputValue(),'Saved main 0');
  assert.equal(fixture.chats.chats.length,205);
  assert.deepEqual(fixture.errors,[]);
  console.log('Startup placeholder removal, visible failed-index retry, bounded summary upgrade, preserved histories and both-studio reload passed.');
} finally {await fixture.close();}
