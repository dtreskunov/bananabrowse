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
  const target = { ref: edit.ref, document: snapshot.document };
  await result('type_text', { ...target, text: 'Updated nickname' });
  assert.equal((await result('evaluate_script', { script: 'document.querySelector("#edit").value' })).value, 'Updated nickname');
  await error('click', { selector: '.duplicate' }, 'ELEMENT_AMBIGUOUS');
  await error('click', { selector: '#disabled' }, 'ELEMENT_DISABLED');
  await error('type_text', { selector: '#readonly', text: 'No change' }, 'ELEMENT_READONLY');
  await error('click', { selector: '#obstructed' }, 'ELEMENT_OBSCURED');
  await error('click', { selector: '#missing', timeout_ms: 100 }, 'WAIT_TIMEOUT');
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
  await result('navigate', { url: `${snapshot.url}?document-change=1` });
  const loaded = await result('wait_for_page');
  assert.notEqual(loaded.document, snapshot.document);
  await error('type_text', { ...target, text: 'Must not cross documents' }, 'TARGET_STALE');
  return snapshot;
}

module.exports = { actionHtml, exerciseActions };
