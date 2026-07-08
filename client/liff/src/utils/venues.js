export function cleanVenueValue(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  return String(value.id || value.code || value.name || '').trim();
}

export function venueItems(values) {
  if (Array.isArray(values)) return values;
  if (typeof values === 'string') {
    const text = values.trim();
    if (!text) return [];
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return parsed;
      } catch { /* fall through */ }
    }
    return text.split(/[,\n、，;；]+/);
  }
  return values == null ? [] : [values];
}

export function cleanVenueList(values) {
  return Array.from(new Set(venueItems(values)
    .map(cleanVenueValue)
    .filter(Boolean)));
}

export function coachVenueValues(coach) {
  return cleanVenueList(coach?.venue_ids || coach?.venues || []);
}

export function coachMatchesVenue(coach, selectedValues) {
  const venues = coachVenueValues(coach);
  if (!venues.length) return true;
  const selected = cleanVenueList(selectedValues);
  if (!selected.length) return true;
  return venues.some((venue) => selected.some((want) => venue === want || venue.includes(want)));
}
