// Owner-supplied colors: K 三重商工、B 新北高中、L 三民高中。
// Key by permanent venue ID so filtering or sorting never changes a venue's color.
const COLORS = { K: '#67b7dc', B: '#6794dc', L: '#6771dc' };
export const venueColor = (id) => COLORS[id] || '#e5e7eb';
