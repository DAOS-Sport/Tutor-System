import { http } from './client';

export const ragicStatusApi = {
  async get() {
    const r = await http.get('/ragic-status');
    return r.data;
  },
  async sync(job = 'all') {
    const r = await http.post('/ragic-status/sync', { job });
    return r.data;
  },
};
