/**
 * lei-crawler
 *
 * @author Zongmin Lei <leizongmin@gmail.com>
 */

var request = require('request');
var cheerio = require('cheerio');
var utils = require('./utils');
var debug = utils.debug('request');


module.exports = exports = function (options) {
  var req = new SimpleRequest(options);
  return function () {
    req.request.apply(req, arguments);
  };
};

// 默认超时时间，ms
exports.DEFAULT_TIMEOUT = 10000;
// 默认两次请求之间的间隔，ms
exports.DEFAULT_DELAY = 2000;
// 默认请求头信息
exports.DEFAULT_HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.8,en;q=0.6,fr;q=0.4,sk;q=0.2,zh-TW;q=0.2,ja;q=0.2',
  'Cache-Control': 'max-age=0',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_10_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/45.0.2454.101 Safari/537.36'
};
// 默认重定向的次数
exports.DEFAULT_MAX_REDIRECT = 5;
// 默认页面结果缓存时间，当设置了store参数时才有效
exports.DEFAULT_CACHE_TTL = 3600 * 24 * 7;
// 默认缓存的页面Content-Type类型列表
exports.DEFAULT_CACHE_CONTENT_TYPE = ['text/html'];


function loadURL (options, reqOptions, callback, i) {
  if (isNaN(i)) i = 0;
  debug('loadURL(i=%s) request: %s', i, reqOptions.url);
  var t = Date.now();

  request(reqOptions, function (err, res, body) {
    if (err) return callback(err);
    if (res.headers.location) {
     debug('loadURL(i=%s) redirect: %s => %s', i, reqOptions.url, res.headers.location);
      if (i > options.maxRedirect) {
        return callback(new Error('max redirect'));
      }
      return loadURL(options, reqOptions, callback, i++);
    }
    if (res.statusCode !== 200) {
      debug('loadURL(spent=%s): statusCode=%s', res.statusCode);
      return callback(new Error('invalid status code #' + res.statusCode));
    }

    debug('loadURL(spent=%s) callback: %s', Date.now() - t, reqOptions.url);
    callback(null, res.headers, body);
  });
}

/**
 * SimpleRequest
 *
 * @param {Object} options
 *   - {Object} headers
 *   - {Number} timeout
 *   - {Number} delay
 *   - {Number} maxRedirect
 *   - {Object} store
 *   - {Number} cacheTTL
 *   - {Array} cacheContentType
 */
function SimpleRequest (options) {
  options = utils.merge({
    timeout: exports.DEFAULT_TIMEOUT,
    delay: exports.DEFAULT_DELAY,
    maxRedirect: exports.DEFAULT_MAX_REDIRECT,
    cacheTTL: exports.DEFAULT_CACHE_TTL,
    cacheContentType: exports.DEFAULT_CACHE_CONTENT_TYPE
  }, options || {});
  options.headers = utils.merge(exports.DEFAULT_HEADERS, options.headers || {});
  options.cacheContentType = options.cacheContentType.map(function (t) {
    return t.toLowerCase();
  });
  this._options = options;

  this._tasks = [];
  this._lastRequestTimestamp = 0;
  this._taskCounter = 0;
}

SimpleRequest.prototype._wrapCallback = function (callback, options, contentType, body) {
  body = body.toString();
  if (options.cheerio) {
    try {
      var $ = cheerio.load(body);
    } catch (err) {
      return callback(err, body);
    }
    callback(null, contentType, body, $);
  } else {
    callback(null, contentType, body, null);
  }
};

SimpleRequest.prototype._getCacheKey = function (url) {
  return 'cache:html:' + utils.md5(url);
};

SimpleRequest.prototype._getCache = function (url, callback) {
  var self = this;
  if (!self._options.store) return callback(null, null);

  var key = self._getCacheKey(url);
  self._options.store.get(key, function (err, data) {
    if (err) return callback(err);
    if (!data) return callback(null, null, null);

    var i = data.indexOf('\n');
    if (i === -1) return callback(null, null, null);

    callback(null, data.slice(0, i), data.slice(i + 1));
  });
};

SimpleRequest.prototype._setCache = function (url, contentType, body, callback) {
  var self = this;
  if (!self._options.store) return callback(null);

  var key = self._getCacheKey(url);
  var data = contentType + '\n' + body;
  self._options.store.setCache(key, data, self._options.cacheTTL, callback);
};

SimpleRequest.prototype._isCacheContentType = function (type) {
  for (var i = 0; i < this._options.cacheContentType.length; i++) {
    if (type.indexOf(this._options.cacheContentType[i]) !== -1) {
      return true;
    }
  }
  return false;
};

/**
 * request
 *
 * @param {Object} options
 *   - {String} url
 *   - {Object} headers
 *   - {Object} cheerio
 */
SimpleRequest.prototype.request = function (options, callback) {
  var self = this;
  options = options || {};
  options.headers = utils.merge(self._options.headers, options.headers);
  options.cheerio = !!options.cheerio;
  if (!options.url) return callback(new TypeError('missing parameter `url`'));

  debug('request[timeout=%s, delay=%s]: url=%s, headers=%j, cheerio=%s',
         self._options.timeout, self._options.delay, options.url, options.headers, options.cheerio);

  // 先检查是否有缓存，如果有则直接返回结果，没有则添加到任务列表中
  self._getCache(options.url, function (err, contentType, body) {
    if (err) return callback(err);

    if (contentType) {
      debug('get from cache: [contentType=%s, length=%s] %s', contentType, body.length, options.url);
      self._wrapCallback(callback, options, contentType, body);
    } else {
      debug('add to task list: %s', options.url);
      self._tasks.push({options: options, callback: callback});
      self._process();
    }
  });
};

SimpleRequest.prototype._process = function () {
  var self = this;
  var t = Date.now();
  var v = t - self._lastRequestTimestamp;
  if (v < self._options.delay) {
    setTimeout(function () {
      self._process();
    }, v);
  } else {
    var info = self._tasks.shift();
    var i = self._taskCounter++;
    var t = Date.now();
    debug('process request[#%s]: %s', i, info.options.url);
    self._lastRequestTimestamp = t;
    var options = utils.merge(self._options, {cheerio: info.options.cheerio});
    var reqOptions = {
      url: info.options.url,
      headers: info.options.headers,
      timeout: options.timeout
    };
    loadURL(options, reqOptions, function (err, headers, body) {
      debug('request callback[#%s]: spent=%sms', i, Date.now() - t);
      if (err) return info.callback(err);

      var contentType = headers['content-type'];
      if (self._isCacheContentType(contentType)) {
        debug('save cache: [contentType=%s, length=%s] %s', contentType, body.length, reqOptions.url);
        self._setCache(reqOptions.url, contentType, body, function (err) {
          if (err) return info.callback(err);
          self._wrapCallback(info.callback, options, contentType, body);
        });
      } else {
        self._wrapCallback(info.callback, options, contentType, body);
      }
    });
  }
};
