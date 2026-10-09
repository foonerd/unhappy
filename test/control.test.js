'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const readyLoop = require('../unhappy_triggerhappy/ready-loop');
const control = require('../unhappy_triggerhappy/control');
const stockMap = require('../unhappy_triggerhappy/stock-map');

const STOCK_AUDIO = [
    'KEY_MUTE 1 /usr/local/bin/volumio volume toggle',
    'KEY_VOLUMEUP 1 /usr/local/bin/volumio volume plus',
    'KEY_VOLUMEDOWN 1 /usr/local/bin/volumio volume minus',
    'KEY_STOP 1 /usr/local/bin/volumio stop',
    'KEY_PLAY 1 /usr/local/bin/volumio play',
    'KEY_PLAYPAUSE 1 /usr/local/bin/volumio toggle',
    'KEY_NEXTSONG 1 /usr/local/bin/volumio next',
    'KEY_PREVIOUSSONG 1 /usr/local/bin/volumio previous'
].join('\n') + '\n';

function stockUi(overrides) {
    const data = { more_happy: true };
    stockMap.STOCK_BINDINGS.forEach(function (row) {
        data[row.field] = row.command;
    });
    if (overrides) {
        Object.keys(overrides).forEach(function (key) {
            data[key] = overrides[key];
        });
    }
    return data;
}

describe('now and save', function () {
    it('do not poll', async function () {
        let polls = 0;
        let restarts = 0;
        let writes = 0;
        let removes = 0;
        const original = readyLoop.pollUntilReady;

        readyLoop.pollUntilReady = function () {
            polls += 1;
            throw new Error('polled');
        };

        try {
            await control.makeHappyNow({
                restartTriggerhappy: function () {
                    restarts += 1;
                }
            });
            await control.saveBindings({
                readForeignTriggers: function () {
                    return [];
                },
                writeTriggers: function () {
                    writes += 1;
                },
                removeTriggers: function () {
                    removes += 1;
                },
                restartTriggerhappy: function () {
                    restarts += 1;
                }
            }, stockUi({ key_playpause: '/usr/local/bin/volumio next' }));
        } finally {
            readyLoop.pollUntilReady = original;
        }

        assert.equal(polls, 0);
        assert.equal(writes, 1);
        assert.equal(removes, 0);
        assert.equal(restarts, 2);
    });

    it('now does not write the plugin conf', async function () {
        let writes = 0;
        let removes = 0;
        let reads = 0;

        await control.makeHappyNow({
            readForeignTriggers: function () {
                reads += 1;
                return [];
            },
            writeTriggers: function () {
                writes += 1;
            },
            removeTriggers: function () {
                removes += 1;
            },
            restartTriggerhappy: function () {
            }
        });

        assert.equal(reads, 0);
        assert.equal(writes, 0);
        assert.equal(removes, 0);
    });
});

describe('binding write differences only', function () {
    it('does not write identical stock lines already in audio.conf', async function () {
        let writes = 0;
        let removes = 0;
        let written = null;
        let restarts = 0;

        await control.saveBindings({
            readForeignTriggers: function () {
                return [STOCK_AUDIO];
            },
            writeTriggers: function (body) {
                writes += 1;
                written = body;
            },
            removeTriggers: function () {
                removes += 1;
            },
            restartTriggerhappy: function () {
                restarts += 1;
            }
        }, stockUi());

        assert.equal(writes, 0);
        assert.equal(written, null);
        assert.equal(removes, 1);
        assert.equal(restarts, 1);
    });

    it('writes only the key that differs from foreign confs', async function () {
        let writes = 0;
        let removes = 0;
        let written = '';

        await control.saveBindings({
            readForeignTriggers: function () {
                return [STOCK_AUDIO];
            },
            writeTriggers: function (body) {
                writes += 1;
                written = body;
            },
            removeTriggers: function () {
                removes += 1;
            },
            restartTriggerhappy: function () {
            }
        }, stockUi({ key_playpause: '/usr/local/bin/volumio pause' }));

        const commands = written.split('\n').filter(function (line) {
            return line.indexOf('KEY_') === 0;
        });

        assert.equal(writes, 1);
        assert.equal(removes, 0);
        assert.deepEqual(commands, [
            'KEY_PLAYPAUSE 1 /usr/local/bin/volumio pause'
        ]);
        assert.equal(written.includes('KEY_MUTE'), false);
        assert.equal(written.includes('volume toggle'), false);
    });

    it('removes the plugin conf when More Happy is turned off', async function () {
        let writes = 0;
        let removes = 0;
        let restarts = 0;
        let reads = 0;

        await control.saveBindings({
            readForeignTriggers: function () {
                reads += 1;
                return [STOCK_AUDIO];
            },
            writeTriggers: function () {
                writes += 1;
            },
            removeTriggers: function () {
                removes += 1;
            },
            restartTriggerhappy: function () {
                restarts += 1;
            }
        }, stockUi({ more_happy: false }));

        assert.equal(reads, 0);
        assert.equal(writes, 0);
        assert.equal(removes, 1);
        assert.equal(restarts, 1);
    });
});
