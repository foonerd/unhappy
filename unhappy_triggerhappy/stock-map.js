'use strict';

var VOLUMIO = '/usr/local/bin/volumio';

// Hanger /etc/triggerhappy/triggers.d/audio.conf command lines.
// Event value stays 1, which is the value in that file. This is not audio.conf.
var STOCK_BINDINGS = [
    { field: 'key_mute', key: 'KEY_MUTE', comment: 'MUTE TOGGLE', command: VOLUMIO + ' volume toggle' },
    { field: 'key_volumeup', key: 'KEY_VOLUMEUP', comment: 'VOLUME UP', command: VOLUMIO + ' volume plus' },
    { field: 'key_volumedown', key: 'KEY_VOLUMEDOWN', comment: 'VOLUME DOWN', command: VOLUMIO + ' volume minus' },
    { field: 'key_stop', key: 'KEY_STOP', comment: 'STOP', command: VOLUMIO + ' stop' },
    { field: 'key_play', key: 'KEY_PLAY', comment: 'START', command: VOLUMIO + ' play' },
    { field: 'key_playpause', key: 'KEY_PLAYPAUSE', comment: 'PLAY PAUSE TOGGLE', command: VOLUMIO + ' toggle' },
    { field: 'key_nextsong', key: 'KEY_NEXTSONG', comment: 'NEXT', command: VOLUMIO + ' next' },
    { field: 'key_previoussong', key: 'KEY_PREVIOUSSONG', comment: 'PREVIOUS', command: VOLUMIO + ' previous' }
];

var TRIGGERS_FILE = '/etc/triggerhappy/triggers.d/unhappy_triggerhappy.conf';

function bindingsFromUi(data) {
    return STOCK_BINDINGS.map(function (row) {
        var command = row.command;
        if (data && Object.prototype.hasOwnProperty.call(data, row.field) && data[row.field] !== undefined && data[row.field] !== null) {
            command = String(data[row.field]);
        }
        return {
            field: row.field,
            key: row.key,
            comment: row.comment,
            command: command
        };
    });
}

function renderMap(bindings) {
    var rows = bindings || STOCK_BINDINGS;
    var lines = [
        '# Unhappy TriggerHappy',
        '# Not /etc/triggerhappy/triggers.d/audio.conf',
        '',
        '#VOLUMIO TRIGGERHAPPY CONFIGURATION FILE',
        ''
    ];

    rows.forEach(function (row) {
        var command = String(row.command).replace(/\r/g, '').trim();
        if (!command || command.indexOf('\n') !== -1) {
            return;
        }
        lines.push('#' + row.comment);
        lines.push(row.key + ' 1 ' + command);
        lines.push('#');
    });

    if (lines.length && lines[lines.length - 1] === '#') {
        lines.pop();
    }

    return lines.join('\n') + '\n';
}

module.exports = {
    STOCK_BINDINGS: STOCK_BINDINGS,
    TRIGGERS_FILE: TRIGGERS_FILE,
    bindingsFromUi: bindingsFromUi,
    renderMap: renderMap
};
