/**
 * Copyright 2013 the PM2 project authors. All rights reserved.
 * Use of this source code is governed by a license that
 * can be found in the LICENSE file.
 */

/**
 * Dependencies
 */
var cst = require('../../constants.js');
var log = require('debug')('pm2:aggregator');
var async = require('async');

var LABELS = {
  "HTTP_RESPONSE_CODE_LABEL_KEY": 'http/status_code',
  "HTTP_URL_LABEL_KEY": 'http/url',
  "HTTP_METHOD_LABEL_KEY": 'http/method',
  "HTTP_RESPONSE_SIZE_LABEL_KEY": 'http/response/size',
  "STACK_TRACE_DETAILS_KEY": 'stacktrace',
  "ERROR_DETAILS_NAME": 'error/name',
  "ERROR_DETAILS_MESSAGE": 'error/message',
  "HTTP_SOURCE_IP": 'http/source/ip',
  "HTTP_PATH_LABEL_KEY": "http/path"
}

var TransactionAggregator = module.exports = function (pushInteractor) {
  var self = this;
  if (!(this instanceof TransactionAggregator))
    return new TransactionAggregator(pushInteractor);

  /**
   * {
   *  'process_name': {
   *    '/' : [         // route
   *      {             // deviance
   *        spans : [
   *          ...       // all the spans
   *        ],
   *        count: 50,  // count of this deviance
   *        max: 300,   // max latency of this deviance
   *        min: 50,    // min latency of this deviance
   *        mean: 120   // mean latency of this deviance
   *      }
   *    ]
   *  }
   * }
   */
  this.processes = {};

  this.aggregate = function (event, packet) {
    if (!packet.data) return ;
    packet.data = JSON.parse(packet.data);

    if (!self.processes[packet.process.name])
      self.processes[packet.process.name] = {};
    var routes = self.processes[packet.process.name];

    log('Aggregating %s new traces', packet.data.traces.length)
    async.eachLimit(packet.data.traces, 1, function (trace, next) {
      // convert spans list to trees
      self.convertSpanListToTree(trace, function (tree) {
        trace.spans = tree;
        delete tree.labels.stackrace

        // get the path from first span
        var path = trace.spans.labels[LABELS.HTTP_PATH_LABEL_KEY];

        self.matchPath(path, routes, function (matched) {
          if (!matched) {
            routes[path] = [];
            log('Path %s isnt aggregated yet, creating new entry', path)
            self.mergeTrace(routes[path], trace, next);
          }
          else {
            log('Path %s already aggregated under %s, merging', path, matched)
            self.mergeTrace(routes['/' + matched], trace, next);
          }
          
        })
      })
    }, function(error) {
      if (error)
        console.error(error);
    });
  }

  this.mergeTrace = function (aggregated, trace, cb) {
    self.computeSpanDuration(trace.spans)

    var merge = function (variance) {
      // no variance found so its a new one
      if (!variance) {
        delete trace.projectId;
        delete trace.traceId;
        trace.count = 1;
        trace.mean = trace.min = trace.max = trace.spans.mean;
        aggregated.push(trace);
      }
      // variance found, merge spans
      else {
        variance.min = variance.min > trace.spans.mean ? trace.spans.mean : variance.min;
        variance.max = variance.max < trace.spans.mean ? trace.spans.mean : variance.max;
        variance.mean = (trace.spans.mean + (variance.mean * variance.count)) / (variance.count + 1);
        
        // update duration of spans to be mean
        self.updateSpanDuration(variance.spans, trace.spans, variance.count, true);
        variance.count++;
      }
      return cb();
    }
    // for every variance, check spans same variance
    for (var i = 0; i < aggregated.length; i++) {
      if (self.compareTree(aggregated[i].spans, trace.spans))
        return merge(aggregated[i])
    }
    // else its a new variance
    return merge(null);
  }

  this.convertSpanListToTree = function (trace, cb) {
    var head, spans = trace.spans;
    async.each(spans, function (current, next) {
      if (current.parentSpanId == 0) {
        head = current;
        return next();
      }

      for (var i = 0, len = spans.length; i < len; i++) {
        if (current.parentSpanId !== spans[i].spanId) continue ;

        if (!spans[i].child) spans[i].child = [];
        spans[i].child.push(current);
        return next();
      }

      return next();
    }, function () {
      return cb(head);
    });
  }

  /**
   * Apply a function on all element of a tree
   */
  this.applyOnTree = function(head, fn) {
    fn(head);
    if (head.child instanceof Array)
      return head.child.forEach(fn);
  }

  this.computeSpanDuration = function (head) {
    self.applyOnTree(head, function (span) {
      if (span.endTime && span.startTime)
        span.min = span.max = span.mean = new Date(span.endTime) - new Date(span.startTime);
      delete span.endTime;
      delete span.startTime;
    })
  }

  this.updateSpanDuration = function (ref_spans, spans, count) {
    // head
    if (ref_spans.parentSpanId === 0 || ref_spans.parentSpanId === "0") {
      ref_spans.mean = (spans.mean + (ref_spans.mean * count)) / (count + 1);
      ref_spans.min = ref_spans.min > spans.mean ? spans.mean : ref_spans.min;
      ref_spans.max = ref_spans.max < spans.mean ? spans.mean : ref_spans.max;
    }
    // childs
    if (!(ref_spans.child instanceof Array)) return ;
    for (var i = 0, len = ref_spans.child.length; i < len; i++) {
      var childspan = ref_spans.child[0];
      childspan.mean = (spans.child[i].mean + (childspan.mean * count)) / (count + 1);
      childspan.min = childspan.min > spans.child[i].mean ? spans.child[i].mean : childspan.min;
      childspan.max = childspan.max < spans.child[i].mean ? spans.child[i].mean : childspan.max;

      if (childspan.child instanceof Array)
        self.updateSpanDuration(childspan, spans.child[i], count);
    }
  }

  /**
   * Compare a spans tree by going down each span and comparing child and attribute
   */
  this.compareTree = function (one, two) {
    if (!one.child && !two.child) return true;
    if (!one.child && two.child) return false;
    if (one.child && !two.child) return false;
    if (one.child.length !== two.child.length) return false;

    for(var i = 0, len = one.child.length; i < len; i++) {
      if (one.child[i].name !== two.child[i].name) return false;
      if (one.child[i].kind !== two.child[i].kind) return false;

      if (one.child[i].child)
        return self.compareTree(one.child[i], two.child[i]);
    }
    return true;
  }

  /**
   * Will return the route if we found an already matched route
   */
  this.matchPath = function (path, routes, cb) {
    var self = this;
    // remove the last slash if exist
    if (path[path.length - 1] === '/')
      path = path.substr(0, path.length - 1)

    // split to get array of segment
    path = path.split('/').filter(function (item) {
      return !item ? null : item;
    });
    // if the path has only one segment, we just need to compare the key
    if (path.length === 1) 
      return routes[path[0]] ? cb(routes[path[0]]) : cb(null);
    
    // check in routes already stored for match
    async.forEachOfLimit(routes, 10, function (data, route, next) {
      var segments = route.split('/').filter(function (item) {
        return !item ? null : item;
      });
      if (segments.length !== path.length) return next(null);

      for (var i = path.length - 1; i >= 0; i--) {
        // different segment, try to find if new route or not
        if (path[i] !== segments[i]) {
          // case if the aggregator already have matched that path into a route and we got an identifier
          if (self.isIdentifier(path[i]) && segments[i] === '*' && path[i - 1] === segments[i - 1])
            return next(segments.join('/'));
          // case a var in url match, so we continue because they must be other var in url
          else if (path[i - 1] !== undefined && path[i - 1] === segments[i - 1] && self.isIdentifier(path[i]) && self.isIdentifier(segments[i])){
            segments[i] = '*';
            // update routes in cache
            routes[segments.join('/')] = routes[route];
            delete routes[route];
            route = segments.join('/');
          }
          else
            return next();
        }
      }
      // if finish to iterate over segment of path, we must be on the same route
      return next(segments.join('/'))
    }, cb)
  }

  /**
   * Check if the string can be a id of some sort
   */
  this.isIdentifier = function (id) {
    id = typeof(id) !== 'string' ? id + '' : id;

    // uuid v1/v4 with/without dash
    if (id.match(/[0-9a-f]{8}-[0-9a-f]{4}-[14][0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12}[14][0-9a-f]{19}/i))
      return true;
    // if number
    else if (id.match(/\d+/))
      return true;
    // if suit of nbr/letters
    else if (id.match(/[0-9]+[a-z]+|[a-z]+[0-9]+/))
      return true;
    else
      return false;
  }

  setInterval(function () {
    var normalized = {};
    // for every process
    async.forEachOf(self.processes, function (routes, name, next) {
      normalized[name] = {};
      // for every route
      async.forEachOf(routes, function (variances, route, next2) {
        // get top 5 variances of the same route
        var variances = variances.sort(function (a, b) {
          return a.count - b.count;
        }).slice(0, 5);

        normalized[name][route] = variances;

        variances.forEach(function (variance) {
          self.applyOnTree(variance.spans, function (span) {
            delete span.labels.stacktrace;
          })
        })
        return next2();
      }, next);
    }, function () {
      console.log(JSON.stringify(normalized))
      if (process.env.NODE_ENV === 'test') return ;
      if (process.env.PM2_DEBUG) console.log(JSON.stringify(normalized));

      pushInteractor.bufferData('axm:transaction', normalized);
    })
  }, 5000);
};