import assert from 'node:assert/strict';
import { startFixture, attachVideo, videoEnabled, config } from './fixture.mjs';

const fixture = await startFixture();
const template = {name:'Default', style:'natural_language', default_max_response_tokens:180,
  instruction:'Describe the image.', example_prompts:['A test scene.'], notes:'', final_prompt_prefix:'', final_prompt_suffix:''};
let additional = [], revision = 1;
const writes = [];
const catalog = () => {
  const override = additional.find(profile => profile.name === 'Default');
  const profiles = [{profile:override || template, source:override ? 'override' : 'bundled'},
    ...additional.filter(profile => profile.name !== 'Default').map(profile => ({profile,source:'additional'}))];
  return {revision:String(revision), template, profiles, output_length_profiles:Object.fromEntries(profiles.map(({profile}) =>
    [profile.name,{unit:profile.style === 'comma_tags' ? 'tags':'words',min:5,max:200,step:1,defaults:{clean:35}}]))};
};
try {
  await fixture.context.route('**/promptstudio/prompt-studio/model-profiles', async route => {
    const request = route.request();
    if (request.method() === 'PUT') {
      const body = request.postDataJSON(); writes.push(body);
      if (body.revision !== String(revision)) return route.fulfill({status:409,json:{error:'Model profiles changed in another window or on disk. Reload profiles before saving.'}});
      additional = additional.filter(profile => profile.name !== body.original_name);
      if (body.action === 'save') additional.push(body.profile);
      revision++;
    }
    return route.fulfill({json:catalog()});
  });
  const page = await fixture.newPage();
  page.on('dialog', dialog => dialog.accept());
  const open = () => page.locator('#promptstudio-toggle-studio-settings').click();
  await open();
  const card = page.getByRole('region',{name:'Model profiles',exact:true});
  const field = key => card.locator(`[data-profile-field="${key}"]`);
  const status = card.locator('[data-profile-status]');
  await card.locator('[data-profile-select] option').first().waitFor({state:'attached'});
  await card.locator('summary').click();
  assert.ok(await field('name').evaluate(input => input.readOnly));
  await field('instruction').fill('Local instruction');
  await card.getByRole('button',{name:'Save profile',exact:true}).click();
  await card.getByRole('button',{name:'Restore bundled default',exact:true}).waitFor();
  assert.equal(writes.at(-1).original_name,'Default');
  assert.equal(template.instruction,'Describe the image.');
  await card.getByRole('button',{name:'Restore bundled default',exact:true}).click();
  await page.waitForFunction(() => document.querySelector('[data-profile-status]')?.textContent === 'Bundled default restored.');
  assert.equal(await field('instruction').inputValue(),template.instruction);
  await card.getByRole('button',{name:'New profile',exact:true}).click();
  await field('name').fill('Synthetic tags');
  await field('style').selectOption('comma_tags');
  await field('default_max_response_tokens').fill('256');
  await field('example_prompts').fill('tag_one, tag_two\nexample_tag');
  await field('notes').fill('Synthetic notes');
  await field('final_prompt_prefix').fill('prefix: ');
  await field('final_prompt_suffix').fill(' END');
  await card.getByRole('button',{name:'Save profile',exact:true}).click();
  await page.locator('#promptstudio-profile option[value="Synthetic tags"]').waitFor({state:'attached'});
  assert.deepEqual(writes.at(-1).profile.example_prompts,['tag_one, tag_two','example_tag']);
  assert.equal(writes.at(-1).profile.final_prompt_prefix,'prefix: ');
  assert.equal(writes.at(-1).profile.default_max_response_tokens,256);
  await card.getByRole('button',{name:'Duplicate',exact:true}).click();
  assert.equal(await field('name').inputValue(),'Synthetic tags copy');
  assert.equal(await field('notes').inputValue(),'Synthetic notes');
  await card.getByRole('button',{name:'Save profile',exact:true}).click();
  await page.locator('#promptstudio-profile option[value="Synthetic tags copy"]').waitFor({state:'attached'});
  revision++;
  await field('notes').fill('Keep this unsaved edit');
  await card.getByRole('button',{name:'Save profile',exact:true}).click();
  await page.waitForFunction(() => document.querySelector('[data-profile-status]')?.textContent.includes('another window'));
  assert.equal(await field('notes').inputValue(),'Keep this unsaved edit');
  await card.getByRole('button',{name:'Reload profiles',exact:true}).click();
  await page.waitForFunction(() => document.querySelector('[data-profile-field="notes"]')?.value === 'Synthetic notes');
  await card.getByRole('button',{name:'Delete profile',exact:true}).click();
  await page.waitForFunction(() => document.querySelector('[data-profile-status]')?.textContent === 'Local profile deleted.');
  assert.equal(await page.locator('#promptstudio-profile option[value="Synthetic tags copy"]').count(),0);
  await card.locator('[data-profile-select]').selectOption('Synthetic tags');
  await field('notes').fill('Draft survives settings close');
  await page.locator('#promptstudio-close-studio-settings').click();
  await open();
  assert.equal(await field('notes').inputValue(),'Draft survives settings close');
  await card.getByRole('button',{name:'Reload profiles',exact:true}).click();
  await page.reload(); await page.waitForFunction(() => window.studioReady); await open();
  await card.locator('[data-profile-select] option[value="Synthetic tags"]').waitFor({state:'attached'});
  await card.locator('[data-profile-select]').selectOption('Synthetic tags');
  await card.locator('summary').click();
  assert.equal(await field('final_prompt_suffix').inputValue(),' END');
  for (const width of [1440,768,390]) {
    await page.setViewportSize({width,height:1000});
    assert.ok(await card.evaluate(node => node.scrollWidth <= node.clientWidth + 1), `Profile card overflow at ${width}px`);
  }
  if (process.env.PROFILE_SETTINGS_SCREENSHOT) await card.screenshot({path:process.env.PROFILE_SETTINGS_SCREENSHOT});
  if (videoEnabled) {
    await page.locator('#promptstudio-close-studio-settings').click();
    fixture.projects = {revision:1,projects:[{id:'profile-video',name:'Profile integration',brief:'',workflow_id:'',document:structuredClone(config.default_document),generations:[],created_at:1,updated_at:1}],active_project_id:'profile-video'};
    await attachVideo(page);
    assert.ok(await page.locator('#promptstudio-video-mount').isVisible());
    assert.equal(await page.locator('#promptstudio-video-mount [data-profile-field]').count(),0);
  }
  assert.deepEqual(fixture.errors,[]);
  console.log('Model profile Settings: override/restore, create, duplicate, delete, conflict, reload, persistence, responsive layout and studio boundary passed.');
} finally { await fixture.close(); }
