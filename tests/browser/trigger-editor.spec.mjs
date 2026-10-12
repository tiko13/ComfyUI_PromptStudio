import assert from 'node:assert/strict';
import { startFixture, attachVideo, videoEnabled } from './fixture.mjs';

const fixture = await startFixture();
const records = new Map();
let rejectSave = false;
const saves = [];
try {
  await fixture.context.route('**/prompt-studio/model-metadata**', async route => {
    const req = route.request();
    const input = req.method() === 'GET' ? Object.fromEntries(new URL(req.url()).searchParams) : req.postDataJSON();
    const current = records.get(input.name) || {status:'not_found', trigger_words:['first', 'delete me'], refresh_due:false};
    if (req.method() === 'PUT') {
      saves.push(input);
      if (rejectSave) return route.fulfill({status:500,json:{error:'Database write failed'}});
      records.set(input.name, {...current, trigger_words:input.trigger_words, trigger_words_edited:true});
    }
    await route.fulfill({json:records.get(input.name) || current});
  });
  const page = await fixture.newPage();
  const check = async name => {
    const open = () => page.evaluate(async name => {
      const {openModelDetails} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/ui/model-metadata.js');
      openModelDetails(document, {category:'loras',name});
    }, name);
    await open();
    const dialog = page.getByRole('dialog', {name:'LoRA details'});
    await dialog.getByRole('button', {name:'Edit trigger words',exact:true}).click();
    const editor = page.getByRole('dialog', {name:'Edit trigger words',exact:true});
    await editor.waitFor();
    assert.equal(await dialog.locator('input').count(), 0, 'Details remain read-only behind a separate settings dialog');
    assert.equal(await editor.evaluate(node=>node.parentElement===document.body), true);
    const inputs = editor.getByRole('textbox', {name:'Trigger word',exact:true});
    await inputs.first().fill('edited trigger');
    await editor.getByRole('button', {name:'Delete trigger delete me',exact:true}).click();
    await editor.getByRole('button', {name:'Add trigger word',exact:true}).click();
    await editor.getByRole('button', {name:'Add trigger word',exact:true}).click();
    assert.equal(await inputs.count(), 2, 'Add reuses an existing empty row');
    await inputs.last().fill('   ');
    await editor.getByRole('button', {name:'Add trigger word',exact:true}).click();
    assert.equal(await inputs.count(), 2, 'Whitespace-only rows also count as empty');
    assert.equal(await inputs.last().evaluate(node=>node===document.activeElement), true);
    await inputs.last().fill('new, phrase');
    rejectSave = true;
    await editor.getByRole('button', {name:'Save trigger words',exact:true}).click();
    await editor.getByText('Database write failed',{exact:true}).waitFor();
    assert.deepEqual(await inputs.evaluateAll(nodes => nodes.map(node => node.value)), ['edited trigger','new, phrase'], 'Failed saves retain editable draft');
    rejectSave = false;
    await editor.getByRole('button', {name:'Add trigger word',exact:true}).click();
    await inputs.last().fill('   ');
    await editor.getByRole('button', {name:'Save trigger words',exact:true}).click();
    await editor.waitFor({state:'detached'});
    await dialog.getByText('Trigger words saved locally.',{exact:true}).waitFor();
    assert.deepEqual(saves.at(-1).trigger_words, ['edited trigger','new, phrase']);
    const effective = await page.evaluate(async name => {
      const {loadLoraTriggerWords} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/ui/model-metadata.js');
      return loadLoraTriggerWords(name);
    },name);
    assert.deepEqual(effective, ['edited trigger','new, phrase'], 'Trigger picker sees edits immediately');
    await dialog.getByRole('button', {name:'Edit trigger words',exact:true}).click();
    await inputs.first().fill('discarded');
    const before = saves.length;
    await editor.getByRole('button', {name:'Cancel',exact:true}).click();
    await editor.waitFor({state:'detached'});
    assert.equal(saves.length, before);
    assert.equal(await dialog.getByRole('button',{name:'edited trigger',exact:true}).count(),1);
    assert.equal(await dialog.getByRole('button',{name:'Edit trigger words',exact:true}).evaluate(node=>node===document.activeElement),true);
    await dialog.getByRole('button', {name:'Edit trigger words',exact:true}).click();
    await inputs.first().fill('discard with escape');
    await page.keyboard.press('Escape');
    await editor.waitFor({state:'detached'});
    assert.equal(await dialog.isVisible(),true,'Escape closes only trigger settings');
    assert.equal(saves.length, before);
    await dialog.getByRole('button', {name:'Edit trigger words',exact:true}).click();
    await page.setViewportSize({width:390,height:844});
    assert.equal(await editor.evaluate(node=>node.scrollWidth<=node.clientWidth),true);
    await editor.getByRole('button',{name:'Save trigger words',exact:true}).focus();
    await page.keyboard.press('Tab');
    assert.equal(await editor.evaluate(node=>node.contains(document.activeElement)),true,'Focus stays in trigger settings');
    await editor.screenshot({path:`test-results/trigger-editor-${name}.png`});
    while (await inputs.count()) await editor.getByRole('button',{name:/^Delete trigger /}).first().click();
    await editor.getByRole('button', {name:'Add trigger word',exact:true}).click();
    await editor.getByRole('button', {name:'Save trigger words',exact:true}).click();
    assert.deepEqual(saves.at(-1).trigger_words, [], 'An empty row saves an empty list, never an empty trigger');
    await dialog.getByText('No trigger words in your local list.',{exact:true}).waitFor();
    await dialog.getByRole('button', {name:'Close',exact:true}).click();
    await open();
    await dialog.getByText('No trigger words in your local list.',{exact:true}).waitFor();
    await dialog.getByRole('button',{name:'Check again',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.promptstudio-model-metadata select').disabled);
    assert.equal(await dialog.getByText('No trigger words in your local list.',{exact:true}).count(),1);
    await dialog.getByRole('button', {name:'Close',exact:true}).click();
    await page.setViewportSize({width:1440,height:1000});
  };
  await check('image.safetensors');
  if (videoEnabled) { await attachVideo(page); await check('video.safetensors'); }
  assert.deepEqual(fixture.errors, []);
  console.log('Trigger editor passed: separate dialog, add/edit/delete, failed-save recovery, cancel/Escape, focus, empty list, picker refresh, mobile, both studios.');
} finally { await fixture.close(); }
