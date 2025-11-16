class LaravelSync {
  constructor(axios, laravelApi, logger, queueManager) {
    this.axios = axios;
    this.laravelApi = laravelApi;
    this.logger = logger;
    this.queueManager = queueManager;

    this.queue = [];
    this.processing = false;
    this.GLOBAL_INTERVAL = 400; // 1 request cada 400ms
  }

  async sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  enqueue(task) {
    this.queue.push(task);
    this.processQueue();
  }

  async processQueue() {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const task = this.queue.shift();
      try {
        await this.send(task);
      } catch (e) {
        const status = e?.response?.status;
        this.logger.error("❌ Error enviando tarea a Laravel", {
          status,
          type: task.type,
          session: task.session_id
        });
      }
      await this.sleep(this.GLOBAL_INTERVAL);
    }

    this.processing = false;
  }

  async send(task) {
    return await this.queueManager.executeWithCircuitBreaker(() =>
      this.axios.post(`${this.laravelApi}${task.path}`, task.payload)
    );
  }
}

module.exports = LaravelSync;
