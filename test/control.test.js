'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const readyLoop = require('../unhappy_triggerhappy/ready-loop');
const control = require('../unhappy_triggerhappy/control');

describe('now and save', function () {
    it('do not poll', async function () {
        let polls = 0;
        let restarts = 0;
        let writes = 0;
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
                restartTriggerhappy: function () {
                    restarts += 1;
                },
                writeTriggers: function () {
                    writes += 1;
                }
            });
        } finally {
            readyLoop.pollUntilReady = original;
        }

        assert.equal(polls, 0);
        assert.equal(writes, 1);
        assert.equal(restarts, 2);
    });
});
