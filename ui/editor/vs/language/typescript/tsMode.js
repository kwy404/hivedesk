/* hivedesk: stand-in for the TypeScript language service, which is not shipped (about 6 MB).
   JavaScript and TypeScript keep syntax highlighting from basic-languages. */
define("vs/language/typescript/tsMode", ["exports"], function (exports) {
  "use strict";
  var none = function () { return Promise.reject(new Error("The TypeScript language service is not included in hivedesk")); };
  exports.setupTypeScript = function () {};
  exports.setupJavaScript = function () {};
  exports.getTypeScriptWorker = none;
  exports.getJavaScriptWorker = none;
});
