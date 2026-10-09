'use strict';

var libQ = require('kew');
var fs = require('fs-extra');
var path = require('path');
var spawn = require('child_process').spawn;
var exec = require('child_process').exec;

var control = require('./control');
var stockMap = require('./stock-map');
var listener = require('./listener');
var devices = require('./devices');
var listenerClient = require('./listener-client');

var LOG_PREFIX = 'Unhappy TriggerHappy: ';
var SYSTEMCTL = '/usr/bin/sudo /bin/systemctl';
var SERVICE = 'triggerhappy';

module.exports = UnhappyTriggerHappy;

function UnhappyTriggerHappy(context) {
    this.context = context;
    this.commandRouter = this.context.coreCommand;
    this.logger = this.context.logger;
    this._cancelPoll = null;
    this._rows = [];
}

UnhappyTriggerHappy.prototype.onVolumioStart = function () {
    var configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
    this.config = new (require('v-conf'))();
    this.config.loadFile(configFile);
    this._configDir = path.dirname(configFile);
    return libQ.resolve();
};

UnhappyTriggerHappy.prototype.getConfigurationFiles = function () {
    return ['config.json'];
};

UnhappyTriggerHappy.prototype.onStart = function () {
    var self = this;

    if (self.config.get('happy_forever') === true) {
        self.logger.info(LOG_PREFIX + 'forever is on, polling VOLUMIO_SYSTEM_STATUS');
        self._cancelPoll = control.makeHappyForever({
            restartTriggerhappy: function () {
                self._restartTriggerhappy().catch(function (err) {
                    self.logger.error(LOG_PREFIX + 'restart failed: ' + err.message);
                });
            }
        });
    }

    if (self.config.get('listener_enabled') === true) {
        self._writeListenerConfig();
        self._systemctl('enable --now ' + listener.UNIT).catch(function (err) {
            self.logger.error(LOG_PREFIX + 'listener start failed: ' + err.message);
        });
    }

    return libQ.resolve();
};

UnhappyTriggerHappy.prototype.onStop = function () {
    var self = this;

    if (typeof self._cancelPoll === 'function') {
        self._cancelPoll();
        self._cancelPoll = null;
    }
    // A stopped plugin holds no remote: the listener goes with it.
    self._systemctl('disable --now ' + listener.UNIT).catch(function (err) {
        self.logger.warn(LOG_PREFIX + 'listener stop failed: ' + err.message);
    });
    return libQ.resolve();
};

UnhappyTriggerHappy.prototype.onRestart = function () {
};

UnhappyTriggerHappy.prototype.getUIConfig = function () {
    var defer = libQ.defer();
    var self = this;
    var langCode = this.commandRouter.sharedVars.get('language_code');

    self.commandRouter.i18nJson(
        __dirname + '/i18n/strings_' + langCode + '.json',
        __dirname + '/i18n/strings_en.json',
        __dirname + '/UIConfig.json'
    ).then(function (uiconf) {
        var forever = self._contentById(uiconf.sections[1], 'happy_forever');
        var more = self._contentById(uiconf.sections[2], 'more_happy');

        forever.value = self.config.get('happy_forever') === true;
        more.value = self.config.get('more_happy') === true;

        stockMap.STOCK_BINDINGS.forEach(function (row) {
            var item = self._contentById(uiconf.sections[2], row.field);
            var stored = self.config.get(row.field);
            item.value = (stored === undefined || stored === null) ? row.command : stored;
        });

        self._fillListenerSection(uiconf.sections[3]);

        self._listenerStatusText().then(function (text) {
            self._contentById(uiconf.sections[3], 'listener_status').value = text;
            defer.resolve(uiconf);
        });
    }).fail(function (e) {
        self.logger.error(LOG_PREFIX + 'Failed to parse UI config: ' + e);
        defer.reject(new Error());
    });

    return defer.promise;
};

// The listener section: the switch and the timing from the config, then one
// "take over" switch per remote, present or stored.
UnhappyTriggerHappy.prototype._fillListenerSection = function (section) {
    var self = this;
    var enabled = self.config.get('listener_enabled') === true;
    var timing = listener.timingFrom({
        long_ms: self.config.get('long_ms'),
        double_ms: self.config.get('double_ms'),
        debounce_ms: self.config.get('debounce_ms')
    });

    self._contentById(section, 'listener_enabled').value = enabled;
    Object.keys(timing).forEach(function (field) {
        self._contentById(section, field).value = timing[field];
    });

    self._rows = listener.rows(devices.list(), listener.parseStored(self.config.get('listener_devices')));
    self._rows.forEach(function (row, i) {
        var where = row.present ? row.paths.join(', ') : self._t('NOT_CONNECTED');
        section.content.push({
            id: 'take_' + i,
            element: 'switch',
            label: self._t('TAKE_OVER') + ': ' + row.name + ' (' + where + ')',
            doc: self._t('TAKE_OVER_DOC'),
            value: row.taken,
            visibleIf: { field: 'listener_enabled', value: true }
        });
        section.saveButton.data.push('take_' + i);
    });
};

UnhappyTriggerHappy.prototype._listenerStatusText = function () {
    var self = this;
    var enabled = self.config.get('listener_enabled') === true;

    return self._listener({ cmd: 'status' }, 2000).then(function (status) {
        var taken = (status.devices || []).length;
        var text = self._t('LISTENER_RUNNING')
            .replace('{taken}', String(taken))
            .replace('{wanted}', String(status.wanted || 0))
            .replace('{bindings}', String(status.bindings || 0));
        if (status.config_error) {
            text += ' (' + status.config_error + ')';
        }
        return text;
    }).catch(function () {
        return self._t(enabled ? 'LISTENER_NOT_RUNNING' : 'LISTENER_STOPPED');
    });
};

UnhappyTriggerHappy.prototype.restartNow = function () {
    var self = this;
    var defer = libQ.defer();

    self._restartTriggerhappy()
        .then(function () {
            self.commandRouter.pushToastMessage('success', 'Unhappy TriggerHappy',
                self._t('RESTARTED'));
            defer.resolve();
        })
        .catch(function (err) {
            self.logger.error(LOG_PREFIX + 'restart now failed: ' + err.message);
            defer.reject(err);
        });

    return defer.promise;
};

UnhappyTriggerHappy.prototype.saveForever = function (data) {
    var self = this;
    var defer = libQ.defer();
    var enabled = data.happy_forever === true;

    self.config.set('happy_forever', enabled);

    if (!enabled && typeof self._cancelPoll === 'function') {
        self._cancelPoll();
        self._cancelPoll = null;
    }

    self.commandRouter.pushToastMessage('success', 'Unhappy TriggerHappy',
        self._t('FOREVER_SAVED'));
    defer.resolve();
    return defer.promise;
};

UnhappyTriggerHappy.prototype.saveBindings = function (data) {
    var self = this;
    var defer = libQ.defer();

    self.config.set('more_happy', data.more_happy === true);
    stockMap.STOCK_BINDINGS.forEach(function (row) {
        if (data[row.field] !== undefined) {
            self.config.set(row.field, data[row.field]);
        }
    });

    control.saveBindings({
        readForeignTriggers: function () {
            return self._readForeignTriggers();
        },
        writeTriggers: function (body) {
            return self._writeTriggers(body);
        },
        removeTriggers: function () {
            return self._removeTriggers();
        },
        restartTriggerhappy: function () {
            return self._restartTriggerhappy();
        }
    }, data)
        .then(function () {
            // One map, two executors: the listener reads the same editor.
            return self._syncListener();
        })
        .then(function () {
            self.commandRouter.pushToastMessage('success', 'Unhappy TriggerHappy',
                self._t('SAVED'));
            defer.resolve();
        })
        .catch(function (err) {
            self.logger.error(LOG_PREFIX + 'save bindings failed: ' + err.message);
            defer.reject(err);
        });

    return defer.promise;
};

UnhappyTriggerHappy.prototype.saveListener = function (data) {
    var self = this;
    var defer = libQ.defer();
    var enabled = data.listener_enabled === true;
    var timing = listener.timingFrom(data);
    var taken = listener.takenDevices(self._rows, data);

    self.config.set('listener_enabled', enabled);
    Object.keys(timing).forEach(function (field) {
        self.config.set(field, timing[field]);
    });
    self.config.set('listener_devices', JSON.stringify(taken));

    var step;
    if (enabled) {
        self._writeListenerConfig();
        step = self._systemctl('enable --now ' + listener.UNIT).then(function () {
            return self._listener({ cmd: 'reload' }, 2000).catch(function () {
                // Just started: it read the file on its way up.
            });
        });
    } else {
        step = self._systemctl('disable --now ' + listener.UNIT);
    }

    step.then(function () {
        self.commandRouter.pushToastMessage('success', 'Unhappy TriggerHappy',
            self._t('LISTENER_SAVED'));
        defer.resolve();
    }).catch(function (err) {
        self.logger.error(LOG_PREFIX + 'save listener failed: ' + err.message);
        self.commandRouter.pushToastMessage('error', 'Unhappy TriggerHappy', err.message);
        defer.reject(err);
    });

    return defer.promise;
};

// The listener's file from the config, and a reload when it is running.
UnhappyTriggerHappy.prototype._syncListener = function () {
    var self = this;

    if (self.config.get('listener_enabled') !== true) {
        return Promise.resolve();
    }
    self._writeListenerConfig();
    return self._listener({ cmd: 'reload' }, 2000).catch(function (err) {
        self.logger.warn(LOG_PREFIX + 'listener reload: ' + err.message);
    });
};

UnhappyTriggerHappy.prototype._writeListenerConfig = function () {
    var self = this;
    var fields = {};

    stockMap.STOCK_BINDINGS.forEach(function (row) {
        var stored = self.config.get(row.field);
        fields[row.field] = (stored === undefined || stored === null) ? row.command : stored;
    });
    var body = listener.configFor(
        listener.parseStored(self.config.get('listener_devices')),
        {
            long_ms: self.config.get('long_ms'),
            double_ms: self.config.get('double_ms'),
            debounce_ms: self.config.get('debounce_ms')
        },
        fields
    );
    var file = path.join(self._configDir, listener.CONFIG_BASENAME);

    fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n');
    self.logger.info(LOG_PREFIX + 'wrote ' + file);
};

UnhappyTriggerHappy.prototype._listener = function (body, timeoutMs) {
    return listenerClient.request(listener.SOCKET, body, timeoutMs);
};

UnhappyTriggerHappy.prototype._systemctl = function (args) {
    var self = this;

    return new Promise(function (resolve, reject) {
        exec(SYSTEMCTL + ' ' + args, { uid: 1000, gid: 1000 }, function (error, stdout, stderr) {
            if (error) {
                self.logger.error(LOG_PREFIX + 'systemctl ' + args + ' failed: ' + (stderr || error.message));
                reject(new Error(stderr || error.message));
                return;
            }
            self.logger.info(LOG_PREFIX + 'systemctl ' + args + ' ok');
            resolve();
        });
    });
};

UnhappyTriggerHappy.prototype._restartTriggerhappy = function () {
    return this._systemctl('restart ' + SERVICE);
};

UnhappyTriggerHappy.prototype._readForeignTriggers = function () {
    var self = this;
    var texts = [];

    try {
        if (!fs.existsSync(stockMap.TRIGGERS_DIR)) {
            return texts;
        }
        var names = fs.readdirSync(stockMap.TRIGGERS_DIR);
        var i;
        for (i = 0; i < names.length; i++) {
            var name = names[i];
            if (!name || name === stockMap.TRIGGERS_BASENAME) {
                continue;
            }
            if (name.slice(-5) !== '.conf') {
                continue;
            }
            try {
                texts.push(fs.readFileSync(path.join(stockMap.TRIGGERS_DIR, name), 'utf8'));
            } catch (err) {
                self.logger.warn(LOG_PREFIX + 'skip unreadable ' + name + ': ' + err.message);
            }
        }
    } catch (err) {
        self.logger.warn(LOG_PREFIX + 'read foreign triggers failed: ' + err.message);
    }

    return texts;
};

UnhappyTriggerHappy.prototype._writeTriggers = function (body) {
    var self = this;

    return new Promise(function (resolve, reject) {
        var child = spawn('/usr/bin/sudo', ['/usr/bin/tee', stockMap.TRIGGERS_FILE], {
            uid: 1000,
            gid: 1000
        });
        var stderr = '';

        child.stderr.on('data', function (chunk) {
            stderr += chunk;
        });
        child.on('error', function (err) {
            reject(err);
        });
        child.on('close', function (code) {
            if (code === 0) {
                self.logger.info(LOG_PREFIX + 'wrote ' + stockMap.TRIGGERS_FILE);
                resolve();
            } else {
                reject(new Error(stderr || ('tee exited ' + code)));
            }
        });
        child.stdin.end(body);
    });
};

UnhappyTriggerHappy.prototype._removeTriggers = function () {
    var self = this;

    return new Promise(function (resolve, reject) {
        exec('/usr/bin/sudo /bin/rm -f ' + stockMap.TRIGGERS_FILE, { uid: 1000, gid: 1000 }, function (error, stdout, stderr) {
            if (error) {
                self.logger.error(LOG_PREFIX + 'remove ' + stockMap.TRIGGERS_FILE + ' failed: ' +
                    (stderr || error.message));
                reject(error);
                return;
            }
            self.logger.info(LOG_PREFIX + 'removed ' + stockMap.TRIGGERS_FILE);
            resolve();
        });
    });
};

UnhappyTriggerHappy.prototype._t = function (key) {
    if (!this._strings) {
        try {
            this._strings = fs.readJsonSync(__dirname + '/i18n/strings_en.json');
        } catch (e) {
            this._strings = {};
        }
    }
    return (this._strings && this._strings[key]) || key;
};

UnhappyTriggerHappy.prototype._contentById = function (section, id) {
    var content = section.content;
    var i;

    for (i = 0; i < content.length; i++) {
        if (content[i].id === id) {
            return content[i];
        }
    }
    return null;
};
