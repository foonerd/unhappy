'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const listener = require('../unhappy_triggerhappy/listener');

const REMOTE_KBD = { name: '2.4G Composite Devic', phys: 'usb-1/input0', uniq: '', path: '/dev/input/event6', touch: false };
const REMOTE_CC = { name: '2.4G Composite Devic', phys: 'usb-1/input2', uniq: '', path: '/dev/input/event7', touch: false };
const HDMI = { name: 'vc4-hdmi-0', phys: 'vc4-hdmi-0/input0', uniq: '', path: '/dev/input/event1', touch: false };
const TOUCH = { name: 'Goodix Capacitive TouchScreen', phys: 'input/ts', uniq: '', path: '/dev/input/event5', touch: true };

const PLAY = { key: 'KEY_PLAYPAUSE', press: 'short', command: '/usr/local/bin/volumio toggle' };
const STOP = { key: 'KEY_PLAYPAUSE', press: 'long', command: '/usr/local/bin/volumio stop' };
const NEXT = { key: 'KEY_NEXTSONG', press: 'short', command: '/usr/local/bin/volumio next' };

describe('timing', function () {
    it('fills defaults and clamps to the listener ranges', function () {
        assert.deepEqual(listener.timingFrom({}), { long_ms: 400, double_ms: 300, debounce_ms: 30 });
        assert.deepEqual(listener.timingFrom({ long_ms: '5', double_ms: 9999, debounce_ms: 'x' }), {
            long_ms: 100,
            double_ms: 2000,
            debounce_ms: 30
        });
        assert.deepEqual(listener.timingFrom({ long_ms: '650', double_ms: '250', debounce_ms: '0' }), {
            long_ms: 650,
            double_ms: 250,
            debounce_ms: 0
        });
    });
});

describe('rows', function () {
    it('groups a remote with several event nodes under one name and leaves touchscreens out', function () {
        const rows = listener.rows([HDMI, TOUCH, REMOTE_KBD, REMOTE_CC], []);
        assert.deepEqual(rows, [
            { name: 'vc4-hdmi-0', paths: ['/dev/input/event1'], present: true, taken: false },
            { name: '2.4G Composite Devic', paths: ['/dev/input/event6', '/dev/input/event7'], present: true, taken: false }
        ]);
    });

    it('marks stored names taken and lists an unplugged one as not present', function () {
        const stored = listener.parseStored('[{"name":"2.4G Composite Devic"},{"name":"Old Remote"}]');
        const rows = listener.rows([REMOTE_KBD], stored);
        assert.deepEqual(rows, [
            { name: '2.4G Composite Devic', paths: ['/dev/input/event6'], present: true, taken: true },
            { name: 'Old Remote', paths: [], present: false, taken: true }
        ]);
    });

    it('reads nothing from a bad stored value', function () {
        assert.deepEqual(listener.parseStored('nonsense'), []);
        assert.deepEqual(listener.parseStored('{"name":"x"}'), []);
        assert.deepEqual(listener.parseStored('[{"nope":1},{"name":""}]'), []);
    });
});

describe('taken devices', function () {
    it('keeps the names whose switches are on, by name only', function () {
        const rows = listener.rows([HDMI, REMOTE_KBD], []);
        const taken = listener.takenDevices(rows, { take_1: true, take_0: false });
        assert.deepEqual(taken, [{ name: '2.4G Composite Devic', phys: '', uniq: '' }]);
        assert.deepEqual(listener.takenDevices(rows, {}), []);
    });
});

describe('bindings', function () {
    it('seeds the editor map as short presses and drops blank commands', function () {
        const seed = listener.seedBindings({ key_playpause: '/usr/local/bin/volumio  pause', key_stop: '  ' });
        assert.equal(seed.length, 7);
        assert.deepEqual(seed.find(function (b) { return b.key === 'KEY_PLAYPAUSE'; }), {
            key: 'KEY_PLAYPAUSE',
            press: 'short',
            command: '/usr/local/bin/volumio pause'
        });
        assert.equal(seed.some(function (b) { return b.key === 'KEY_STOP'; }), false);
    });

    it('parses a stored list and leaves out rows that do not hold up', function () {
        const text = JSON.stringify([
            PLAY,
            { key: 'KEY_X', press: 'hold', command: 'x' },
            { key: 'lowercase', press: 'short', command: 'x' },
            { key: 'KEY_NEXTSONG', command: '  /usr/local/bin/volumio   next ' },
            { key: 'KEY_STOP', press: 'short', command: 'a\nb' },
            'junk'
        ]);
        assert.deepEqual(listener.parseBindings(text), [PLAY, NEXT]);
        assert.deepEqual(listener.parseBindings('nope'), []);
    });

    it('edits, removes, and adds rows from the saved form', function () {
        const result = listener.bindingsFromForm([PLAY, STOP, NEXT], {
            b0_key: 'KEY_PLAYPAUSE',
            b0_press: { value: 'short', label: 'short' },
            b0_command: '/usr/local/bin/volumio  toggle',
            b1_remove: true,
            b2_key: 'KEY_NEXTSONG',
            b2_press: 'double',
            b2_command: '/usr/local/bin/volumio next',
            new_key: ' KEY_VOLUMEUP ',
            new_press: { value: 'long', label: 'long' },
            new_command: '/usr/local/bin/volumio volume plus'
        });
        assert.deepEqual(result.errors, []);
        assert.deepEqual(result.bindings, [
            PLAY,
            { key: 'KEY_NEXTSONG', press: 'double', command: '/usr/local/bin/volumio next' },
            { key: 'KEY_VOLUMEUP', press: 'long', command: '/usr/local/bin/volumio volume plus' }
        ]);
    });

    it('keeps rows the form did not send and ignores an empty new row', function () {
        const result = listener.bindingsFromForm([PLAY, NEXT], { new_key: '', new_command: '' });
        assert.deepEqual(result.errors, []);
        assert.deepEqual(result.bindings, [PLAY, NEXT]);
    });

    it('refuses a bad key, a bad press, a blank or multi-line command, and a pair bound twice', function () {
        const bad = listener.bindingsFromForm([PLAY, NEXT], {
            b0_key: 'playpause',
            b1_command: 'a\nb'
        });
        assert.deepEqual(bad.bindings, [PLAY, NEXT]);
        assert.deepEqual(bad.errors, [
            'row 1: playpause is not a key name',
            'row 2: KEY_NEXTSONG short has no single-line command'
        ]);

        const twice = listener.bindingsFromForm([PLAY, NEXT], {
            new_key: 'KEY_NEXTSONG',
            new_press: 'short',
            new_command: 'x'
        });
        assert.deepEqual(twice.bindings, [PLAY, NEXT]);
        assert.deepEqual(twice.errors, ['new binding: KEY_NEXTSONG short is bound twice']);

        const press = listener.bindingsFromForm([], { new_key: 'KEY_A', new_press: 'hold', new_command: 'x' });
        assert.match(press.errors[0], /hold is not a press/);
        const blank = listener.bindingsFromForm([], { new_key: 'KEY_A', new_command: '   ' });
        assert.match(blank.errors[0], /has no single-line command/);
        const noKey = listener.bindingsFromForm([], { new_key: '', new_command: 'x' });
        assert.match(noKey.errors[0], /new binding: no key name/);
    });

    it('writes the listener config from the list', function () {
        const config = listener.configFor([{ name: 'Remote' }], { long_ms: 500 }, [PLAY, STOP]);
        assert.deepEqual(config, {
            devices: [{ name: 'Remote', phys: '', uniq: '' }],
            timing: { long_ms: 500, double_ms: 300, debounce_ms: 30 },
            bindings: [PLAY, STOP]
        });
    });
});
