'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const devices = require('../unhappy_triggerhappy/devices');

// A stand-in for /sys/class/input: eventN/device/{name,phys,uniq,capabilities/{key,abs}}.
function fakeSys(entries) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unhappy-sys-'));
    entries.forEach(function (entry) {
        const device = path.join(root, entry.node, 'device', 'capabilities');
        fs.mkdirSync(device, { recursive: true });
        fs.writeFileSync(path.join(root, entry.node, 'device', 'name'), entry.name + '\n');
        fs.writeFileSync(path.join(root, entry.node, 'device', 'phys'), (entry.phys || '') + '\n');
        fs.writeFileSync(path.join(root, entry.node, 'device', 'uniq'), (entry.uniq || '') + '\n');
        fs.writeFileSync(path.join(device, 'key'), entry.key + '\n');
        fs.writeFileSync(path.join(device, 'abs'), (entry.abs || '0') + '\n');
    });
    fs.mkdirSync(path.join(root, 'mice'));
    return root;
}

describe('sysfs device list', function () {
    it('lists key devices in node order with their identity and touch flag', function () {
        const root = fakeSys([
            { node: 'event10', name: 'Remote', phys: 'usb-1/input0', key: '1 0 0 0 10000 ffff', abs: '0' },
            { node: 'event2', name: 'HDMI Jack', phys: 'ALSA', key: '0 0 0', abs: '0' },
            { node: 'event5', name: 'Touch', phys: 'input/ts', key: '400 0 0 0 0 0 0 0 0 0', abs: '2608000 3' },
            { node: 'event1', name: 'Power', phys: 'gpio-keys/input0', key: '100000000000000', abs: '0' }
        ]);
        const found = devices.list(root);
        assert.deepEqual(found.map(function (d) { return [d.name, d.path, d.touch, d.phys]; }), [
            ['Power', '/dev/input/event1', false, 'gpio-keys/input0'],
            ['Touch', '/dev/input/event5', true, 'input/ts'],
            ['Remote', '/dev/input/event10', false, 'usb-1/input0']
        ]);
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('answers nothing where sysfs is missing', function () {
        assert.deepEqual(devices.list('/nonexistent/sys/class/input'), []);
    });
});
