// src/controllers/metrics.controller.js

module.exports = function createMetricsController(
  batchQueueManager,
  cacheManager,
  logger
) {
  return {
    // GET /metrics/batch
    batch(req, res) {
      try {
        const metrics = batchQueueManager.getMetrics();
        const content = batchQueueManager.getBatchContent();

        res.json({
          success: true,
          metrics,
          content,
        });
      } catch (error) {
        logger.error("❌ Error obteniendo métricas de batch", error);
        res.status(500).json({ success: false, error: error.message });
      }
    },

    // GET /metrics/cache
    async cache(req, res) {
      try {
        const metrics = await cacheManager.getMetrics();

        res.json({
          success: true,
          metrics,
        });
      } catch (error) {
        logger.error("❌ Error obteniendo métricas de cache", error);
        res.status(500).json({ success: false, error: error.message });
      }
    },
  };
};
