/**
 * Since we make rendr files AMD friendly on app setup stage
 * we need to pretend that this code is pure commonjs
 * means no AMD-style require calls
 */
var requireAMD = require;

var _ = require('underscore'),
    Parse = require('parse').Parse,
    async = require('async'),
    isServer = (typeof window === 'undefined'),
    BaseView,
    $;

if (!isServer) {
  Parse.$ = window.$ || require('jquery');
  $ = Parse.$;
}

function noop() {}

module.exports = BaseView = Parse.View.extend({
  constructor: function(options) {
    var obj;

    this.options = _.extend( this.options || {}, options || {} );

    this.parseOptions(options);

    this.name = this.name || this.app.modelUtils.underscorize(this.constructor.id || this.constructor.name);

    // parseOptions deals w/ models and collections, but the BaseView will override those changes
    Parse.View.call(this, _.omit(options, ['model', 'collection']));

    if (this.postInitialize) {
      console.warn('`postInitialize` is deprecated, please use `initialize`');
      this.postInitialize();
    }

    if ((obj = this.options.model || this.options.collection) && this.renderOnRefresh) {
      obj.on('refresh', this.render, this);
    }

    this.render = this.render.bind(this);
  },

  /**
   * Whether or not to re-render this view when the model or collection
   * emits a 'refresh' event. Used with 'model|collection.checkFresh()'.
   */
  renderOnRefresh: false,

  parseOptions: function(options) {
    /**
     * Populate `this.options` and alias as `options`.
     */
    options = _.extend(this.options, options || {});

    if (options.app != null) {
      this.app = this.options.app;
    } else {
      throw new Error("options.app expected when initializing a new view")
    }

    if (options.parentView != null) {
      this.parentView = options.parentView;
    }

    options = BaseView.parseModelAndCollection(this.app.modelUtils, options);
    this.model = options.model;
    this.collection = options.collection;
  },

  /**
   * Key for the template
   */
  name: null,

  /**
   * Parent of the current view.
   * We make sure to stick this on the prototype as a runtime optimization
   * for V8. It's best not to add properties to the instance after initialization.
   */
  parentView: null,

  /**
   * Children of the current view.
   */
  childViews: null,

  /**
   * Flag whether or not the view is currently being viewed
   */
  viewing: false,

  /**
   * Gets array of child views by their name
   * Empty array is returned when no match is found
   */
  getChildViewsByName: function(name) {
    return _.where(this.childViews, {name: name});
  },

  /**
   * Get data for template.  This also acts as a view-model.
   * Try to return proper data if model or collection is available.
   */
  getTemplateData: function() {
    if (this.model) {
      return this.model.toJSON();
    } else if (this.collection) {
      return {
        models: this.collection.toJSON(),
        meta: this.collection.meta,
        params: this.collection.params
      };
    } else {
      return _.clone(this.options);
    }
  },

  /**
   * Add special properties `_app` and `_model` or `_collection` to pass to
   * the templates.
   */
  decorateTemplateData: function(data) {
    if (this.app) {
      data._app = this.app;
    }
    if (this.model) {
      data._model = this.model;
    }
    if (this.collection) {
      data._collection = this.collection;
    }
    data._view = this;
    return data;
  },

  getTemplateName: function() {
    return this.options.template_name || this.name;
  },

  /**
   * Get template function
   */
  getTemplate: function() {
    return this.app.templateAdapter.getTemplate(this.getTemplateName());
  },

  /**
   * Any options not to create data-attributes for.
   */
  nonAttributeOptions: ['id', 'className', 'tagName'],

  /**
   * Get HTML attributes to add to el.
   */
  getAttributes: function() {
    var attributes = {},
        fetchSummary = {},
        modelUtils = this.app.modelUtils,
        nonAttributeOptions = this.nonAttributeOptions;

    if (this.attributes) {
      _.extend(attributes, _.result(this, 'attributes'));
    }
    if (this.id) {
      attributes.id = _.result(this, "id");
    }
    if (this.className) {
      attributes['class'] = _.result(this, "className");
    }

    // Add `data-view` attribute with view key.
    // For now, view key is same as template.
    attributes['data-view'] = this.name;

    // Add model & collection meta data from options,
    // as well as any non-object option values.
    _.each(this.options, function(value, key) {

        if (!_.isObject(value) && !_.include(nonAttributeOptions, key)) {
          attributes["data-" + key] = value;
        }
    });
    fetchSummary = BaseView.extractFetchSummary(modelUtils, this.options);

    if (!_.isEmpty(fetchSummary)) {
      attributes['data-fetch_summary'] = JSON.stringify(fetchSummary);
    }
    return attributes;
  },

  /**
   * Turn template into HTML, minus the wrapper element.
   */
  getInnerHtml: function() {
    var template = this.getTemplate(),
        data;

    this._preRender();
    data = this.getTemplateData();
    data = this.decorateTemplateData(data);
    if (template == null) {
      throw new Error(this.name + ": template \"" + this.getTemplateName() + "\" not found.");
    }
    return template(data);
  },

  /**
   * Get the HTML for the view, including the wrapper element.
   */
  getHtml: function() {
    var html = this.getInnerHtml(),
        attributes = this.getAttributes(),
        tagName = _.result(this, "tagName"),
        attrString;

    attrString = _.inject(attributes, function(memo, value, key) {
      return memo += " " + key + "=\"" + _.escape(value) + "\"";
    }, '');

    return "<" + tagName + attrString + ">" + html + "</" + tagName + ">";
  },

  render: function() {
    var html = this.getInnerHtml();
    this.$el.html(html);

    // Because we only set the attributes of the outer element
    // when calling getHtml() (server), let's make sure it also
    // happens during render() (client).

    this.$el.attr(this.getAttributes());
    this._postRender();
    return this;
  },

  /**
   * If rendered on the client missing its data,
   * fetch it based on the parameters passed in.
   */
  fetchLazy: function() {
    var params = {},
        fetchSpec;

    if (this.options.fetch_params) {
      if (!_.isObject(this.options.fetch_params)) {
        throw new Error('fetch_params must be an object for lazy loaded views')
      }

      params = this.options.fetch_params;
    } else if (this.options.param_name) {
      params[this.options.param_name] = this.options.param_value;
    }

    if (this.options.model_id != null) {
      params.id = this.options.model_id;
    }

    if (this.options.model_name != null) {
      fetchSpec = {
        model: {
          model: this.options.model_name,
          params: params
        }
      };
    } else if (this.options.collection_name != null) {
      fetchSpec = {
        collection: {
          collection: this.options.collection_name,
          params: params
        }
      };
    }

    this.setLoading(true);

    this._preRender();
    this.app.fetch(fetchSpec, this._fetchLazyCallback.bind(this));
  },

  _fetchLazyCallback: function(err, results) {
    this.setLoading(false);
    if (err) {
      console.log("FETCH ERR: " + err);
    } else if (this.viewing) {
      // It's possible that by the time the XHR returns, the user has navigated
      // away to a new page, check for whether we are viewing first
      this.parseOptions(results);
      this.render();
    }
  },

  /**
   * Anything to do before rendering on the client or server.
   * This is useful for i.e. accessing @model in the client after
   * @hydrate() is called, but before @getTemplateData() is called.
   */
  _preRender: function() {
    this.preRender();
    this.trigger('preRender');
  },

  /**
   * Anything to do after rendering on the client, such initializing jQuery
   * plugins like sliders, slideshows, etc.
   */
  _postRender: function() {
    this.attachChildViews();
    this.postRender();
    this.trigger('postRender');
  },

  /**
   * To be overridden by subclasses.
   */
  preRender: noop,

  /**
   * To be overridden by subclasses.
   */
  postRender: noop,

  setLoading: function(loading) {
    this.$el.toggleClass('loading', loading);
    this.trigger('loading', loading);
  },

  attachOrRender: function(element, parentView) {
    var $el = $(element);

    this.parentView = parentView;
    this.viewing = true;

    if (this.options.lazy === true && this.options.collection == null && this.options.model == null) {
      $el.attr('data-view-attached', true);
      this.setElement($el);

      return this.fetchLazy();
    }

    if ($el.data('render')) {
      $el.replaceWith(this.$el);
      this.render();
    } else {
      $el.attr('data-view-attached', true);
      this.setElement($el);
      this.attach();
    }
  },

  /**
   * When HTML is already present (rendered by server),
   * this is what gets called to bind to the element.
   */
  attach: function() {
    /**
     * Call preRender() so we can access things setup by @hydrate()
     * (like @model) in i.e. @getTemplateData().
     */
    this._preRender();

    /**
     * We have to call postRender() so client-only things happen,
     * i.e. initialize slideshows, etc.
     */
    this._postRender();

    this.trigger('attach');
  },

  /**
   * Happens client-side.
   * Find all of sub view DOM elements
   * Get the view key
   * Call this.getView()
   * Attach childView
   */
  attachChildViews: function() {
    var _baseView = this;

    // Remove all child views in case we are re-rendering through
    // manual .render() or 'refresh' being triggered on the view.
    this.removeChildViews();
    BaseView.attach(this.app, this, function(views) {
      _baseView.childViews = views;
    });
  },

  removeChildViews: function() {
    (this.childViews || []).forEach(function(view) {
      view.remove();
    });
  },

  remove: function() {
    this.removeChildViews();
    this.childViews = null;
    this.parentView = null;
    this.viewing = false;

    var obj = this.model || this.collection;

    if (obj) {
      obj.off(null, null, this);
    }
    BaseView.__super__.remove.apply(this, arguments);
    this.trigger('remove');
  }
});

/**
 * Class methods
 * -------------
 */

BaseView.getView = function(viewName, entryPath, callback) {
  var viewPath;

  if (!entryPath) entryPath = '';

  viewPath = entryPath + "app/views/" + viewName;
  // check for AMD environment
  if (typeof callback == 'function') {
    // Only used in AMD environment
    if (typeof define != 'undefined') {
      requireAMD([viewPath], callback);
    } else {
      callback(require(viewPath));
    }
  } else {
    return require(viewPath);
  }
};

BaseView.getViewOptions = function ($el) {
  var parsed,
    options = $el.data();

  _.each(options, function(value, key) {
    if (_.isString(value)) {
      parsed = _.unescape(value);
      try {
        parsed = JSON.parse(parsed);
      } catch (err) {}
      options[key] = parsed;
    }
  });

  return options;
};

BaseView.attach = function(app, parentView, callback) {
  var scope = parentView ? parentView.$el : null,
      list = $('[data-view]', scope).toArray();

  async.map(list, function(el, cb) {
    var $el, options, viewName, fetchSummary;
    $el = $(el);
    if (!$el.data('view-attached')) {
      options = BaseView.getViewOptions($el);
      options.app = app;

      viewName = options.view;

      fetchSummary = options.fetch_summary || {};
      app.fetcher.hydrate(fetchSummary, { app: app }, function (err, results) {
        options = _.extend(options, results);
        BaseView.getView(viewName, app.options.entryPath, function(ViewClass) {
          var view = new ViewClass(options);
          view.attachOrRender($el, parentView);
          cb(null, view);
        });
      });
    } else {
      cb(null, null);
    }
  }, function(err, views) {
    // no error handling originally
    callback(_.compact(views));
  });
};

BaseView.parseModelAndCollection = function(modelUtils, options) {
  if (options.model != null) {
    if (!(options.model instanceof Parse.Object) && options.model_name) {
      options.model = modelUtils.getModel(options.model_name, options.model, {
        parse: true
      });
    }
    options.model_name = options.model_name || modelUtils.modelName(options.model.constructor);
    options.model_id = options.model.id;
  }

  if (options.collection != null) {
    options.collection_name = options.collection_name || modelUtils.modelName(options.collection.constructor);
    options.collection_params = options.collection.params;
  }

  return options;
};

BaseView.extractFetchSummary = function (modelUtils, options) {
    var fetchSummary = {};

    _.each(options, function(value, key) {
        var id, modelOrCollectionId;

        if (value != null) {
            if (_.isFunction(value.constructor) && value.constructor.id != null) {
                modelOrCollectionId = value.constructor.id;
                if (modelUtils.isModel(value)) {
                    value = value.id;
                    fetchSummary[key] = {model: modelOrCollectionId, id: value};
                    return;
                }
                if (modelUtils.isCollection(value) && value.params != null) {
                    fetchSummary[key] = {collection: modelOrCollectionId, params: value.params};
                    return;
                }
            }
        }
    });

    return fetchSummary;
}

/**
 * Noops on the server, because they do DOM stuff.
 */
if (typeof window === 'undefined') {
  BaseView.prototype._ensureElement = noop;
  BaseView.prototype.delegateEvents = noop;
}
