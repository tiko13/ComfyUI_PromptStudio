import assert from 'node:assert/strict';
import {startFixture} from './fixture.mjs';

const fixture = await startFixture();
try {
  let submitted = null;
  let checked = null;
  await fixture.context.route('**/js/prompt_studio.js', async route => {
    const response = await route.fetch();
    await route.fulfill({response, body: await response.text() + '\nexport {queueGeneration};'});
  });
  await fixture.context.route('**/scripts/api.js', async route => {
    const response = await route.fetch();
    await route.fulfill({response, body: await response.text()
      + '\napi.queuePrompt=async(_,snapshot)=>(await fetch("/test-submit",{method:"POST",body:JSON.stringify(snapshot)})).json();'});
  });
  await fixture.context.route('**/test-submit', async route => {
    submitted = route.request().postDataJSON();
    await route.fulfill({json:{prompt_id:'checked'}});
  });
  await fixture.context.route('**/validate-final-prompts', async route => {
    checked = route.request().postDataJSON().prompts;
    if (checked.some(p => p.includes('dreamlike'))) return route.fulfill({status:400,json:{error:'Final prompt contains forbidden words: dreamlike'}});
    await route.fulfill({json:{prompts:checked.map(p => p.replaceAll('cinematic','filmic'))}});
  });
  const page = await fixture.newPage();
  for (const prompt of ['dreamlike forest', 'cinematic forest']) {
    checked = null;
    await page.evaluate(async prompt => {
      const {queueGeneration} = await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
      window.forbiddenQueueError = null;
      window.forbiddenQueueDone = false;
      const snapshot = {workflow:{nodes:[],extra:{}},output:{
        '1':{class_type:'KCPP_PromptSlot',inputs:{prompt}},'2':{class_type:'SaveImage',inputs:{}}
      }};
      window.queueTask = queueGeneration({generationSnapshot:snapshot,executionPrompt:prompt,finalPrompt:prompt,
        mainPrompt:'A forest',resultNodeIds:['2'],resultFields:['images']})
        .catch(error => {window.forbiddenQueueError=error.message;})
        .finally(() => {window.forbiddenQueueDone=true;});
    }, prompt);
    await page.getByRole('button',{name:'Replay saved inputs',exact:true}).click();
    await page.waitForFunction(() => window.forbiddenQueueDone);
    assert.deepEqual(checked,[prompt,prompt,prompt]);
    if (prompt.startsWith('dreamlike')) {
      assert.match(await page.evaluate(() => window.forbiddenQueueError),/dreamlike/);
      assert.equal(submitted,null,'A forbidden replay must never reach the queue');
    } else {
      assert.equal(await page.evaluate(() => window.forbiddenQueueError),null);
      assert.equal(submitted.output['1'].inputs.prompt,'filmic forest');
    }
  }
  assert.deepEqual(fixture.errors,[]);
  console.log('Forbidden-word submission gate: rejected replay never queues; replacement reaches actual workflow.');
} finally {await fixture.close();}
