'use strict';

var readyLoop = require('./ready-loop');
var stockMap = require('./stock-map');

// Immediate restart. No ready poll.
function makeHappyNow(env) {
    return env.restartTriggerhappy();
}

// Write the map, then restart. No ready poll.
function saveBindings(env, data) {
    var bindings = stockMap.bindingsFromUi(data);
    var i;

    for (i = 0; i < bindings.length; i++) {
        if (String(bindings[i].command).indexOf('\n') !== -1) {
            return Promise.reject(new Error('binding command must be a single line'));
        }
    }

    return Promise.resolve(env.writeTriggers(stockMap.renderMap(bindings))).then(function () {
        return env.restartTriggerhappy();
    });
}

// On plugin start and on boot, when the forever toggle is on.
function makeHappyForever(env) {
    return readyLoop.pollUntilReady(function () {
        env.restartTriggerhappy();
    });
}

module.exports = {
    makeHappyNow: makeHappyNow,
    saveBindings: saveBindings,
    makeHappyForever: makeHappyForever
};
