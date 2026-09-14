// Secret APIs are host-side only; the iframe's filtered PluginAPI does not expose them.
(function () {
  var secretKey = 'gigachat-authorization-key';
  var bridge = {
    get: function () { return PluginAPI.getSecret(secretKey); },
    set: function (value) { return PluginAPI.setSecret(secretKey, value); }
  };
  window.__gigachatAssistantSecretBridge = bridge;

  var cleanup = function () {
      if (window.__gigachatAssistantSecretBridge === bridge) {
        delete window.__gigachatAssistantSecretBridge;
      }
  };
  if (typeof PluginAPI.onUnload === 'function') PluginAPI.onUnload(cleanup);
  else if (typeof plugin !== 'undefined' && typeof plugin.onUnload === 'function') plugin.onUnload(cleanup);
})();
