import assert from 'node:assert/strict';
import { startFixture } from './fixture.mjs';

const fixture = await startFixture();
try {
  await fixture.context.route('**/js/prompt_studio.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: await response.text() + '\nexport {buildLoraNodeControls};' });
  });
  const page = await fixture.newPage();
  await page.evaluate(async () => {
    const { buildLoraNodeControls } = await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    window.renderLoraSearch = (catalog = [
      { name: 'Style\\portrait.safetensors', label: 'Portrait' },
      { name: 'Style/cinema.safetensors', label: 'Cinema' },
      { name: 'Other/detail.safetensors', label: 'Detail' },
    ]) => {
      window.loraSearchCatalog = catalog;
      document.querySelector('#lora-search-test')?.remove();
      const group = buildLoraNodeControls({ id: 'search-test' }, { id: '42', loraType: 'Style' }, catalog);
      group.id = 'lora-search-test';
      const details = document.querySelector('#promptstudio-lora-details');
      details.hidden = false;
      details.open = true;
      details.querySelector('#promptstudio-lora-groups').replaceChildren(group);
    };
    window.renderLoraSearch();
  });
  const group = page.locator('#lora-search-test');
  const picker = group.getByRole('combobox');
  assert.equal(await group.getByRole('button', { name: 'Add', exact: true }).count(), 0);
  assert.equal(await picker.inputValue(), '');
  assert.equal(await picker.getAttribute('placeholder'), 'Add a LoRA');
  await picker.click();
  assert.equal(await group.getByRole('option').count(), 3);
  await picker.press('Escape');
  await page.evaluate(() => window.renderLoraSearch());
  assert.equal(await group.locator('.promptstudio-lora-name').count(), 0, 'Dismissing must not add the first LoRA');
  await picker.click();
  const visibleOutsideCard = await group.getByRole('option').evaluateAll(options => options.some(option => {
    const rect = option.getBoundingClientRect();
    const card = option.closest('details').getBoundingClientRect();
    return (rect.bottom > card.bottom || rect.top < card.top)
      && option.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  }));
  assert.equal(visibleOutsideCard, true, 'Results must be clickable outside the real LoRA card');
  await picker.fill('STYLE/ CINEMA');
  assert.equal(await group.getByRole('option').count(), 1);
  assert.equal(await group.locator('.promptstudio-lora-name').count(), 0);
  await picker.press('Enter');
  await page.evaluate(() => window.renderLoraSearch());
  assert.equal(await group.locator('.promptstudio-lora-name').textContent(), 'Cinema');
  assert.equal(await picker.inputValue(), '');
  assert.equal(await picker.getAttribute('placeholder'), 'Add a LoRA');
  const strength = group.getByRole('spinbutton');
  await strength.fill('0.65');
  await strength.press('Tab');
  await picker.fill('no-such-lora');
  assert.equal(await group.getByRole('status').textContent(), 'No matching LoRAs');
  await picker.press('Enter');
  assert.deepEqual(await group.locator('.promptstudio-lora-name').allTextContents(), ['Cinema']);
  await picker.press('Escape');
  assert.equal(await picker.getAttribute('aria-expanded'), 'false');
  await picker.click();
  await picker.fill('');
  assert.deepEqual(await group.getByRole('option').allTextContents(), ['Portrait', 'Detail']);
  await picker.press('ArrowDown');
  await picker.press('Enter');
  await page.evaluate(() => window.renderLoraSearch());
  assert.deepEqual(await group.locator('.promptstudio-lora-name').allTextContents(), ['Cinema', 'Detail']);
  await picker.click();
  await group.getByRole('option', { name: 'Portrait', exact: true }).click();
  await page.evaluate(() => window.renderLoraSearch());
  assert.deepEqual(await group.locator('.promptstudio-lora-name').allTextContents(), ['Cinema', 'Detail', 'Portrait']);
  assert.equal(await picker.isDisabled(), true);
  assert.equal(await picker.getAttribute('placeholder'), 'No LoRAs available');
  assert.equal(await group.getByRole('spinbutton').first().inputValue(), '0.65');
  await group.getByRole('button', { name: 'Remove Cinema', exact: true }).click();
  await page.evaluate(() => window.renderLoraSearch());
  await picker.click();
  assert.deepEqual(await group.getByRole('option').allTextContents(), ['Cinema']);
  await picker.press('Tab');
  assert.equal(await picker.getAttribute('aria-expanded'), 'false');
  await page.setViewportSize({ width: 390, height: 844 });
  await picker.click();
  const bounds = await group.getByRole('listbox').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 844);
  await picker.press('Escape');
  await page.evaluate(() => {
    const details = document.querySelector('#promptstudio-lora-details');
    Object.assign(details.style, { position: 'fixed', bottom: '8px', left: '8px', width: '300px', zIndex: '100' });
    window.renderLoraSearch([
      { name: 'Style\\portrait.safetensors', label: 'Portrait' },
      ...Array.from({length: 40}, (_, index) => ({ name: `Style/test-${index}.safetensors`, label: `Test ${index}` })),
    ]);
    // The mobile sidebar establishes a fixed-position containing block.
    details.style.transform = `translateY(${innerHeight - details.getBoundingClientRect().bottom - 8}px)`;
  });
  await picker.click();
  const upwardBounds = await group.getByRole('listbox').boundingBox();
  const inputBounds = await picker.boundingBox();
  assert.ok(upwardBounds.y >= 0 && upwardBounds.y + upwardBounds.height <= inputBounds.y, JSON.stringify({upwardBounds, inputBounds}));
  await group.getByRole('listbox').evaluate(list => { list.scrollTop = list.scrollHeight; });
  await group.getByRole('option', { name: 'Test 39', exact: true }).click();
  await page.evaluate(() => window.renderLoraSearch(window.loraSearchCatalog));
  assert.ok((await group.locator('.promptstudio-lora-name').allTextContents()).includes('Test 39'));
  await page.evaluate(() => window.renderLoraSearch([{ name: 'Style\\portrait.safetensors', label: 'Portrait' }]));
  assert.equal(await picker.isDisabled(), true);
  assert.equal(await picker.getAttribute('placeholder'), 'No LoRAs available');
  await page.evaluate(() => window.renderLoraSearch([]));
  assert.equal(await picker.isDisabled(), true);
  assert.equal(await picker.getAttribute('placeholder'), 'No LoRAs available');
  // Standalone Studio adopts controls created by its hidden 1px ComfyUI host.
  await page.evaluate(async () => {
    const frame = document.createElement('iframe');
    frame.id = 'lora-host-test';
    frame.style.cssText = 'width:1px;height:1px;position:fixed;opacity:0;pointer-events:none';
    frame.srcdoc = `<script type="module">
      import { createSearchableSelect } from '/extensions/ComfyUI_PromptStudio/js/prompt-studio/ui/searchable-select.js';
      window.picker = createSearchableSelect({items:[{name:'test.safetensors',label:'Test host LoRA'}], label:'Host LoRA'});
    </script>`;
    document.body.append(frame);
  });
  await page.waitForFunction(() => document.querySelector('#lora-host-test').contentWindow.picker);
  await page.evaluate(() => {
    const control = document.querySelector('#lora-host-test').contentWindow.picker.element;
    control.id = 'adopted-lora-test';
    control.style.cssText = 'position:fixed;left:60px;top:250px;width:240px;z-index:200';
    document.querySelector('#promptstudio-prompt-studio').append(control);
  });
  const adopted = page.locator('#adopted-lora-test');
  await adopted.getByRole('combobox').click();
  const anchor = await adopted.getByRole('combobox').boundingBox();
  const popup = await adopted.getByRole('listbox').boundingBox();
  assert.ok(Math.abs(popup.x - anchor.x) <= 1 && Math.abs(popup.y - anchor.y - anchor.height - 4) <= 1,
    `Adopted dropdown must use the visible page viewport: ${JSON.stringify({anchor, popup})}`);
  await adopted.getByRole('option').click();
  assert.equal(await adopted.getByRole('combobox').getAttribute('aria-expanded'), 'false');
  assert.deepEqual(fixture.errors, []);
  console.log('LoRA search: filtering, keyboard/mouse, add/remove, strengths, empty states and narrow layout passed.');
} finally {
  await fixture.close();
}
