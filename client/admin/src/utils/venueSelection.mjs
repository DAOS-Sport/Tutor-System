export function openVenues(venues, allowedIds = null) {
  const allowed = Array.isArray(allowedIds) ? new Set(allowedIds.map(String)) : null;
  return (Array.isArray(venues) ? venues : []).filter((venue) => (
    venue?.is_active === true && (!allowed || allowed.has(String(venue.id)))
  ));
}

// 編輯歷史資料時保留目前已關館值供辨識，但 disabled，不能再次選取。
export function editableVenueOptions(venues, currentVenueId, allowedIds = null) {
  const current = String(currentVenueId || '');
  const active = openVenues(venues, allowedIds);
  if (!current || active.some((venue) => String(venue.id) === current)) return active;
  const historical = (Array.isArray(venues) ? venues : []).find((venue) => String(venue?.id) === current);
  if (!historical) {
    return [{ id: current, name: current, _historicalClosed: true }, ...active];
  }
  return [{ ...historical, _historicalClosed: true }, ...active];
}
