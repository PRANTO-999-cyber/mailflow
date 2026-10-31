import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

let redisConnection;
let emailQueue;
function ensureQueue() {
  if (!redisConnection) {
    const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    redisConnection = new IORedis(redisUrl,{maxRetriesPerRequest:null,enableReadyCheck:true});
    redisConnection.on('error',err=>console.error('Redis connection:',err.message));
  }
  if (!emailQueue) {
    emailQueue = new Queue('gmail-mailer-delivery',{connection:redisConnection,defaultJobOptions:{attempts:3,backoff:{type:'exponential',delay:5000},removeOnComplete:{age:604800,count:5000},removeOnFail:{age:2592000,count:10000}}});
    // Keep a single recipient delivery active globally, even when multiple worker
    // processes are connected to the same Redis queue. Provider quotas still apply.
    emailQueue.setGlobalConcurrency(1).catch(err => console.error('Could not set global queue concurrency:', err.message));
  }
  return emailQueue;
}
export const addEmailJob = (...args) => ensureQueue().add(...args);
export const addEmailJobsBulk = jobs => ensureQueue().addBulk(jobs);
export const getEmailQueueStats = async () => ensureQueue().getJobCounts('waiting','active','delayed','completed','failed','paused');
export const createEmailWorker = processor => {
  ensureQueue();
  return new Worker('gmail-mailer-delivery',processor,{connection:redisConnection,concurrency:1,limiter:{max:1,duration:1000}});
};

export const closeEmailQueue = async () => { if (emailQueue) await emailQueue.close(); if (redisConnection) await redisConnection.quit(); };
