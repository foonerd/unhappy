'use strict';

var libQ = require('kew');
var fs = require('fs-extra');
var spawn = require('child_process').spawn;
var exec = require('child_process').exec;

var control = require('./control');
var stockMap = require('./stock-map');

var LOG_PREFIX = 'Unhappy TriggerHappy: ';
var SYSTEMCTL = '/usr/bin/sudo /bin/systemctl';
var SERVICE = 'triggerhappy';

module.exports = UnhappyTriggerHappy;

function UnhappyTriggerHappy(context) {
    this.context = context;
    this.commandRouter = this.context.coreCommand;
    this.logger = this.context.logger;
    this._cancelPoll = null;
}

UnhappyTriggerHappy.prototype.onVolumioStart = function () {
    var configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
    this.config = new (require('v-conf'))();
    this.config.loadFile(configFile);
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

    return libQ.resolve();
};

UnhappyTriggerHappy.prototype.onStop = function () {
    if (typeof this._cancelPoll === 'function') {
        this._cancelPoll();
        this._cancelPoll = null;
    }
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

        defer.resolve(uiconf);
    }).fail(function (e) {
        self.logger.error(LOG_PREFIX + 'Failed to parse UI config: ' + e);
        defer.reject(new Error());
    });

    return defer.promise;
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
        writeTriggers: function (body) {
            return self._writeTriggers(body);
        },
        restartTriggerhappy: function () {
            return self._restartTriggerhappy();
        }
    }, data)
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

UnhappyTriggerHappy.prototype._restartTriggerhappy = function () {
    var self = this;

    return new Promise(function (resolve, reject) {
        exec(SYSTEMCTL + ' restart ' + SERVICE, { uid: 1000, gid: 1000 }, function (error, stdout, stderr) {
            if (error) {
                self.logger.error(LOG_PREFIX + 'systemctl restart ' + SERVICE + ' failed: ' +
                    (stderr || error.message));
                reject(error);
                return;
            }
            self.logger.info(LOG_PREFIX + 'systemctl restart ' + SERVICE + ' ok');
            resolve();
        });
    });
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
