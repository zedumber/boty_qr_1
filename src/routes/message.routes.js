// src/routes/message.routes.js

module.exports = function registerMessageRoutes(app, controller) {
  app.post("/send-message", controller.sendFromLaravel);
  app.post("/send", controller.sendQuick);
};
