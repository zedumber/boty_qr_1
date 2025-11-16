class LaravelSync {
  constructor(axios, laravelApi, logger, queueManager) {
    this.axios = axios;
    this.laravelApi = laravelApi;
    this.logger = logger;
    this.queueManager = queueManager;

    // Preferir cola persistente para tareas a Laravel (Bull/Redis)
    // Si queueManager provee `processLaravelTasks`, la configuramos para procesar jobs
    try {
      if (
        this.queueManager &&
        typeof this.queueManager.processLaravelTasks === "function"
      ) {
        this.queueManager.processLaravelTasks((task) => this.send(task));
      }
    } catch (e) {
      this.logger.error("❌ Error configurando procesador de Laravel tasks", e);
    }
  }

  enqueue(task) {
    // Encolar la tarea en la cola persistente para retries y durabilidad
    if (
      this.queueManager &&
      typeof this.queueManager.addLaravelTaskToQueue === "function"
    ) {
      try {
        this.queueManager.addLaravelTaskToQueue(task).catch((e) => {
          const status = e?.response?.status;
          this.logger.error("❌ Error agregando tarea a cola Laravel", {
            status,
            type: task.type,
            session: task.session_id,
            error: e.message,
          });
          // Como fallback ligero, logueamos y dejamos que el worker (si existe) reintente
        });
      } catch (e) {
        const status = e?.response?.status;
        this.logger.error("❌ Error agregando tarea a cola Laravel (sync)", {
          status,
          type: task.type,
          session: task.session_id,
          error: e.message,
        });
      }
    } else {
      // Fallback a intento directo si no hay cola disponible
      (async () => {
        try {
          await this.send(task);
        } catch (e) {
          const status = e?.response?.status;
          this.logger.error("❌ Error enviando tarea a Laravel", {
            status,
            type: task.type,
            session: task.session_id,
            error: e.message,
          });
        }
      })();
    }
  }

  async send(task) {
    return await this.queueManager.executeWithCircuitBreaker(() =>
      this.axios.post(`${this.laravelApi}${task.path}`, task.payload)
    );
  }
}

module.exports = LaravelSync;
