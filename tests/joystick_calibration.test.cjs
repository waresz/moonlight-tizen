const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Minimal DOM fixture for the real button handlers and window listener.
function setup(saved = null, legacy = null) {
  const listeners = {}, elements = {}, writes = [];
  const gamepad = { id: 'generic', connected: true, axes: [0, 0, 0, 0], buttons: [] };
  let context;
  function element() {
    return {
      style: {}, dataset: {}, children: [],
      appendChild(child) { this.children.push(child); },
      focus() { context.document.activeElement = this; },
      blur() { context.document.activeElement = null; },
      scrollIntoView() {},
    };
  }
  const measure = element(), center = element();
  measure.dataset.measure = center.dataset.center = '0';
  const root = element();
  root.querySelectorAll = selector => selector === '[data-measure]' ? [measure] : selector === '[data-center]' ? [center] : [];
  elements['jc-content'] = root;
  const modal = element();
  modal.style.display = 'block';
  modal.querySelectorAll = () => [];
  modal.querySelector = () => null;
  context = {
    console: { warn() {} },
    window: { addEventListener(type, callback) { listeners[type] = callback; } },
    document: {
      getElementById(id) { return elements[id] ||= element(); },
      createElement: element,
      querySelector() { return null; },
    },
    localStorage: {
      getItem(key) { return key === 'moonlight-joystick-profiles-v5' ? saved : legacy; },
      setItem(key, value) { writes.push(JSON.parse(value)); },
    },
    navigator: { getGamepads() { return [gamepad]; } },
    clearInterval() {}, setInterval() {}, fixtureModal: modal,
  };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '../wasm/platform/joystick_calibration.js'), 'utf8');
  // Expose private UI entry points only in this isolated test context.
  vm.runInContext(source.replace('return {open:open,close:close',
    'return {testRender:function(value){modal=globalThis.fixtureModal;tab=value;render();},testPoll:poll,open:open,close:close'), context);
  const api = context.JoystickCalibration;
  return { api, gamepad, measure, center, elements, context, listeners, writes,
    values: () => api.exportSettings().split(',').map(Number) };
}

test('closing or cancelling capture preserves the saved range and exported settings', () => {
  for (const cancel of ['close', 'button']) {
    const f = setup(), before = f.api.exportSettings();
    f.api.testRender('sticks');
    f.measure.onclick();
    f.gamepad.axes = [-0.8, -0.9, 0, 0]; f.api.testPoll();
    assert.equal(f.api.exportSettings(), before);
    if (cancel === 'close') f.api.close();
    else f.elements['jc-range-cancel'].onclick();
    assert.equal(f.api.exportSettings(), before);
    assert.equal(f.writes.length, 0);
  }
});

test('changing tabs discards a pending capture', () => {
  const f = setup(), before = f.api.exportSettings();
  f.api.testRender('sticks'); f.measure.onclick();
  f.api.testRender('sticks');
  f.elements['jc-range-stop'].onclick();
  assert.equal(f.api.exportSettings(), before);
  assert.equal(f.writes.length, 0);
});

test('incomplete range is rejected, then a complete capture can be saved', () => {
  const f = setup(), before = f.api.exportSettings();
  f.api.testRender('sticks'); f.measure.onclick();
  f.elements['jc-range-stop'].onclick();
  assert.equal(f.api.exportSettings(), before);
  assert.equal(f.writes.length, 0);
  f.gamepad.axes = [-0.8, -0.9, 0, 0]; f.api.testPoll();
  f.gamepad.axes = [0.7, 0.85, 0, 0]; f.api.testPoll();
  f.elements['jc-range-stop'].onclick();
  assert.deepEqual(f.values().slice(28, 36), [-0.8, -0.9, -1, -1, 0.7, 0.85, 1, 1]);
  assert.equal(f.writes.length, 1);
});

test('disconnecting cancels capture and cannot overwrite saved settings', () => {
  const f = setup(), before = f.api.exportSettings();
  f.api.testRender('sticks'); f.measure.onclick();
  f.gamepad.connected = false; f.api.testPoll();
  f.gamepad.connected = true; f.elements['jc-range-stop'].onclick();
  assert.equal(f.api.exportSettings(), before);
  assert.equal(f.writes.length, 0);
});

test('malformed profiles recover valid arrays, permutation and four slot assignments', () => {
  const malformed = {
    profiles: [{name:'Incomplete',settings:{enabled:false}}, null,
      {name:42,settings:{buttons:Array(17).fill(0),centers:[null,2,0.2,0],minimums:[0,0,0.3,-1],maximums:[0,0,-0.3,1],deadzones:[1,-1],invert:['yes',true]}}],
    slots: [2,-1,100,'1',2],
  };
  const f = setup(JSON.stringify(malformed)), values = f.values();
  assert.equal(values.length, 144);
  assert.ok(values.every(Number.isFinite));
  assert.deepEqual(values.slice(1,18), Array.from({length:17},(_,i)=>i));
  assert.deepEqual(values.slice(18,22), [0,0,0.2,0]);
  assert.deepEqual(values.slice(28,36), [-1,-1,-1,-1,1,1,1,1]);
  assert.equal(values[36], 0);
  assert.equal(values[72], 0);
  assert.equal(values[108], 0);
});

test('valid profiles retain their mapping, calibration and assignment', () => {
  const buttons = Array.from({length:17},(_,i)=>i);
  [buttons[0],buttons[10]]=[buttons[10],buttons[0]];
  const settings={enabled:true,buttons,centers:[0.1,0,0,0],minimums:[-0.8,-1,-1,-1],maximums:[0.9,1,1,1],deadzones:[0.1,0],invert:[true,false,false,false]};
  const f=setup(JSON.stringify({profiles:[{name:'Custom',settings}],slots:[0,0,0,0]}));
  assert.deepEqual(f.values().slice(0,36), [1,...buttons,...settings.centers,...settings.deadzones,1,0,0,0,...settings.minimums,...settings.maximums]);
});

test('invalid JSON, missing slots and legacy profiles still export complete settings', () => {
  for (const saved of ['{broken', JSON.stringify({profiles:[{}]})]) {
    const f=setup(saved);
    assert.equal(f.values().length,144);
    assert.ok(f.values().every(Number.isFinite));
  }
  const legacy=setup(null, JSON.stringify({centers:[0.1,0,0,0]}));
  assert.equal(legacy.values()[18],0.1);
});

test('name navigation moves focus without saving and ordinary typing stays native', () => {
  for (const key of ['Enter','ArrowDown','Tab','Escape','BrowserBack']) {
    const f=setup(); f.api.testRender('sticks');
    const input={id:'jc-name',tagName:'INPUT',blur(){f.context.document.activeElement=null;}};
    f.context.document.activeElement=input;
    let prevented=false,stopped=false;
    f.listeners.keydown({key,target:input,preventDefault(){prevented=true;},stopImmediatePropagation(){stopped=true;}});
    const destination=key==='Escape'||key==='BrowserBack'?'jc-name-cancel':'jc-name-save';
    assert.equal(f.context.document.activeElement,f.elements[destination]);
    assert.ok(prevented&&stopped);
    assert.equal(f.writes.length,0);
  }
  for (const key of ['Backspace','a']) {
    const f=setup(); f.api.testRender('sticks');
    const input={id:'jc-name',tagName:'INPUT'}; f.context.document.activeElement=input;
    let prevented=false;
    f.listeners.keydown({key,target:input,preventDefault(){prevented=true;},stopImmediatePropagation(){}});
    assert.equal(prevented,false);
    assert.equal(f.context.document.activeElement,input);
  }
});
