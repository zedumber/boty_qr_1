// src/routes/health.routes.js

module.exports = function registerHealthRoutes(app, controller) {
  app.get("/health", controller.health);
};
