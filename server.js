'use strict';

require('dotenv').config();
try {
    process.chdir(__dirname);
} catch (err) {
    // ignore
}

process.title = 'emailengine';

// cache before wild-config
const argv = process.argv.slice(2);

const logger = require('./lib/logger');
const packageData = require('./package.json');

const pathlib = require('path');
const { Worker, SHARE_ENV } = require('worker_threads');
const { redis } = require('./lib/db');
const promClient = require('prom-client');
const fs = require('fs').promises;
const crypto = require('crypto');

const Joi = require('joi');
const { settingsSchema } = require('./lib/schemas');
const settings = require('./lib/settings');
const tokens = require('./lib/tokens');

const config = require('wild-config');
const getSecret = require('./lib/get-secret');

const { getDuration, getByteSize, getBoolean, getWorkerCount, selectRendezvousNode, checkLicense } = require('./lib/tools');
const { MAX_DAYS_STATS, MESSAGE_NEW_NOTIFY, MESSAGE_DELETED_NOTIFY, CONNECT_ERROR_NOTIFY } = require('./lib/consts');
const msgpack = require('msgpack5')();

config.service = config.service || {};

config.workers = config.workers || {
    imap: 4,
    webhooks: 1,
    submit: 1
};

config.dbs = config.dbs || {
    redis: 'redis://127.0.0.1:6379/8'
};

config.log = config.log || {
    level: 'trace'
};

config.api = config.api || {
    port: 3000,
    host: '127.0.0.1'
};

config.smtp = config.smtp || {
    enabled: false,
    port: 2525,
    host: '127.0.0.1',
    secret: '',
    proxy: false
};

const DEFAULT_EENGINE_TIMEOUT = 10 * 1000;
const EENGINE_TIMEOUT = getDuration(process.env.EENGINE_TIMEOUT || config.service.commandTimeout) || DEFAULT_EENGINE_TIMEOUT;
const DEFAULT_MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024;

config.api.maxSize = getByteSize(process.env.EENGINE_MAX_SIZE || config.api.maxSize) || DEFAULT_MAX_ATTACHMENT_SIZE;
config.dbs.redis = process.env.EENGINE_REDIS || process.env.REDIS_URL || config.dbs.redis;

config.workers.imap = getWorkerCount(process.env.EENGINE_WORKERS || config.workers.imap) || 4;

config.workers.webhooks = Number(process.env.EENGINE_WORKERS_WEBHOOKS) || config.workers.webhooks || 1;
config.workers.submit = Number(process.env.EENGINE_WORKERS_SUBMIT) || config.workers.submit || 1;

config.api.port = (process.env.EENGINE_PORT && Number(process.env.EENGINE_PORT)) || config.api.port;
config.api.host = process.env.EENGINE_HOST || config.api.host;

config.log.level = process.env.EENGINE_LOG_LEVEL || config.log.level;

// legacy options, will be removed
const SMTP_ENABLED = 'EENGINE_SMTP_ENABLED' in process.env ? getBoolean(process.env.EENGINE_SMTP_ENABLED) : getBoolean(config.smtp.enabled);
const SMTP_SECRET = process.env.EENGINE_SMTP_SECRET || config.smtp.secret;
const SMTP_PORT = (process.env.EENGINE_SMTP_PORT && Number(process.env.EENGINE_SMTP_PORT)) || Number(config.smtp.port) || 2525;
const SMTP_HOST = process.env.EENGINE_SMTP_HOST || config.smtp.host || '127.0.0.1';
const SMTP_PROXY = 'EENGINE_SMTP_PROXY' in process.env ? getBoolean(process.env.EENGINE_SMTP_PROXY) : getBoolean(config.smtp.proxy);

logger.info({ msg: 'Starting EmailEngine', version: packageData.version, node: process.versions.node });

const NO_ACTIVE_HANDLER_RESP = {
    error: 'No active handler for requested account. Try again later.',
    statusCode: 503
};

const LICENSE_CHECK_TIMEOUT = 15 * 60 * 1000;

const licenseInfo = {
    active: false,
    details: false,
    type: packageData.license
};

let preparedSettings = false;
const preparedSettingsString = process.env.EENGINE_SETTINGS || config.settings;
if (preparedSettingsString) {
    // received a configuration block
    try {
        const { error, value } = Joi.object(settingsSchema).validate(JSON.parse(preparedSettingsString), {
            abortEarly: false,
            stripUnknown: true,
            convert: true
        });

        if (error) {
            throw error;
        }

        preparedSettings = value;
    } catch (err) {
        logger.error({ msg: 'Received invalid settings string', input: preparedSettingsString, err });
        process.exit(1);
    }
}

let preparedToken = false;
const preparedTokenString = process.env.EENGINE_PREPARED_TOKEN || config.preparedToken;
if (preparedTokenString) {
    try {
        preparedToken = msgpack.decode(Buffer.from(preparedTokenString, 'base64url'));
        if (!preparedToken || !/^[0-9a-f]{64}$/i.test(preparedToken.id)) {
            throw new Error('Invalid token format');
        }
    } catch (err) {
        logger.error({ msg: 'Received invalid token string', input: preparedTokenString, err });
        process.exit(1);
    }
}

logger.debug({ msg: 'IMAP Worker Count', workersImap: config.workers.imap });
logger.debug({ msg: 'Webhooks Worker Count', workersWebhooks: config.workers.webhooks });
logger.debug({ msg: 'Submission Worker Count', workersWebhooks: config.workers.submit });

const metrics = {
    threadStarts: new promClient.Counter({
        name: 'thread_starts',
        help: 'Number of started threads'
    }),

    threadStops: new promClient.Counter({
        name: 'thread_stops',
        help: 'Number of stopped threads'
    }),

    apiCall: new promClient.Counter({
        name: 'api_call',
        help: 'Number of API calls',
        labelNames: ['method', 'statusCode', 'route']
    }),

    imapConnections: new promClient.Gauge({
        name: 'imap_connections',
        help: 'Current IMAP connection state',
        labelNames: ['status']
    }),

    webhooks: new promClient.Counter({
        name: 'webhooks',
        help: 'Webhooks sent',
        labelNames: ['status', 'event']
    }),

    events: new promClient.Counter({
        name: 'events',
        help: 'Events fired',
        labelNames: ['event']
    }),

    webhook_req: new promClient.Histogram({
        name: 'webhook_req',
        help: 'Duration of webhook requests',
        buckets: [100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000, 60 * 1000]
    }),

    queues: new promClient.Gauge({
        name: 'queue_size',
        help: 'Queue size',
        labelNames: ['queue']
    })
};

let callQueue = new Map();
let mids = 0;

let closing = false;
let assigning = false;

let unassigned = false;
let assigned = new Map();
let unassignCounter = new Map();
let workerAssigned = new WeakMap();
let onlineWorkers = new WeakSet();

let workers = new Map();
let availableIMAPWorkers = new Set();

let suspendedWorkerTypes = new Set();

const postMessage = (worker, payload, ignoreOffline, transferList) => {
    if (!onlineWorkers.has(worker)) {
        if (ignoreOffline) {
            return false;
        }
        throw new Error('Requested worker thread not available');
    }

    return worker.postMessage(payload, transferList);
};

const countUnassignment = async account => {
    if (!unassignCounter.has(account)) {
        unassignCounter.set(account, []);
    }
    let arr = unassignCounter.get(account);
    arr.push(Date.now());

    if (arr.length > 10) {
        arr = arr.slice(-10);
        unassignCounter.set(account, arr);
    }

    let delay = 0;
    if (arr.length === 1) {
        delay = 0;
    } else {
        let lastDelay = arr[arr.length - 1] - arr[arr.length - 2];
        // if last delay was longer than a minute, then reset
        if (lastDelay >= 60 * 1000) {
            delay = 0;
        } else {
            delay = Math.min(Math.ceil(lastDelay * 1.5), 60 * 1000);
        }
    }

    await redis.hset(`iad:${account}`, 'state', 'disconnected');
    for (let worker of workers.get('api')) {
        let callPayload = {
            cmd: 'change',
            account,
            type: 'state',
            key: 'disconnected',
            payload: null
        };

        try {
            postMessage(worker, callPayload, true);
        } catch (err) {
            logger.error({ msg: 'Failed to post state change to child', worker: worker.threadId, callPayload, err });
        }
    }

    if (delay) {
        await new Promise(resolve => setTimeout(resolve, delay));
        return true;
    } else {
        return false;
    }
};

let clearUnassignmentCounter = account => {
    unassignCounter.delete(account);
};

let updateSmtpServerState = async (state, payload) => {
    await redis.hset(`smtp`, 'state', state);
    if (payload) {
        await redis.hset(`smtp`, 'payload', JSON.stringify(payload));
    }

    if (workers.has('api')) {
        for (let worker of workers.get('api')) {
            let callPayload = {
                cmd: 'change',
                type: 'smtpServerState',
                key: state,
                payload: payload || null
            };

            try {
                postMessage(worker, callPayload, true);
            } catch (err) {
                logger.error({ msg: 'Failed to post state change to child', worker: worker.threadId, callPayload, err });
            }
        }
    }
};

let spawnWorker = async type => {
    if (closing) {
        return;
    }

    if (!workers.has(type)) {
        workers.set(type, new Set());
    }

    if (suspendedWorkerTypes.has(type)) {
        if (type === 'smtp') {
            await updateSmtpServerState('suspended', {});
        }
        return;
    }

    if (type === 'smtp') {
        let smtpEnabled = await settings.get('smtpServerEnabled');
        if (!smtpEnabled) {
            await updateSmtpServerState('disabled', {});
            return;
        }

        await updateSmtpServerState('spawning');
    }

    let worker = new Worker(pathlib.join(__dirname, 'workers', `${type}.js`), {
        argv,
        env: SHARE_ENV,
        trackUnmanagedFds: true
    });
    metrics.threadStarts.inc();

    workers.get(type).add(worker);

    worker.on('online', () => {
        if (type === 'smtp') {
            updateSmtpServerState('initializing').catch(err => logger.error({ msg: 'Failed to update smtp server state', err }));
        }
        onlineWorkers.add(worker);
    });

    let exitHandler = async exitCode => {
        onlineWorkers.delete(worker);
        metrics.threadStops.inc();

        workers.get(type).delete(worker);

        if (type === 'smtp') {
            updateSmtpServerState(suspendedWorkerTypes.has(type) ? 'suspended' : 'exited');
        }

        if (type === 'imap') {
            availableIMAPWorkers.delete(worker);

            if (workerAssigned.has(worker)) {
                let accountList = workerAssigned.get(worker);
                workerAssigned.delete(worker);
                accountList.forEach(account => {
                    assigned.delete(account);
                    let shouldReassign = false;
                    // graceful reconnect
                    countUnassignment(account)
                        .then(sr => {
                            shouldReassign = sr;
                        })
                        .catch(() => {
                            shouldReassign = true;
                        })
                        .finally(() => {
                            unassigned.add(account);
                            if (shouldReassign) {
                                assignAccounts().catch(err => logger.error(err));
                            }
                        });
                });
            }
        }

        if (closing) {
            return;
        }

        // spawning a new worker trigger reassign
        if (suspendedWorkerTypes.has(type)) {
            logger.info({ msg: 'Worker thread closed', exitCode, type });
        } else {
            logger.error({ msg: 'Worker exited', exitCode, type });
        }

        // trigger new spawn
        await new Promise(r => setTimeout(r, 1000));
        await spawnWorker(type);
    };

    worker.on('exit', exitCode => {
        exitHandler(exitCode).catch(err => {
            logger.error({ msg: 'Failed to handle worker exit', exitCode, worker: worker.threadId, err });
        });
    });

    worker.on('message', message => {
        if (!message) {
            return;
        }

        if (message.cmd === 'resp' && message.mid && callQueue.has(message.mid)) {
            let { resolve, reject, timer } = callQueue.get(message.mid);
            clearTimeout(timer);
            callQueue.delete(message.mid);
            if (message.error) {
                let err = new Error(message.error);
                if (message.code) {
                    err.code = message.code;
                }
                if (message.statusCode) {
                    err.statusCode = message.statusCode;
                }
                return reject(err);
            } else {
                return resolve(message.response);
            }
        }

        if (message.cmd === 'call' && message.mid) {
            return onCommand(worker, message.message)
                .then(response => {
                    let callPayload = {
                        cmd: 'resp',
                        mid: message.mid,
                        response
                    };

                    try {
                        postMessage(worker, callPayload);
                    } catch (err) {
                        logger.error({ msg: 'Failed to post state change to child', worker: worker.threadId, callPayload, err });
                    }
                })
                .catch(err => {
                    let callPayload = {
                        cmd: 'resp',
                        mid: message.mid,
                        error: err.message,
                        code: err.code,
                        statusCode: err.statusCode
                    };

                    try {
                        postMessage(worker, callPayload);
                    } catch (err) {
                        logger.error({ msg: 'Failed to post state change to child', worker: worker.threadId, callPayload, err });
                    }
                });
        }

        switch (message.cmd) {
            case 'metrics': {
                let statUpdateKey = false;

                switch (message.key) {
                    // gather for dashboard counter
                    case 'webhooks': {
                        let { status } = message.args[0] || {};
                        statUpdateKey = `${message.key}:${status}`;
                        break;
                    }

                    case 'webhook_req': {
                        break;
                    }

                    case 'events': {
                        let { event } = message.args[0] || {};
                        switch (event) {
                            case MESSAGE_NEW_NOTIFY:
                            case MESSAGE_DELETED_NOTIFY:
                            case CONNECT_ERROR_NOTIFY:
                                statUpdateKey = `${message.key}:${event}`;
                                break;
                        }
                        break;
                    }

                    case 'apiCall': {
                        let { statusCode } = message.args[0] || {};
                        let success = statusCode >= 200 && statusCode < 300;
                        statUpdateKey = `${message.key}:${success ? 'success' : 'fail'}`;
                        break;
                    }
                }

                if (statUpdateKey) {
                    // increment counter in redis

                    let now = new Date();

                    // we keep a separate hash value for each ISO day
                    let dateStr = `${now
                        .toISOString()
                        .substr(0, 10)
                        .replace(/[^0-9]+/g, '')}`;

                    // hash key for bucket
                    let timeStr = `${now
                        .toISOString()
                        // bucket includes 1 minute
                        .substr(0, 16)
                        .replace(/[^0-9]+/g, '')}`;

                    let hkey = `stats:${statUpdateKey}:${dateStr}`;

                    redis
                        .multi()
                        .hincrby(hkey, timeStr, 1)
                        .sadd('stats:keys', statUpdateKey)
                        // keep alive at most 2 days
                        .expire(hkey, MAX_DAYS_STATS + 1 * 24 * 3600)
                        .exec()
                        .catch(() => false);
                }

                if (message.key && metrics[message.key] && typeof metrics[message.key][message.method] === 'function') {
                    metrics[message.key][message.method](...message.args);
                }

                return;
            }

            case 'settings':
                availableIMAPWorkers.forEach(worker => {
                    try {
                        postMessage(worker, message);
                    } catch (err) {
                        logger.error({ msg: 'Failed to post command to child', worker: worker.threadId, callPayload: message, err });
                    }
                });
                return;

            case 'change':
                switch (message.type) {
                    case 'smtpServerState':
                        updateSmtpServerState(message.key, message.payload).catch(err => logger.error({ msg: 'Failed to update smtp server state', err }));
                        break;
                    default:
                        // forward all state changes to the API worker
                        for (let worker of workers.get('api')) {
                            try {
                                postMessage(worker, message, true);
                            } catch (err) {
                                logger.error({ msg: 'Failed to post state change to child', worker: worker.threadId, callPayload: message, err });
                            }
                        }
                }
                break;
        }

        switch (type) {
            case 'imap':
                return processImapWorkerMessage(worker, message);
        }
    });
};

function processImapWorkerMessage(worker, message) {
    if (!message || !message.cmd) {
        logger.debug({ msg: 'Unexpected message', type: 'imap', message });

        return;
    }

    switch (message.cmd) {
        case 'ready':
            availableIMAPWorkers.add(worker);
            // assign pending accounts
            assignAccounts().catch(err => logger.error(err));
            break;
    }
}

async function call(worker, message, transferList) {
    return new Promise((resolve, reject) => {
        let mid = `${Date.now()}:${++mids}`;

        let timer = setTimeout(() => {
            let err = new Error('Timeout waiting for command response [T1]');
            err.statusCode = 504;
            err.code = 'Timeout';
            err.payload = message;
            reject(err);
        }, message.timeout || EENGINE_TIMEOUT);

        callQueue.set(mid, { resolve, reject, timer });

        try {
            postMessage(
                worker,
                {
                    cmd: 'call',
                    mid,
                    message
                },
                false,
                transferList
            );
        } catch (err) {
            callQueue.delete(mid);
            return reject(err);
        }
    });
}

async function assignAccounts() {
    if (assigning) {
        return false;
    }
    assigning = true;
    try {
        if (!unassigned) {
            // first run
            // list all available accounts and assign to worker threads
            let accounts = await redis.smembers('ia:accounts');
            unassigned = new Set(accounts);
        }

        if (!availableIMAPWorkers.size || !unassigned.size) {
            // nothing to do here
            return;
        }

        for (let account of unassigned) {
            if (!availableIMAPWorkers.size) {
                // out of workers
                break;
            }

            let worker = selectRendezvousNode(account, Array.from(availableIMAPWorkers));

            if (!workerAssigned.has(worker)) {
                workerAssigned.set(worker, new Set());
            }

            workerAssigned.get(worker).add(account);
            assigned.set(account, worker);
            unassigned.delete(account);

            await call(worker, {
                cmd: 'assign',
                account
            });
        }
    } finally {
        assigning = false;
    }
}

let licenseCheckTimer = false;
let licenseCheckHandler = async () => {
    if (!licenseInfo.active && !suspendedWorkerTypes.size) {
        logger.info({ msg: 'No active license, shutting down workers after 15 minutes of activity' });

        for (let type of ['imap', 'submit', 'smtp', 'webhooks']) {
            suspendedWorkerTypes.add(type);
            if (workers.has(type)) {
                for (let worker of workers.get(type).values()) {
                    worker.terminate();
                }
            }
        }
    } else {
        if (licenseInfo.active && suspendedWorkerTypes.size) {
            // re-enable missing workers
            for (let type of suspendedWorkerTypes) {
                suspendedWorkerTypes.delete(type);
                switch (type) {
                    case 'smtp':
                        if (SMTP_ENABLED) {
                            // single SMTP interface worker
                            await spawnWorker('smtp');
                        }
                        break;
                    default:
                        if (config.workers && config.workers[type]) {
                            for (let i = 0; i < config.workers[type]; i++) {
                                await spawnWorker(type);
                            }
                        }
                }
            }
        }

        licenseCheckTimer = setTimeout(checkActiveLicense, LICENSE_CHECK_TIMEOUT);
        licenseCheckTimer.unref();
    }
};

function checkActiveLicense() {
    clearTimeout(licenseCheckTimer);
    licenseCheckHandler().catch(err => {
        logger.error('Failed to process license checker', err);
    });
}

async function updateQueueCounters() {
    for (let queue of ['notify', 'submit']) {
        const [resActive, resDelayed] = await redis.multi().llen(`bull:${queue}:active`).zcard(`bull:${queue}:delayed`).exec();
        if (resActive[0] || resDelayed[0]) {
            // counting failed
            logger.error({ msg: 'Failed to count queue length', queue, active: resActive, delayed: resDelayed });
            return false;
        }

        metrics.queues.set({ queue: `${queue}_active` }, Number(resActive[1]) || 0);
        metrics.queues.set({ queue: `${queue}_delayed` }, Number(resDelayed[1]) || 0);
    }
}

async function onCommand(worker, message) {
    switch (message.cmd) {
        case 'metrics':
            await updateQueueCounters();
            return promClient.register.metrics();

        case 'structuredMetrics': {
            let connections = {};

            for (let key of Object.keys(metrics.imapConnections.hashMap)) {
                if (key.indexOf('status:') === 0) {
                    let metric = metrics.imapConnections.hashMap[key];
                    connections[metric.labels.status] = metric.value;
                }
            }
            return { connections };
        }

        case 'license':
            if (!licenseInfo.active && suspendedWorkerTypes.size) {
                return Object.assign({}, licenseInfo, { suspended: true });
            }
            return licenseInfo;

        case 'updateLicense': {
            try {
                const licenseFile = message.license;
                let license = await checkLicense(licenseFile);
                if (!license) {
                    throw new Error('Failed to verify provided license');
                }

                logger.info({ msg: 'Loaded license', license, source: 'API' });

                await redis.hset('settings', 'license', licenseFile);

                licenseInfo.active = true;
                licenseInfo.details = license;
                licenseInfo.type = 'EmailEngine License';

                // re-enable workers
                checkActiveLicense();

                return licenseInfo;
            } catch (err) {
                logger.fatal({ msg: 'Failed to verify provided license', source: 'API', err });
                return false;
            }
        }

        case 'removeLicense': {
            try {
                await redis.hdel('settings', 'license');

                licenseInfo.active = false;
                licenseInfo.details = false;
                licenseInfo.type = packageData.license;

                return licenseInfo;
            } catch (err) {
                logger.fatal({ msg: 'Failed to remove existing license', err });
                return false;
            }
        }

        case 'new':
            unassigned.add(message.account);
            assignAccounts().catch(err => logger.error(err));
            return;

        case 'delete':
            unassigned.delete(message.account); // if set
            clearUnassignmentCounter(message.account);
            if (assigned.has(message.account)) {
                let assignedWorker = assigned.get(message.account);
                if (workerAssigned.has(assignedWorker)) {
                    workerAssigned.get(assignedWorker).delete(message.account);
                    if (!workerAssigned.get(assignedWorker).size) {
                        // last item in the worker accounts
                        workerAssigned.delete(assignedWorker);
                    }
                }

                call(assignedWorker, message)
                    .then(() => logger.debug('worker processed'))
                    .catch(err => logger.error(err));
            }
            return;

        case 'update':
            if (assigned.has(message.account)) {
                let assignedWorker = assigned.get(message.account);
                call(assignedWorker, message)
                    .then(() => logger.debug('worker processed'))
                    .catch(err => logger.error(err));
            }
            return;

        case 'smtpReload':
            {
                let hasWorkers = workers.has('smtp') && workers.get('smtp').size;
                // reload (or kill) SMTP submission worker
                if (hasWorkers) {
                    for (let worker of workers.get('smtp').values()) {
                        worker.terminate();
                    }
                } else {
                    let smtpEnabled = await settings.get('smtpServerEnabled');
                    if (smtpEnabled) {
                        // spawn a new worker
                        await spawnWorker('smtp');
                    }
                }
            }

            break;

        case 'listMessages':
        case 'buildContacts':
        case 'getRawMessage':
        case 'getText':
        case 'getMessage':
        case 'updateMessage':
        case 'moveMessage':
        case 'deleteMessage':
        case 'createMailbox':
        case 'deleteMailbox':
        case 'submitMessage':
        case 'queueMessage':
        case 'uploadMessage':
        case 'getAttachment': {
            if (!assigned.has(message.account)) {
                return NO_ACTIVE_HANDLER_RESP;
            }

            let assignedWorker = assigned.get(message.account);

            let transferList = [];
            if (['getRawMessage', 'getAttachment'].includes(message.cmd) && message.port) {
                transferList.push(message.port);
            }

            if (['submitMessage', 'queueMessage'].includes(message.cmd) && typeof message.raw === 'object') {
                transferList.push(message.raw);
            }

            return await call(assignedWorker, message, transferList);
        }
    }
    return 999;
}

let metricsResult = {};
async function collectMetrics() {
    // reset all counters
    Object.keys(metricsResult || {}).forEach(key => {
        metricsResult[key] = 0;
    });

    if (workers.has('imap')) {
        let imapWorkers = workers.get('imap');
        for (let imapWorker of imapWorkers) {
            if (!availableIMAPWorkers.has(imapWorker)) {
                // worker not available yet
                continue;
            }

            try {
                let workerStats = await call(imapWorker, { cmd: 'countConnections' });
                Object.keys(workerStats || {}).forEach(status => {
                    if (!metricsResult[status]) {
                        metricsResult[status] = 0;
                    }
                    metricsResult[status] += Number(workerStats[status]) || 0;
                });
            } catch (err) {
                logger.error(err);
            }
        }
    }

    Object.keys(metricsResult).forEach(status => {
        metrics.imapConnections.set({ status }, metricsResult[status]);
    });
}

process.on('SIGTERM', () => {
    if (closing) {
        return;
    }
    closing = true;
    setImmediate(() => {
        process.exit();
    });
});

process.on('SIGINT', () => {
    if (closing) {
        return;
    }
    closing = true;
    setImmediate(() => {
        process.exit();
    });
});

// START APPLICATION

const startApplication = async () => {
    if (config.licensePath) {
        try {
            let stat = await fs.stat(config.licensePath);
            if (!stat.isFile()) {
                throw new Error(`Provided license key is not a regular file`);
            }
            const licenseFile = await fs.readFile(config.licensePath, 'utf-8');
            let license = await checkLicense(licenseFile);
            if (!license) {
                throw new Error('Failed to verify provided license key');
            }
            logger.info({ msg: 'Loaded license key', license, source: config.licensePath });
            await redis.hset('settings', 'license', licenseFile);
        } catch (err) {
            logger.fatal({ msg: 'Failed to verify provided license key file', source: config.licensePath, err });
            return process.exit(13);
        }
    }

    const preparedLicenseString = process.env.EENGINE_PREPARED_LICENSE || config.preparedLicense;
    if (preparedLicenseString) {
        try {
            let imported = await settings.importLicense(preparedLicenseString, checkLicense);
            if (imported) {
                logger.info({ msg: 'Imported license key', source: 'import' });
            }
        } catch (err) {
            logger.fatal({ msg: 'Failed to verify provided license key data', source: 'import', err });
            return process.exit(13);
        }
    }

    let licenseFile = await redis.hget('settings', 'license');
    if (licenseFile) {
        try {
            let license = await checkLicense(licenseFile);
            if (!license) {
                throw new Error('Failed to verify provided license key');
            }
            licenseInfo.active = true;
            licenseInfo.details = license;
            licenseInfo.type = 'EmailEngine License';
            if (!config.licensePath) {
                logger.info({ msg: 'Loaded license', license, source: 'db' });
            }
        } catch (err) {
            logger.fatal({ msg: 'Failed to verify stored license key', content: licenseFile, err });
        }
    }

    if (!licenseInfo.active) {
        logger.fatal({ msg: 'No active license key provided. Running in limited mode.' });
    }

    if (preparedSettings) {
        // set up configuration
        logger.debug({ msg: 'Updating application settings', settings: preparedSettings });

        for (let key of Object.keys(preparedSettings)) {
            await settings.set(key, preparedSettings[key]);
        }
    }

    // prepare some required configuration values
    let existingSmtpEnabled = await settings.get('smtpServerEnabled');
    if (existingSmtpEnabled === null) {
        await settings.set('smtpServerEnabled', !!SMTP_ENABLED);
    }

    let existingSecret = await settings.get('smtpServerPassword');
    if (existingSecret === null) {
        await settings.set('smtpServerPassword', SMTP_SECRET || crypto.randomBytes(16).toString('hex'));
    }

    let existingSmtpAuthEnabled = await settings.get('smtpServerAuthEnabled');
    if (existingSmtpAuthEnabled === null && (existingSecret || existingSecret === null)) {
        await settings.set('smtpServerAuthEnabled', true);
    }

    let existingSmtpPort = await settings.get('smtpServerPort');
    if (existingSmtpPort === null) {
        await settings.set('smtpServerPort', SMTP_PORT);
    }

    let existingSmtpHost = await settings.get('smtpServerHost');
    if (existingSmtpHost === null) {
        await settings.set('smtpServerHost', SMTP_HOST);
    }

    let existingSmtpProxy = await settings.get('smtpServerProxy');
    if (existingSmtpProxy === null) {
        await settings.set('smtpServerProxy', SMTP_PROXY);
    }

    let existinServiceSecret = await settings.get('serviceSecret');
    if (existinServiceSecret === null) {
        await settings.set('serviceSecret', crypto.randomBytes(16).toString('hex'));
    }

    let existingQueueKeep = await settings.get('queueKeep');
    if (existingQueueKeep === null) {
        let QUEUE_KEEP = Math.max((process.env.EENGINE_QUEUE_REMOVE_AFTER && Number(process.env.EENGINE_QUEUE_REMOVE_AFTER)) || 0, 0);
        await settings.set('queueKeep', QUEUE_KEEP);
    }

    if (preparedToken) {
        try {
            let imported = await tokens.setRawData(preparedToken);
            if (imported) {
                logger.debug({ msg: 'Imported prepared token', token: preparedToken.id });
            } else {
                logger.debug({ msg: 'Skipped prepared token', token: preparedToken.id });
            }
        } catch (err) {
            logger.error({ msg: 'Failed to import token', token: preparedToken.id });
        }
    }

    // renew encryiption secret, if needed
    await getSecret();

    // ensure password for cookie based auth
    let cookiePassword = await settings.get('cookiePassword');
    if (!cookiePassword) {
        cookiePassword = crypto.randomBytes(32).toString('base64');
        await settings.set('cookiePassword', cookiePassword);
    }

    // multiple IMAP connection handlers
    for (let i = 0; i < config.workers.imap; i++) {
        await spawnWorker('imap');
    }

    for (let i = 0; i < config.workers.webhooks; i++) {
        await spawnWorker('webhooks');
    }

    for (let i = 0; i < config.workers.submit; i++) {
        await spawnWorker('submit');
    }

    if (await settings.get('smtpServerEnabled')) {
        // single SMTP interface worker
        await spawnWorker('smtp');
    }

    // single worker for HTTP
    await spawnWorker('api');
};

startApplication()
    .then(() => {
        // start collecting metrics
        setInterval(() => {
            collectMetrics().catch(err => logger.error({ msg: 'Failed to collect metrics', err }));
        }, 1000).unref();

        licenseCheckTimer = setTimeout(checkActiveLicense, LICENSE_CHECK_TIMEOUT);
        licenseCheckTimer.unref();
    })
    .catch(err => {
        logger.error({ msg: 'Failed to start application', err });
        process.exit(1);
    });
