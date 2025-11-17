// src/routes/session.routes.js

module.exports = function registerSessionRoutes(app, controller) {
  app.post("/start", controller.start);
  app.post("/delete-session", controller.delete);
  app.get("/sessions", controller.list);
  app.get("/session/:sessionId", controller.info);
};
