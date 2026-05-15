import { http } from './client';

export const ragicStatusApi = {
  async get() {
    const r = await http.get('/ragic-status');
    return r.data;
  },
  async sync(form = 'all') {
    const r = await http.post(`/ragic-status/sync?form=${encodeURIComponent(form)}`);
    return r.data;
  },
};
