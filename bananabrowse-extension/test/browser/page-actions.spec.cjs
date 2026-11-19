const path = require('node:path');
const { mkdirSync } = require('node:fs');
const { createRequire } = require('node:module');
const localRequire = createRequire(path.join(__dirname, '../../../bananabrowse-mcp/package.json'));
const { test, expect, chromium, firefox } = localRequire('@playwright/test');
const { loadPageHelper } = require('./page-helper.cjs');
const runHelper = (page, helper, operation, args = {}) =>
  page.evaluate(({ source, operation, args }) => (0, eval)(`(${source})`)(operation, args), {
    source: helper.toString(),
    operation,
    args,
  });
async function launchBrowser(engine) {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = path.resolve(__dirname, '../../test-results/browser-runtime');
  mkdirSync(process.env.TMPDIR, { recursive: true });
  try {
    return await engine.launch({ headless: true });
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
}

for (const [name, engine] of [
  ['chrome', chromium],
  ['firefox', firefox],
]) {
  test(`${name}: exact discovery matches original names and text while outbound field data stays redacted`, async () => {
    const { pageHelper } = await loadPageHelper();
    const browser = await launchBrowser(engine);
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <input type="checkbox" value="on">
        <label for="phone">Phone<input value="nested-input-secret"></label>
        <input id="phone" type="tel" value="fixture-private-value" aria-invalid="true" aria-describedby="error">
        <p id="error">Rejected fixture-private-value <span contenteditable>editable-secret</span></p>
        <div id="legacy" onclick="this.dataset.clicked='yes'" aria-label="Continue action">
          <span>Legacy Confirm</span><input value="legacy-input-secret"><span contenteditable>legacy-editable-secret</span>
        </div>
        <label for="echo">Account fixture-private-value</label><input id="echo" value="fixture-private-value">
      `);
      const run = (operation, args = {}) => runHelper(page, pageHelper, operation, args);
      const phone = await run('find_elements', { label: 'Phone' });
      expect(phone.matched_count).toBe(1);
      expect(phone.elements[0]).toMatchObject({ id: 'phone', tag: 'input' });
      expect(phone.elements[0].name).toContain('[redacted]');
      const legacy = await run('find_elements', { text: 'Legacy Confirm' });
      expect(legacy.matched_count).toBe(1);
      expect(legacy.elements[0].id).toBe('legacy');
      const named = await run('find_elements', { text: 'Continue action' });
      expect(named.elements[0].ref).toBe(legacy.elements[0].ref);
      const echo = await run('find_elements', { label: 'Account fixture-private-value' });
      expect(echo.matched_count).toBe(1);
      expect(echo.elements[0].id).toBe('echo');
      expect((await run('find_elements', { text: 'editable-secret' })).matched_count).toBe(0);
      expect((await run('find_elements', { text: 'legacy-input-secret' })).matched_count).toBe(0);
      const inspected = await run('inspect_form');
      const snapshot = await run('get_page_snapshot');
      const output = JSON.stringify({ phone, legacy, named, echo, inspected, snapshot });
      for (const secret of [
        'fixture-private-value',
        'nested-input-secret',
        'editable-secret',
        'legacy-input-secret',
        'legacy-editable-secret',
      ])
        expect(output).not.toContain(secret);
      const currentLegacy = await run('find_elements', { text: 'Legacy Confirm' });
      await run('click', { ref: currentLegacy.elements[0].ref, document: currentLegacy.document });
      await expect(page.locator('#legacy')).toHaveAttribute('data-clicked', 'yes');
    } finally {
      await browser.close();
    }
  });

  test(`${name}: form inspection distinguishes application errors, redacts linked content and exposes constraints and options`, async () => {
    const { pageHelper } = await loadPageHelper();
    const browser = await launchBrowser(engine);
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <form id="form">
          <label for="phone">Phone <span>5551234567</span><input value="label-secret"></label>
          <input id="phone" type="tel" required pattern="[0-9]{10}" minlength="10" maxlength="10"
            value="5551234567" aria-invalid="true" aria-describedby="phone-help" aria-errormessage="phone-error">
          <p id="phone-help">Use ten digits for 5551234567 <input value="helper-secret"></p>
          <p id="phone-error">Phone 5551234567 is not accepted <span contenteditable>editable-secret</span></p>
          <label for="country">Country</label><select id="country" required>
            <option value="">Choose country</option><option value="private-option-token">Canada</option>
          </select>
        </form>
      `);
      const run = (operation, args = {}) => runHelper(page, pageHelper, operation, args);
      const before = await page.evaluate(() => ({ focus: document.activeElement.tagName, x: scrollX, y: scrollY }));
      const result = await run('inspect_form', { selector: '#form' });
      const phone = result.elements.find((field) => field.tag === 'input' && field.type === 'tel');
      expect(phone).toMatchObject({
        required: true,
        constraints: { pattern: '[0-9]{10}', minlength: '10', maxlength: '10' },
        native_validity: { valid: true, issues: [] },
        aria_invalid: 'true',
        application_validation: 'invalid',
      });
      expect(phone.validation_messages.join(' ')).toContain('is not accepted');
      expect(result.application_acceptance).toBe('unknown');
      const country = result.elements.find((field) => field.tag === 'select');
      expect(country.options[1]).toEqual({ index: 1, label: 'Canada', disabled: false });
      expect(country.recommended_tool).toBe('select_option');
      for (const secret of ['5551234567', 'label-secret', 'helper-secret', 'editable-secret', 'private-option-token'])
        expect(JSON.stringify(result)).not.toContain(secret);
      expect(await page.evaluate(() => ({ focus: document.activeElement.tagName, x: scrollX, y: scrollY }))).toEqual(
        before,
      );
      const snapshot = await run('get_page_snapshot');
      expect(snapshot.elements.find((field) => field.name.startsWith('Phone'))).toMatchObject({
        valid: true,
        aria_invalid: 'true',
        application_validation: 'invalid',
      });
      expect(await run('type_text', { selector: '#country', text: 'wrong operation' })).toMatchObject({
        error: 'ELEMENT_NOT_EDITABLE',
        recommended_tool: 'select_option',
        recommended_action: 'select_option',
      });
      expect(await run('select_option', { selector: '#country', index: 1 })).toMatchObject({ selected: true });
      await expect(page.locator('#country')).toHaveValue('private-option-token');
    } finally {
      await browser.close();
    }
  });

  test(`${name}: ranked snapshots deduplicate inherited pointers and scoped discovery crosses only open roots`, async () => {
    const { pageHelper } = await loadPageHelper();
    const browser = await launchBrowser(engine);
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <header>${Array.from({ length: 10 }, (_, index) => `<a href="#nav${index}" style="cursor:pointer"><span><span>Navigation ${index}</span></span></a>`).join('')}</header>
        <main><form><label for="name">Name</label><input id="name"></form>
          <section id="first"><button>Continue</button><button>10:00</button></section>
          <section id="second"><button>Continue</button><div id="shadow"></div></section>
          <div id="custom" style="cursor:pointer" onclick="this.dataset.clicked='yes'"><span>Custom action</span><button>Nested action</button></div>
          <label for="check">Enable option</label><input id="check" type="checkbox" style="opacity:0">
        </main>
      `);
      await page.locator('#shadow').evaluate((element) => {
        element.attachShadow({ mode: 'open' }).innerHTML = '<button>10:00</button>';
      });
      const run = (operation, args = {}) => runHelper(page, pageHelper, operation, args);
      const snapshot = await run('get_page_snapshot', { max_elements: 100 });
      expect(snapshot.elements[0]).toMatchObject({ tag: 'input', name: 'Name' });
      expect(snapshot.elements.filter((row) => row.name.startsWith('Navigation'))).toHaveLength(10);
      expect(snapshot.elements.some((row) => row.tag === 'span')).toBe(false);
      expect(snapshot.elements.some((row) => row.tag === 'div' && row.name.includes('Custom action'))).toBe(true);
      expect(snapshot.elements.some((row) => row.tag === 'button' && row.name === 'Nested action')).toBe(true);
      expect(snapshot.elements.some((row) => row.tag === 'label' && row.name === 'Enable option')).toBe(true);
      const container = await run('inspect_element', { selector: '#second' });
      const within = { ref: container.ref, document: container.document };
      expect((await run('find_elements', { text: 'Continue' })).matched_count).toBe(2);
      const found = await run('find_elements', { text: 'Continue', within });
      expect(found.matched_count).toBe(1);
      expect((await run('find_elements', { text: '10:00', within })).matched_count).toBe(1);
      expect(
        await run('find_elements', { text: 'Continue', within: { ...within, document: 'old-document' } }),
      ).toMatchObject({ error: 'TARGET_STALE' });
      await run('click', { ref: found.elements[0].ref, document: found.document });
      await run('get_page_snapshot', { max_elements: 2 });
      expect(await run('find_elements', { text: 'Continue', within })).toMatchObject({ error: 'ELEMENT_STALE' });
    } finally {
      await browser.close();
    }
  });

  test(`${name}: native mixed edits and linked autocomplete suggestions use existing authorized operations`, async () => {
    const { pageHelper } = await loadPageHelper();
    const browser = await launchBrowser(engine);
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <form onsubmit="globalThis.submitted=true; return false">
          <label for="city">City</label><input id="city" role="combobox" aria-controls="suggestions" aria-expanded="true" autocomplete="address-level2">
          <div role="listbox" id="suggestions"><div role="option" onclick="document.querySelector('#city').value='Toronto'; this.parentElement.hidden=true; globalThis.suggestionChosen=true">Toronto, ON</div></div>
          <select id="select"><option value="">Choose</option><option value="ca">Canada</option></select>
          <label for="checkbox">Terms</label><input id="checkbox" type="checkbox">
          <label for="radio">Delivery</label><input id="radio" type="radio">
          <button type="submit">Continue</button>
        </form>
      `);
      const run = (operation, args = {}) => runHelper(page, pageHelper, operation, args);
      expect(await run('type_text', { selector: '#city', text: 'Tor' })).toMatchObject({ typed: true });
      expect(await run('select_option', { selector: '#select', index: 1 })).toMatchObject({ selected: true });
      expect(await run('set_checked', { selector: '#checkbox', checked: true })).toMatchObject({ checked: true });
      expect(await run('set_checked', { selector: '#radio', checked: true })).toMatchObject({ checked: true });
      const inspected = await run('inspect_form');
      const city = inspected.elements.find((field) => field.name === 'City');
      expect(city.suggestions).toHaveLength(1);
      expect(city.suggestions[0].ref).toMatch(/^e\d+$/);
      expect(city.suggestion_action).toBe('click');
      await run('click', { ref: city.suggestions[0].ref, document: inspected.document });
      await expect(page.locator('#city')).toHaveValue('Toronto');
      await expect(page.locator('#checkbox')).toBeChecked();
      await expect(page.locator('#radio')).toBeChecked();
      expect(await page.evaluate(() => globalThis.suggestionChosen)).toBe(true);
      expect(await page.evaluate(() => globalThis.submitted)).toBeUndefined();
    } finally {
      await browser.close();
    }
  });

  test(`${name}: styled hidden checkboxes use bound visible labels, never unrelated overlays or replacements`, async () => {
    const { pageHelper } = await loadPageHelper();
    const browser = await launchBrowser(engine);
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <style>
          #styled-label { display:inline-block; position:relative; width:160px; height:44px }
          #styled { position:absolute; inset:0; width:100%; height:100%; margin:0; opacity:0 }
        </style>
        <label id="styled-label" for="styled">Show navigation<input type="checkbox" id="styled"></label>
        <input type="checkbox" id="other">
        <div id="collapsed" style="display:none"><input type="checkbox" id="inside"></div>
        <label for="inside">Hidden menu item</label>
      `);
      await page.evaluate(() => {
        globalThis.__bananabrowseDocumentNonce = 'fixture-document';
      });
      const run = (operation, args = {}) => runHelper(page, pageHelper, operation, args);
      const diagnostic = await run('inspect_element', { selector: '#styled' });
      expect(diagnostic.reason).toBe('CSS_HIDDEN');
      expect(diagnostic.activation).toMatchObject({
        kind: 'associated_label',
        id: 'styled-label',
        name: 'Show navigation',
      });
      let preview = await run('prepare_action', { selector: '#styled', action: 'set_checked' });
      expect(
        await run('set_checked', { selector: '#styled', checked: true, approval_token: preview.approval_token }),
      ).toMatchObject({ checked: true });
      await expect(page.locator('#styled')).toBeChecked();
      expect(await run('click', { selector: '#styled-label' })).toMatchObject({ clicked: true });
      await expect(page.locator('#styled')).not.toBeChecked();
      await page.evaluate(() => {
        const overlay = document.createElement('div');
        overlay.id = 'site-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:#eee;z-index:100';
        document.body.append(overlay);
      });
      expect(await run('set_checked', { selector: '#styled', checked: true })).toEqual({ error: 'ELEMENT_OBSCURED' });
      await expect(page.locator('#styled')).not.toBeChecked();
      await page.locator('#site-overlay').evaluate((element) => element.remove());
      await page.locator('#styled').evaluate((element) => {
        element.disabled = true;
      });
      expect(await run('set_checked', { selector: '#styled', checked: true })).toEqual({ error: 'ELEMENT_DISABLED' });
      await page.locator('#styled').evaluate((element) => {
        element.disabled = false;
      });
      expect(await run('set_checked', { selector: '#inside', checked: true })).toEqual({
        error: 'ELEMENT_NOT_VISIBLE',
      });
      preview = await run('prepare_action', { selector: '#styled', action: 'set_checked' });
      await page.locator('#styled-label').evaluate((element) => {
        element.htmlFor = 'other';
      });
      expect(
        await run('set_checked', { selector: '#styled', checked: true, approval_token: preview.approval_token }),
      ).toEqual({ error: 'ELEMENT_STALE' });
      await expect(page.locator('#other')).not.toBeChecked();
      await page.locator('#styled-label').evaluate((element) => {
        element.htmlFor = 'styled';
      });
      preview = await run('prepare_action', { selector: '#styled', action: 'set_checked' });
      await page.locator('#styled-label').evaluate((element) => {
        const replacement = element.cloneNode(true);
        element.replaceWith(replacement);
      });
      expect(
        await run('set_checked', { selector: '#styled', checked: true, approval_token: preview.approval_token }),
      ).toEqual({ error: 'ELEMENT_STALE' });
      await expect(page.locator('#styled')).not.toBeChecked();
    } finally {
      await browser.close();
    }
  });

  test(`${name}: inspector reports bounded hiding ancestors and explicit reveal controls without mutating`, async () => {
    const { pageHelper } = await loadPageHelper();
    const browser = await launchBrowser(engine);
    try {
      const page = await browser.newPage();
      await page.setContent(
        '<button id="toggle" aria-controls="drawer" aria-expanded="false">Open navigation</button>' +
          '<div id="drawer" style="display:none"><input id="secret" value="private-input">' +
          '<button id="logout">Logout</button></div>',
      );
      await page.evaluate(() => {
        globalThis.__bananabrowseDocumentNonce = 'fixture-document';
      });
      const before = await page.evaluate(() => ({ focus: document.activeElement.tagName, x: scrollX, y: scrollY }));
      const result = await runHelper(page, pageHelper, 'inspect_element', { selector: '#logout' });
      expect(result.hidden_by).toMatchObject({ id: 'drawer', reason: 'DISPLAY_NONE', is_target: false });
      expect(result.reveal_controls).toEqual([
        { tag: 'button', id: 'toggle', role: 'button', name: 'Open navigation', expanded: 'false' },
      ]);
      expect(JSON.stringify(result)).not.toContain('private-input');
      expect(
        Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(result) }] })),
      ).toBeLessThan(4096);
      expect(await page.evaluate(() => ({ focus: document.activeElement.tagName, x: scrollX, y: scrollY }))).toEqual(
        before,
      );
    } finally {
      await browser.close();
    }
  });

  test(`${name}: read-only diagnostics and approval binding reject responsive replacements`, async () => {
    const { pageHelper } = await loadPageHelper();
    const browser = await launchBrowser(engine);
    try {
      const page = await browser.newPage({ viewport: { width: 610, height: 700 } });
      await page.setContent(
        '<style>@media(max-width:700px){#search{display:none}}#search.open{display:block}</style>' +
          '<button id="toggle">Search</button><label for="search">Search query</label><input id="search" value="private">' +
          '<button id="replace">Original action</button><div class="dup">One</div><div class="dup">Two</div>',
      );
      await page.evaluate(() => {
        globalThis.__bananabrowseDocumentNonce = 'fixture-document';
        document.querySelector('#toggle').onclick = () => document.querySelector('#search').classList.add('open');
      });
      const run = (operation, args = {}) => runHelper(page, pageHelper, operation, args);
      const before = await page.evaluate(() => ({ focus: document.activeElement.tagName, x: scrollX, y: scrollY }));
      const hidden = await run('inspect_element', { selector: '#search' });
      expect(hidden.reason).toBe('ZERO_SIZE');
      expect(hidden.viewport.width).toBe(610);
      expect(JSON.stringify(hidden)).not.toContain('private');
      expect(await page.evaluate(() => ({ focus: document.activeElement.tagName, x: scrollX, y: scrollY }))).toEqual(
        before,
      );
      expect((await run('inspect_element', { selector: '#missing' })).state).toBe('missing');
      expect((await run('inspect_element', { selector: '.dup' })).state).toBe('ambiguous');
      await run('click', { selector: '#toggle' });
      expect((await run('inspect_element', { selector: '#search' })).state).toBe('ready');
      await page.setViewportSize({ width: 900, height: 700 });
      expect((await run('inspect_element', { selector: '#search' })).viewport.width).toBe(900);
      const preview = await run('prepare_action', { selector: '#replace', action: 'click' });
      expect(preview.name).toBe('Original action');
      await page.locator('#replace').evaluate((element) => {
        element.outerHTML = '<button id="replace" onclick="globalThis.wrongAction=true">Replaced action</button>';
      });
      expect(await run('click', { selector: '#replace', approval_token: preview.approval_token })).toEqual({
        error: 'ELEMENT_STALE',
      });
      expect(await page.evaluate(() => globalThis.wrongAction)).toBeUndefined();
      await run('release_action', { approval_token: preview.approval_token });
      await page.locator('#search').evaluate((element) => {
        element.onfocus = () => {
          element.outerHTML = '<input id="search" value="untouched">';
        };
      });
      expect(await run('type_text', { selector: '#search', text: 'must not type' })).toEqual({
        error: 'ELEMENT_STALE',
      });
      await expect(page.locator('#search')).toHaveValue('untouched');
    } finally {
      await browser.close();
    }
  });

  test(`${name}: legacy controls, ambiguity candidates and scoped inspection expose usable refs`, async () => {
    const { pageHelper } = await loadPageHelper();
    const browser = await launchBrowser(engine);
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <div id="confirm" onclick="this.dataset.clicked='yes'"><span>Confirm</span></div>
        <button class="next" hidden>Hidden Next</button><div class="next" tabindex="0">Next</div>
        <label id="card-label" for="card">Add Credit/Debit Card</label><input id="card" type="radio" style="opacity:0">
        <label for="amount">Payment Amount</label><input id="amount" required>
        <button id="native">Existing target</button>
        <button aria-label="Next step">Next screen</button>
      `);
      const run = (operation, args = {}) => runHelper(page, pageHelper, operation, args);
      const snapshot = await run('get_page_snapshot');
      expect(snapshot.truncated).toBe(false);
      expect(snapshot.elements.find((element) => element.name === 'Confirm').ref).toMatch(/^e\d+$/);
      const existing = snapshot.elements.find((element) => element.name === 'Existing target');
      const before = await page.evaluate(() => ({ focus: document.activeElement.tagName, x: scrollX, y: scrollY }));
      const found = await run('find_elements', { text: 'Confirm' });
      expect(found.matched_count).toBe(1);
      expect(found.elements[0]).toMatchObject({ tag: 'div', name: 'Confirm', visible: true });
      expect((await run('find_elements', { text: 'Next screen' })).elements[0].name).toBe('Next step');
      expect((await run('find_elements', { text: 'Next step' })).matched_count).toBe(1);
      const labelled = await run('find_elements', { label: 'Payment Amount' });
      expect(labelled.elements[0]).toMatchObject({ value_present: false, valid: false });
      expect((await run('find_elements', { text: 'No such control' })).elements).toEqual([]);
      expect((await run('find_elements', { role: 'radio' })).elements).toEqual([]);
      expect((await run('find_elements', { role: 'radio', include_hidden: true })).elements).toHaveLength(1);
      const ambiguous = await run('inspect_element', { selector: '.next' });
      expect(ambiguous).toMatchObject({ state: 'ambiguous', matches: 2, candidates_truncated: false });
      expect(ambiguous.candidates.map((candidate) => candidate.visible)).toEqual([false, true]);
      expect(await run('click', { selector: '.next' })).toMatchObject({
        error: 'ELEMENT_AMBIGUOUS',
        candidates: ambiguous.candidates,
      });
      const styled = await run('inspect_element', { selector: '#card' });
      expect(styled.activation.ref).toMatch(/^e\d+$/);
      expect(await page.evaluate(() => ({ focus: document.activeElement.tagName, x: scrollX, y: scrollY }))).toEqual(
        before,
      );
      await run('click', { ref: styled.activation.ref, document: styled.document });
      await expect(page.locator('#card')).toBeChecked();
      await run('click', { ref: existing.ref, document: snapshot.document });
      await run('click', { ref: found.elements[0].ref, document: found.document });
      await expect(page.locator('#confirm')).toHaveAttribute('data-clicked', 'yes');
      const scoped = await run('get_page_snapshot', { selector: '#confirm' });
      expect(scoped.elements).toHaveLength(1);
      expect(scoped.elements[0].name).toBe('Confirm');
      expect(await run('click', { ref: found.elements[0].ref, document: found.document })).toMatchObject({
        error: 'ELEMENT_STALE',
      });
      const inspected = await run('inspect_element', { selector: '#confirm' });
      expect(await run('click', { ref: inspected.ref, document: inspected.document })).toMatchObject({ clicked: true });
    } finally {
      await browser.close();
    }
  });

  test(`${name}: form verification reports safe state, known formatting and rejection without values`, async () => {
    const { pageHelper } = await loadPageHelper();
    const browser = await launchBrowser(engine);
    try {
      const page = await browser.newPage();
      await page.setContent(
        '<label for="amount">Amount</label><input id="amount" required><input id="secret" type="password">',
      );
      await page.locator('#amount').evaluate((element) => {
        element.addEventListener('input', () => {
          element.value = Number(element.value).toFixed(2);
        });
      });
      const run = (operation, args = {}) => runHelper(page, pageHelper, operation, args);
      const mismatch = await run('type_text', { selector: '#amount', text: '12' });
      expect(mismatch).toMatchObject({
        error: 'INPUT_NOT_APPLIED',
        input_state: { value_present: true, value_changed: true, value_matches: false, valid: true },
      });
      const formatted = await run('type_text', { selector: '#amount', text: '14', expected_value: '14.00' });
      expect(formatted).toMatchObject({
        typed: true,
        verification: 'expected_formatted_value',
        input_state: { value_present: true, value_matches: true, valid: true },
      });
      await run('type_text', { selector: '#secret', text: 'fixture-payment-secret' });
      const read = await run('get_text', { selector: '#secret' });
      expect(read).toMatchObject({ text: '', empty_reason: 'VALUE_REDACTED', value_present: true });
      const metadata = await run('query_all', {
        selector: '#secret',
        fields: {
          id: { selector: ':scope', attribute: 'id' },
          type: { selector: ':scope', attribute: 'type' },
          value: { selector: ':scope' },
        },
      });
      expect(metadata.rows).toEqual([{ id: 'secret', type: 'password', value: null }]);
      for (const result of [mismatch, formatted, read, metadata, await run('get_page_snapshot')])
        expect(JSON.stringify(result)).not.toContain('fixture-payment-secret');
    } finally {
      await browser.close();
    }
  });
}
