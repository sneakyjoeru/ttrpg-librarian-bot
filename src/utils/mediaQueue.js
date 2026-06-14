class MediaQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
    }

    /**
     * Enqueues a task function to be executed sequentially.
     * @param {Function} taskFn - The async function to execute.
     * @returns {Promise<any>} Resolves or rejects with the result of the task function.
     */
    enqueue(taskFn) {
        return new Promise((resolve, reject) => {
            this.queue.push({ taskFn, resolve, reject });
            this.processNext();
        });
    }

    async processNext() {
        if (this.processing || this.queue.length === 0) return;
        this.processing = true;

        const { taskFn, resolve, reject } = this.queue.shift();
        try {
            console.log(`[MediaQueue] Processing task. Remaining in queue: ${this.queue.length}`);
            const result = await taskFn();
            resolve(result);
        } catch (err) {
            console.error('[MediaQueue] Error executing queued task:', err);
            reject(err);
        } finally {
            this.processing = false;
            // Schedule the next execution on the next tick
            if (typeof setImmediate === 'function') {
                setImmediate(() => this.processNext());
            } else {
                setTimeout(() => this.processNext(), 0);
            }
        }
    }
}

const mediaQueue = new MediaQueue();
module.exports = mediaQueue;
