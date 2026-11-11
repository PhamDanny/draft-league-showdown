'use strict';
// Draft League server config. Copied over upstream by scripts/setup.mjs.
// The league site (app/) starts this server and passes LEAGUE_DATA_DIR and LEAGUE_API.
const fs = require('fs');
const path = require('path');

const dataDir = process.env.LEAGUE_DATA_DIR || path.resolve(__dirname, '../../../data');

exports.port = Number(process.env.SHOWDOWN_PORT || 8001);
// Only the league site talks to this port; it proxies players' websockets after checking sign-in.
exports.bindaddress = '127.0.0.1';
exports.wsdeflate = null;
exports.ssl = null;
exports.proxyip = ['127.0.0.1/32', '::1/128'];

// Players sign in through the league site, which signs Showdown assertions with this key.
exports.loginserver = process.env.LEAGUE_API || 'http://127.0.0.1:8000/';
exports.loginserverkeyalgo = 'RSA-SHA1';
exports.loginserverpublickeyid = 1;
exports.loginserverpublickey = fs.readFileSync(path.join(dataDir, 'keys', 'login-public.pem'), 'utf8');
exports.tokenexpiry = 25 * 60 * 60;

exports.routes = {
	root: 'localhost',
	client: 'localhost',
	dex: 'dex.pokemonshowdown.com',
	replays: 'localhost',
};

// Team privacy: never write battle input logs (which hold exact sets) to disk.
exports.logchallenges = false;
exports.logchat = false;
exports.logladderip = false;
exports.autosavereplays = false;
exports.reportjoins = false;
exports.reportbattles = false;
exports.reportbattlejoins = false;

exports.subprocesses = {
	network: 0,
	simulator: 1,
	validator: 1,
	verifier: 1,
	chatdb: 0,
	pm: 0,
	modlog: 0,
};

exports.crashguard = true;
exports.crashguardemail = null;
exports.disablebasicnamefilter = true;
exports.nothrottle = true;
exports.noipchecks = true;
exports.backdoor = false;
exports.consoleips = [];
exports.repl = false;
exports.autolockdown = false;
exports.noguestsecurity = false;
exports.disablehotpatchall = true;
exports.chatlogreader = 'fs';
exports.usesqlite = false;
exports.usepostgres = false;
exports.restrictLinks = false;
exports.forcetimer = false;
exports.ofemain = false;
exports.watchconfig = false;
