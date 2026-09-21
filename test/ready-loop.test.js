'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const { pollUntilReady } = require('../unhappy_triggerhappy/ready-loop');

describe('VOLUMIO_SYSTEM_STATUS poll', function () {
    const previous = process.env.VOLUMIO_SYSTEM_STATUS;

    afterEach(function () {
        if (previous === undefined) {
            delete process.env.VOLUMIO_SYSTEM_STATUS;
        } else {
            process.env.VOLUMIO_SYSTEM_STATUS = previous;
        }
        mock.timers.reset();
    });

    it('restarts once when an early pass reports ready, then stops', function () {
        let restarts = 0;

        mock.timers.enable({ apis: ['setTimeout'] });
        process.env.VOLUMIO_SYSTEM_STATUS = 'starting';
        pollUntilReady(function () {
            restarts += 1;
        });

        assert.equal(restarts, 0);
        mock.timers.tick(1499);
        assert.equal(restarts, 0);

        process.env.VOLUMIO_SYSTEM_STATUS = 'starting';
        mock.timers.tick(1);
        assert.equal(restarts, 0);

        process.env.VOLUMIO_SYSTEM_STATUS = 'ready';
        mock.timers.tick(1499);
        assert.equal(restarts, 0);
        mock.timers.tick(1);
        assert.equal(restarts, 1);

        process.env.VOLUMIO_SYSTEM_STATUS = 'ready';
        mock.timers.tick(1500 * 10);
        assert.equal(restarts, 1);
    });

    it('restarts once when the loop is exhausted', function () {
        let restarts = 0;
        let i;

        mock.timers.enable({ apis: ['setTimeout'] });
        process.env.VOLUMIO_SYSTEM_STATUS = 'starting';
        pollUntilReady(function () {
            restarts += 1;
        });

        for (i = 0; i < 58; i++) {
            mock.timers.tick(1500);
            assert.equal(restarts, 0);
        }

        mock.timers.tick(1500);
        assert.equal(restarts, 1);

        mock.timers.tick(1500 * 10);
        assert.equal(restarts, 1);
    });
});
