const assert = require('node:assert/strict');

const actionHtml = `
<label for="edit">Account nickname</label><input id="edit">
<input id="private" type="password" value="fixture-password-secret">
<textarea id="private-text">fixture-textarea-secret</textarea>
<div contenteditable="true">fixture-editable-secret</div>
<input id="readonly" readonly value="fixture-readonly-secret">
<button id="disabled" disabled>Disabled action</button>
<button class="duplicate">First</button><button class="duplicate">Second</button>
<label><input id="check" type="checkbox">Enable feature</label>
<label for="select">Colour</label><select id="select"><option value="red">Red</option><option value="blue">Blue</option></select>
<input id="keyboard" aria-label="Keyboard target"><span id="key-result"></span>
<div style="position:relative;width:200px;height:40px">
  <button id="obstructed" style="width:200px;height:40px">Covered action</button>
  <div id="cover" style="position:absolute;inset:0;background:#ccc;z-index:10"></div>
</div>
<div id="scrollable" style="overflow:auto;height:80px;width:200px"><div style="height:600px">Scrollable content</div></div>
<div id="shadow"></div>
<iframe srcdoc="<button>Unshared iframe control</button>"></iframe>
<p hidden>fixture-hidden-secret</p>
<input id="truly-hidden" type="hidden" value="fixture-hidden-value">
<input id="offscreen" aria-label="Off-screen control" style="position:absolute;top:2200px;left:5px;width:3px">
<form action="/submitted" method="post" id="echo-form">
  <label>Customer<input name="custname" type="text"></label>
  <label>Phone<input name="custtel" type="tel"></label>
  <label>Email<input name="custemail" type="email"></label>
  <label>Search<input name="search" type="search"></label>
  <label><input name="size" value="large" type="radio">Large</label>
  <label><input name="topping" value="bacon" type="checkbox">Bacon</label>
  <button id="submit-fixture" type="submit">Submit fixture</button>
</form>
<script>
document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML =
  '<button id="shadow-action">Shadow action</button><span id="shadow-result"></span>';
document.querySelector('#shadow').shadowRoot.querySelector('button').onclick = () => {
  document.querySelector('#shadow').shadowRoot.querySelector('span').textContent = 'Shadow clicked';
};
document.querySelector('#keyboard').onkeydown = event => {
  document.querySelector('#key-result').textContent = event.key;
};
</script>`;

async function exerciseActions(call) {
  async function result(name, args = {}) {
    const response = await call(name, args);
    assert.notEqual(response.isError, true, `${name}: ${JSON.stringify(response.content)}`);
    return JSON.parse(response.content[0].text);
  }
  async function error(name, args, code) {
    const response = await call(name, { timeout_ms: 0, ...args });
    assert.equal(response.isError, true);
    assert.equal(JSON.parse(response.content[0].text).error, code);
  }
  const snapshot = await result('get_page_snapshot');
  assert.equal(snapshot.scope, 'top-level-and-open-shadow-roots');
  assert.equal(snapshot.input_mode, 'dom');
  for (const secret of ['fixture-password-secret', 'fixture-textarea-secret', 'fixture-editable-secret',
    'fixture-readonly-secret', 'fixture-hidden-secret', 'Stop sharing', 'Unshared iframe control']) {
    assert.equal(JSON.stringify(snapshot).includes(secret), false, secret);
  }
  const edit = snapshot.elements.find(element => element.name === 'Account nickname');
  assert.equal(edit.role, 'textbox');
  assert.equal(edit.editable, true);
  assert.equal(edit.value_redacted, true);
  assert.equal(snapshot.elements.find(element => element.name === 'Disabled action').disabled, true);
  const title = await result('get_text', { selector: 'head > title' });
  assert.equal(title.text, snapshot.title);
  assert.equal(title.text_source, 'document_title');
  const hidden = await result('get_text', { selector: 'p[hidden]' });
  assert.equal(hidden.rendered, false);
  assert.equal(hidden.empty_reason, 'NOT_RENDERED');
  assert.equal(hidden.text, '');
  const geometry = await result('get_interactive_elements');
  assert.equal(geometry.coordinate_system, 'viewport');
  assert.equal(geometry.elements.some(element => element.id === 'truly-hidden'), false);
  assert.equal(geometry.elements.find(element => element.id === 'offscreen').in_viewport, false);
  assert.equal(geometry.elements.find(element => element.id === 'disabled').disabled, true);
  const target = { ref: edit.ref, document: snapshot.document };
  await result('type_text', { ...target, text: 'Updated nickname' });
  assert.equal((await result('evaluate_script', { script: 'document.querySelector("#edit").value' })).value, 'Updated nickname');
  await error('click', { selector: '.duplicate' }, 'ELEMENT_AMBIGUOUS');
  await error('click', { selector: '#disabled' }, 'ELEMENT_DISABLED');
  await error('type_text', { selector: '#readonly', text: 'No change' }, 'ELEMENT_READONLY');
  await error('click', { selector: '#obstructed' }, 'ELEMENT_OBSCURED');
  await error('click', { selector: '#missing', timeout_ms: 100 }, 'WAIT_TIMEOUT');
  const missing = await call('get_text', { selector: '#missing', timeout_ms: 100 });
  assert.equal(JSON.parse(missing.content[0].text).last_error, 'ELEMENT_NOT_FOUND');
  assert.equal(JSON.parse(missing.content[0].text).timeout_ms, 100);
  await result('select_option', { selector: '#select', value: 'blue' });
  assert.equal((await result('evaluate_script', { script: 'document.querySelector("#select").value' })).value, 'blue');
  await result('set_checked', { selector: '#check', checked: true });
  await result('set_checked', { selector: '#check', checked: false });
  assert.equal((await result('evaluate_script', { script: 'document.querySelector("#check").checked' })).value, false);
  const keyboard = await result('press_key', { selector: '#keyboard', key: 'Enter' });
  assert.equal(keyboard.native_input, false);
  assert.equal((await result('get_text', { selector: '#key-result' })).text, 'Enter');
  assert.equal((await result('scroll', { selector: '#scrollable', delta_y: 100 })).y, 100);
  const shadow = snapshot.elements.find(element => element.name === 'Shadow action');
  await result('click', { ref: shadow.ref, document: snapshot.document });
  assert.equal((await result('get_text', { selector: '#shadow-result' })).text, 'Shadow clicked');
  await result('evaluate_script', { script: 'document.querySelector("#edit").outerHTML = "<input id=edit>"' });
  await error('type_text', { ...target, text: 'Must not retarget' }, 'ELEMENT_STALE');
  await error('click', { ref: shadow.ref, document: 'different-document' }, 'TARGET_STALE');
  const next = await result('get_page_snapshot');
  assert.equal(next.document, snapshot.document);
  assert.equal(next.elements.some(element => element.ref === shadow.ref), false);
  await error('click', { ref: shadow.ref, document: snapshot.document }, 'ELEMENT_STALE');
  assert.equal((await result('wait_for_page')).state, 'loaded');
  await result('evaluate_script', { script: `(() => {
    const bulk = document.createElement('section');
    bulk.id = 'bulk-fixture';
    const text = document.createElement('p');
    text.id = 'bulk-text'; text.textContent = '界😀\\\\\\n'.repeat(20000);
    bulk.append(text);
    for (let i = 0; i < 150; i++) {
      const button = document.createElement('button');
      button.textContent = 'Bulk button ' + i; bulk.append(button);
    }
    document.body.append(bulk);
    return true;
  })()` });
  for (const name of ['get_page_snapshot', 'get_interactive_elements', 'get_text']) {
    const response = await call(name, name === 'get_text' ? { selector: '#bulk-text' } : {});
    assert.notEqual(response.isError, true);
    assert(Buffer.byteLength(JSON.stringify(response)) <= 16384);
    const data = JSON.parse(response.content[0].text);
    assert.equal(data.truncated, true);
    if (data.elements) assert(data.elements.length <= 50);
    if (data.text) assert(data.text.length <= 4000);
  }
  const focused = await result('get_page_snapshot', { selector: '#scrollable', max_text_chars: 0 });
  assert.equal(focused.text, '');
  assert.equal(focused.elements.some(element => element.name.startsWith('Bulk button')), false);
  const large = await call('evaluate_script', { script: '"x".repeat(100000)' });
  assert.equal(large.isError, true);
  assert.equal(JSON.parse(large.content[0].text).error, 'RESULT_TOO_LARGE');
  const syntax = await call('evaluate_script', { script: 'return document.title;' });
  assert.equal(syntax.isError, true);
  assert.equal(JSON.parse(syntax.content[0].text).error, 'SCRIPT_SYNTAX_ERROR');
  const runtime = await call('evaluate_script', { script: 'throw new Error("fixture runtime error")' });
  assert.equal(runtime.isError, true);
  assert.equal(JSON.parse(runtime.content[0].text).error, 'SCRIPT_RUNTIME_ERROR');
  await result('navigate', { url: `${snapshot.url}?document-change=1` });
  const loaded = await result('wait_for_page');
  assert.notEqual(loaded.document, snapshot.document);
  await error('type_text', { ...target, text: 'Must not cross documents' }, 'TARGET_STALE');
  for (const [name, text] of [
    ['custname', 'Fixture user'], ['custtel', '12345'], ['custemail', 'fixture@example.org'], ['search', 'fixture search'],
  ]) {
    await result('click', { selector: `input[name="${name}"]` });
    assert.equal((await result('evaluate_script', {
      script: `document.activeElement.name`,
    })).value, name);
    await result('type_text', { selector: `input[name="${name}"]`, text });
    assert.equal((await result('evaluate_script', {
      script: `document.querySelector('input[name="${name}"]').value`,
    })).value, text);
  }
  await error('select_option', { selector: 'input[name="size"][value="large"]', value: 'large' }, 'ELEMENT_NOT_EDITABLE');
  await result('click', { selector: 'input[name="size"][value="large"]' });
  await result('set_checked', { selector: 'input[name="topping"][value="bacon"]', checked: true });
  await result('click', { selector: '#submit-fixture' });
  assert.equal((await result('wait_for_page')).state, 'loaded');
  const echo = JSON.parse((await result('get_text', { selector: '#post-result' })).text);
  assert.equal(echo.custname, 'Fixture user');
  assert.equal(echo.custtel, '12345');
  assert.equal(echo.custemail, 'fixture@example.org');
  assert.equal(echo.search, 'fixture search');
  assert.equal(echo.size, 'large');
  assert.equal(echo.topping, 'bacon');
  assert.equal((await result('get_page_snapshot')).title, 'Submitted fixture');
  return snapshot;
}

async function respondToForm(req, res) {
  if (req.method !== 'POST' || !['/submitted', '/submitted-json'].includes(req.url)) return false;
  let body = '';
  for await (const chunk of req) {
    body += chunk.toString();
    assert(body.length <= 8192, 'Unexpected fixture form size');
  }
  const json = JSON.stringify(Object.fromEntries(new URLSearchParams(body)));
  if (req.url === '/submitted-json') {
    res.setHeader('Content-Type', 'application/json');
    res.end(json);
    return true;
  }
  const escaped = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><title>Submitted fixture</title><h1>Submitted</h1><pre id="post-result">${escaped}</pre>`);
  return true;
}

module.exports = { actionHtml, exerciseActions, respondToForm };
