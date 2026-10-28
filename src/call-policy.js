export function normalizePhone(value) {
  if (value == null) return '';
  const text = String(value).trim().replace(/[\s()-]/g, '');
  return text.startsWith('00') ? '+' + text.slice(2) : /^\d+$/.test(text) ? '+' + text : text;
}

export function validateCallWindow(now, { timezone = 'Europe/Minsk', startHour = 10, endHour = 18 } = {}) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', hourCycle: 'h23'
  }).format(now));
  return Number.isInteger(startHour) && Number.isInteger(endHour) &&
    startHour >= 0 && endHour <= 24 && startHour < endHour &&
    hour >= startHour && hour < endHour;
}

export function isEligibleDestination(phone, prefixes = []) {
  return /^\+[1-9]\d{7,14}$/.test(phone) && (!prefixes.length || prefixes.some(p => phone.startsWith(p)));
}
