'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const listener = require('../unhappy_triggerhappy/listener');

const REMOTE_KBD = { name: '2.4G Composite Devic', phys: 'usb-1/input0', uniq: '', path: '/dev/input/event6', touch: false };
const REMOTE_CC = { name: '2.4G Composite Devic', phys: 'usb-1/input2', uniq: '', path: '/dev/input/event7', touch: false };
const HDMI = { name: 'vc4-hdmi-0', phys: 'vc4-hdmi-0/input0', uniq: '', path: '/dev/input/event1', touch: false };
const TOUCH = { name: 'Goodix Capacitive TouchScreen', phys: 'input/ts', uniq: '', path: '/dev/input/event5', touch: true };

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

describe('taken devices and the listener config', function () {
    it('keeps the names whose switches are on, by name only', function () {
        const rows = listener.rows([HDMI, REMOTE_KBD], []);
        const taken = listener.takenDevices(rows, { take_1: true, take_0: false });
        assert.deepEqual(taken, [{ name: '2.4G Composite Devic', phys: '', uniq: '' }]);
        assert.deepEqual(listener.takenDevices(rows, {}), []);
    });

    it('writes the stock editor as short presses and drops blank commands', function () {
        const config = listener.configFor(
            [{ name: 'Remote' }],
            { long_ms: 500 },
            { key_playpause: '/usr/local/bin/volumio  pause', key_stop: '  ' }
        );
        assert.deepEqual(config.devices, [{ name: 'Remote', phys: '', uniq: '' }]);
        assert.deepEqual(config.timing, { long_ms: 500, double_ms: 300, debounce_ms: 30 });
        assert.equal(config.bindings.length, 7);
        const playpause = config.bindings.find(function (b) { return b.key === 'KEY_PLAYPAUSE'; });
        assert.deepEqual(playpause, { key: 'KEY_PLAYPAUSE', press: 'short', command: '/usr/local/bin/volumio pause' });
        assert.equal(config.bindings.some(function (b) { return b.key === 'KEY_STOP'; }), false);
    });
});
