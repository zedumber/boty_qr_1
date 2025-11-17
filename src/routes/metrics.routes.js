// src/routes/metrics.routes.js

module.exports = function registerMetricsRoutes(app, controller) {
  app.get("/metrics/batch", controller.batch);
  app.get("/metrics/cache", controller.cache);
};
