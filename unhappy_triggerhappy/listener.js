'use strict';

var stockMap = require('./stock-map');

// The unit as the sudoers file names it: the argument must match exactly.
var UNIT = 'unhappy-listener.service';
var SOCKET = '/tmp/unhappy-listener.sock';
var CONFIG_BASENAME = 'listener.json';

// Field: [least, most, default], in milliseconds. The listener refuses a
// configuration outside these, so they are held here too.
var TIMING = {
    long_ms: [100, 5000, 400],
    double_ms: [50, 2000, 300],
    debounce_ms: [0, 500, 30]
};

// The timing fields out of a form or a config, each within its range.
function timingFrom(source) {
    var out = {};
    Object.keys(TIMING).forEach(function (field) {
        var range = TIMING[field];
        var value = parseInt(source ? source[field] : undefined, 10);
        if (isNaN(value)) {
            value = range[2];
        }
        out[field] = Math.min(range[1], Math.max(range[0], value));
    });
    return out;
}

// A stored device: a name, as the listener matches it. A remote with several
// event nodes (keyboard, consumer control) has them all under one name, and
// taking the remote over means taking all of them.
function stored(name) {
    return { name: String(name), phys: '', uniq: '' };
}

function parseStored(text) {
    try {
        var value = JSON.parse(text);
        if (!Array.isArray(value)) {
            return [];
        }
        return value
            .filter(function (item) {
                return item && typeof item.name === 'string' && item.name !== '';
            })
            .map(function (item) {
                return stored(item.name);
            });
    } catch (e) {
        return [];
    }
}

// The rows the page shows: one per name among the present key devices that
// are not touchscreens, then the stored names that are not connected.
function rows(present, storedDevices) {
    var byName = [];
    var index = {};

    present.forEach(function (device) {
        if (device.touch || !device.name) {
            return;
        }
        if (index[device.name] === undefined) {
            index[device.name] = byName.length;
            byName.push({ name: device.name, paths: [], present: true, taken: false });
        }
        byName[index[device.name]].paths.push(device.path);
    });
    storedDevices.forEach(function (device) {
        if (index[device.name] !== undefined) {
            byName[index[device.name]].taken = true;
        } else {
            index[device.name] = byName.length;
            byName.push({ name: device.name, paths: [], present: false, taken: true });
        }
    });
    return byName;
}

// The names the switches on the page leave taken over.
function takenDevices(pageRows, data) {
    return pageRows
        .filter(function (row, i) {
            return data && data['take_' + i] === true;
        })
        .map(function (row) {
            return stored(row.name);
        });
}

// What the listener reads: the devices, the timing, and the editor's map as
// short presses. Blank commands are left out.
function configFor(devices, timing, uiFields) {
    var bindings = stockMap.bindingsFromUi(uiFields)
        .map(function (row) {
            var command = String(row.command).replace(/\r/g, '').trim().replace(/\s+/g, ' ');
            if (!command || command.indexOf('\n') !== -1) {
                return null;
            }
            return { key: row.key, press: 'short', command: command };
        })
        .filter(Boolean);

    return {
        devices: devices.map(function (device) {
            return stored(device.name);
        }),
        timing: timingFrom(timing),
        bindings: bindings
    };
}

module.exports = {
    UNIT: UNIT,
    SOCKET: SOCKET,
    CONFIG_BASENAME: CONFIG_BASENAME,
    TIMING: TIMING,
    timingFrom: timingFrom,
    parseStored: parseStored,
    rows: rows,
    takenDevices: takenDevices,
    configFor: configFor
};
