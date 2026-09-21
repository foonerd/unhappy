'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderMap, STOCK_BINDINGS, TRIGGERS_FILE } = require('../unhappy_triggerhappy/stock-map');

const STOCK_LINES = [
    'KEY_MUTE 1 /usr/local/bin/volumio volume toggle',
    'KEY_VOLUMEUP 1 /usr/local/bin/volumio volume plus',
    'KEY_VOLUMEDOWN 1 /usr/local/bin/volumio volume minus',
    'KEY_STOP 1 /usr/local/bin/volumio stop',
    'KEY_PLAY 1 /usr/local/bin/volumio play',
    'KEY_PLAYPAUSE 1 /usr/local/bin/volumio toggle',
    'KEY_NEXTSONG 1 /usr/local/bin/volumio next',
    'KEY_PREVIOUSSONG 1 /usr/local/bin/volumio previous'
];

describe('stock map', function () {
    it('renders the hanger audio.conf command lines', function () {
        const text = renderMap();
        const commands = text.split('\n').filter(function (line) {
            return line.indexOf('KEY_') === 0;
        });

        assert.deepEqual(commands, STOCK_LINES);
        assert.equal(text.includes('playplaylist'), false);
        assert.equal(text.includes('curl'), false);
        assert.equal(STOCK_BINDINGS.length, 8);
    });

    it('names the plugin triggers file, not audio.conf', function () {
        const uninstall = fs.readFileSync(
            path.join(__dirname, '../unhappy_triggerhappy/uninstall.sh'),
            'utf8'
        );

        const commands = uninstall.split('\n').filter(function (line) {
            return line.length > 0 && line.trim().indexOf('#') !== 0;
        }).join('\n');

        assert.equal(TRIGGERS_FILE, '/etc/triggerhappy/triggers.d/unhappy_triggerhappy.conf');
        assert.equal(commands.includes(TRIGGERS_FILE), true);
        assert.equal(commands.includes('audio.conf'), false);
        assert.equal(commands.includes('99-restart-thd-on-hid.rules'), false);
    });
});
