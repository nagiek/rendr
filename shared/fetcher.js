var _ = require('underscore'),
    Parse = require('parse').Parse,
    async = require('async'),
    ModelStore = require('./store/model_store'),
    CollectionStore = require('./store/collection_store'),
    isServer = (typeof window === 'undefined');

if (!isServer) {
  Parse.$ = window.$ || require('jquery');
}

module.exports = Fetcher;

function Fetcher(options) {
  this.options = options;
  this.app = this.options.app;
  this.modelUtils = this.app.modelUtils;
  this.modelStore = new ModelStore({
    app: this.app,
    modelUtils: this.modelUtils
  });
  this.collectionStore = new CollectionStore({
    app: this.app,
    modelUtils: this.modelUtils
  });
}

Fetcher.prototype.buildOptions = function(additionalOptions, params) {
  var options = {app: this.app, parse: true};
  _.defaults(options, additionalOptions);
  _.defaults(options, params);
  return options;
};

/**
 * Returns an instance of Model or Collection.
 */
Fetcher.prototype.getModelOrCollectionForSpec = function(spec, attrsOrModels, options, callback) {
  if (spec.model) {
    return this.getModelForSpec(spec, attrsOrModels, options, callback);
  } else {
    return this.getCollectionForSpec(spec, attrsOrModels, options, callback);
  }
};

/**
 * Returns an instance of Collection.
 */
Fetcher.prototype.getCollectionForSpec = function(spec, models, options, callback) {
  var collectionOptions = this.buildOptions(options, spec.params);
  models = models || [];
  return this.modelUtils.getCollection(spec.collection, models, collectionOptions, callback);
};

/**
 * Returns an instance of Model.
 */
Fetcher.prototype.getModelForSpec = function(spec, attributes, options, callback) {
  var modelOptions = this.buildOptions(options);

  attributes = attributes || {};
  _.defaults(attributes, spec.params);

  return this.modelUtils.getModel(spec.model, attributes, modelOptions, callback);
};

/**
 * Used to hold timestamps of when 'checkFresh()' was called on a model/collection.
 * We use this to throttle it in 'shouldCheckFresh()'.
 */
Fetcher.prototype.checkedFreshTimestamps = {};

/**
 * Only once every ten seconds. Smarter?
 */
Fetcher.prototype.checkedFreshRate = 10000;

Fetcher.prototype.shouldCheckFresh = function(spec) {
  var key = this.checkedFreshKey(spec),
      timestamp = this.checkedFreshTimestamps[key];
  if (!timestamp) {
    return true;
  }
  if (new Date().getTime() - timestamp > this.checkedFreshRate) {
    return true;
  }
  return false;
};

Fetcher.prototype.didCheckFresh = function(spec) {
  var key = this.checkedFreshKey(spec);
  this.checkedFreshTimestamps[key] = new Date().getTime();
};

Fetcher.prototype.checkedFreshKey = function(spec) {
  var meta;
  meta = {
    name: spec.model || spec.collection,
    params: spec.params
  };
  return JSON.stringify(meta);
};

/**
 * map fetchSpecs to models and fetch data in parallel
 */
Fetcher.prototype._retrieve = function(fetchSpecs, options, callback) {
  var batchedRequests = {};

  _.each(fetchSpecs, function(spec, name) {
    batchedRequests[name] = function(cb) {

      if (!options.readFromCache) {
        this.fetchFromApi(spec, options, cb);
      } else {

        // First, see if we have stored the model or collection.
        if (spec.model != null) {

          this._retrieveModel(spec, function(err, modelData) {
            this._testAndGetData(spec, modelData, cb);
          }.bind(this));

        } else if (spec.collection != null) {

          this.collectionStore.get(spec.collection, spec.params, function(collection) {
            this._testAndGetData(spec, collection, cb);
          }.bind(this));

        }

      }
    }.bind(this);
  }, this);
  async.parallel(batchedRequests, callback);
};

// Used to be _retrieveModelData
Fetcher.prototype._testAndGetData = function(spec, modelOrCollection, cb) {

  // If we found the model/collection in the store, then return that.
  if (!this.needsFetch(modelOrCollection, spec)) {

    /**
     * If 'checkFresh' is set (and we're in the client), then before we
     * return the cached object we fire off a fetch, compare the results,
     * and if the data is different, we trigger a 'refresh' event.
     */
    if (spec.checkFresh && !isServer && this.shouldCheckFresh(spec)) {
      modelOrCollection.checkFresh();
      this.didCheckFresh(spec);
    }
    cb(null, modelOrCollection);
  } else {
    /**
     * Else, fetch anew.
     */
    this.fetchFromApi(spec, {}, cb);
  }
}

Fetcher.prototype._retrieveModel = function(spec, callback) {
  var fetcher = this;

  // Attempt to fetch from the modelStore based on the idAttribute
  var modelData = fetcher.modelStore.get(spec.model, spec.id, true);
  if (modelData)
    return callback(null, modelData);

  this.modelUtils.modelIdAttribute(spec.model, function(idAttribute) {
    // if there are no other keys than the id in the params, return null;
    if (_.isEmpty(_.omit(spec.params, idAttribute)))
      return callback(null, null);

    // Attempt to fetch the model in the modelStore based on the other params
    return callback(null, fetcher.modelStore.find(spec.model, spec.params));
  });
};

Fetcher.prototype.needsFetch = function(modelOrCollection, spec) {
  if (modelOrCollection == null) return true;
  attrs = modelOrCollection.attributes ? modelOrCollection.attributes : modelOrCollection
  if (this.isMissingKeys(attrs, spec.ensureKeys)) return true;
  if (spec.needsFetch === true) return true;
  if (typeof spec.needsFetch === 'function' && spec.needsFetch(modelOrCollection)) return true;
  return false;
};

Fetcher.prototype.isMissingKeys = function(modelData, keys) {
  var key;

  if (keys == null) {
    return false;
  }
  if (!_.isArray(keys)) {
    keys = [keys];
  }
  for (var i = 0, len = keys.length; i < len; i++) {
    key = keys[i];
    if (modelData[key] == null) {
      return true;
    }
  }
  return false;
};

// Use Parse's API
// options is useless, but is legacy (was used for headers)
Fetcher.prototype.fetchFromApi = function(spec, options, callback) {
  var query, func, success, error, fetcher = this;

  success = function(model, body) {
    callback(null, model);
  };
  error = function(model, resp, options) {
    var body, respOutput, err;

    body = resp.body;
    resp.body = typeof body === 'string' ? body.slice(0, 150) : body;
    respOutput = JSON.stringify(resp);
    err = new Error("ERROR fetching model '" + fetcher.modelUtils.modelName(model.constructor) + "' with options '" + JSON.stringify(options) + "'. Response: " + respOutput);
    err.status = resp.status;
    err.body = body;
    callback(err);
  };

  if (spec.model) {
    query = new Parse.Query(spec.model, this.buildOptions(null, spec.params))
    if (spec.id) {
      query.get(spec.id, {success: success, error: error});
    } else {
      _.each(spec.params, function(key, value) {
        func = _.isArray(value) ? "containedIn" : "equalTo"
        query[func](key, value);
      });
      query.find().then(success, error);
    }

  } else {

    // Build the collection and the base query.
    collection = this.getCollectionForSpec(spec);
    collection.query = new Parse.Query(collection.model, this.buildOptions({collection: collection}, spec.params));

    if (spec.relation) {
      // Mimic Parse.Relation::query()
      var pointer = { __type: "Pointer",
               className: spec.relation.parent.className,
               objectId: spec.relation.parent.id };
        
      collection.query._addCondition("$relatedTo", "object", pointer);
      collection.query._addCondition("$relatedTo", "key", spec.relation.key);
      collection.query._extraOptions.redirectClassNameForKey = spec.relation.key;
    } else {
      _.each(spec.params, function(key, value) {
        func = _.isArray(value) ? "containedIn" : "equalTo"
        collection.query[func](key, value);
      });
    }
    collection.fetch({success: success, error: error})
  }
};

Fetcher.prototype.retrieveModelsForCollectionName = function(collectionName, modelIds) {
  var modelName = this.modelUtils.getModelNameForCollectionName(collectionName);
  return this.retrieveModels(modelName, modelIds);
};

Fetcher.prototype.retrieveModels = function(modelName, modelIds) {
  return modelIds.map(function(id) {
    return this.modelStore.get(modelName, id);
  }, this);
};

Fetcher.prototype.summarize = function(modelOrCollection) {
  var summary = {};

  if (this.modelUtils.isCollection(modelOrCollection)) {
    summary = {
      collection: this.modelUtils.modelName(modelOrCollection.constructor),
      ids: _.pluck(modelOrCollection.models, "id"),
      params: modelOrCollection.params,
      meta: modelOrCollection.meta
    };
  } else if (this.modelUtils.isModel(modelOrCollection)) {
    summary = {
      model: this.modelUtils.modelName(modelOrCollection.constructor),
      id: modelOrCollection.id
    };
  }
  return summary;
};

Fetcher.prototype.storeResults = function(results) {
  _.each(results, function(modelOrCollection) {
    modelOrCollection.store();
  });
};

Fetcher.prototype.bootstrapData = function(modelMap) {
  var results = {},
      fetcher = this;

  async.forEach(_.keys(modelMap), function(name, cb) {
    var map = modelMap[name];
    fetcher.getModelOrCollectionForSpec(map.summary, map.data, _.pick(map.summary, 'params', 'meta'), function(modelOrCollection) {
      results[name] = modelOrCollection;
      cb(null);
    });
  }, function(err) {
    fetcher.storeResults(results);
  });
};

Fetcher.prototype.hydrate = function(summaries, options, callback) {
  var results = {},
      fetcher = this;

  /**
   * Support both (summaries, options, callback)
   * and (summaries, callback).
   */
  if (arguments.length === 2) {
    callback = options;
    options = {};
  } else {
    options = options || {};
  }

  async.forEach(_.keys(summaries), function(name, cb) {
    var summary = summaries[name];
    if (summary.model != null) {
      results[name] = fetcher.modelStore.get(summary.model, summary.id, true);

      if ((results[name] != null) && (options.app != null)) {
        results[name].app = options.app;
      }

      cb(null);

    } else if (summary.collection != null) {
      // Also support getting all models for a collection.
      fetcher.collectionStore.get(summary.collection, summary.params, function(collection) {
        if (collection == null) {
          throw new Error("Collection of type \"" + summary.collection + "\" not found for params: " + JSON.stringify(summary.params));
        }

        results[name] = collection;

        cb(null);
      });
    }
  }, function(err) {
    callback(err, results);
  });
};

Fetcher.prototype.pendingFetches = 0;

Fetcher.prototype.fetch = function(fetchSpecs, options, callback) {
  var fetcher = this;

  /**
   * Support both (fetchSpecs, options, callback)
   * and (fetchSpecs, callback).
   */
  if (arguments.length === 2) {
    callback = options;
    options = {};
  } else {
    options = options || {};
  }

  // Different defaults for client v server.
  if (isServer) {
    if (options.readFromCache == null) {
      options.readFromCache = false;
    }
    if (options.writeToCache == null) {
      options.writeToCache = false;
    }
  } else {
    if (options.readFromCache == null) {
      options.readFromCache = true;
    }
    if (options.writeToCache == null) {
      options.writeToCache = true;
    }
  }

  this.pendingFetches++;
  this.trigger('fetch:start', fetchSpecs);
  this._retrieve(fetchSpecs, options, function(err, results) {
    fetcher.pendingFetches--;
    fetcher.trigger('fetch:end', fetchSpecs, err, results);
    if (err) return callback(err);
    if (options.writeToCache) {
      fetcher.storeResults(results);
    }
    callback(null, results);
  });
};

// Mixin Parse.Events for events that work in client & server.
_.extend(Fetcher.prototype, Parse.Events);
