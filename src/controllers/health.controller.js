// src/controllers/health.controller.js

module.exports = function createHealthController(
  whatsappService,
  queueManager,
  logger
) {
  return {
    async health(req, res) {
      try {
        const queueStatus = await queueManager.getStatus();
        const sessions = whatsappService.listActiveSessions();

        const health = {
          status: "OK",
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          activeSessions: sessions.length,
          sessions,
          queues: queueStatus,
        };

        res.json(health);
      } catch (error) {
        logger.error("❌ Error en health check", error);
        res.status(500).json({ status: "ERROR", error: error.message });
      }
    },
  };
};
