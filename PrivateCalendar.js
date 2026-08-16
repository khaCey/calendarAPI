/**
 * PrivateCalendar.js — configuration and safety helpers for the private calendar API.
 */

function getScriptPropertyString_(name) {
  try {
    if (typeof PropertiesService === 'undefined') return '';
    var value = PropertiesService.getScriptProperties().getProperty(name);
    return value == null ? '' : String(value).trim();
  } catch (err) {
    return '';
  }
}

function getConfiguredString_(propertyName, fallbackValue) {
  var fromProperties = getScriptPropertyString_(propertyName);
  if (fromProperties) return fromProperties;
  return fallbackValue == null ? '' : String(fallbackValue).trim();
}

function getMainCalendarId_() {
  var privateId = getScriptPropertyString_('PRIVATE_CALENDAR_ID');
  if (privateId) return privateId;
  return getConfiguredString_('CALENDAR_ID', CALENDAR_ID) || 'primary';
}

function getOptionalCalendarId_(kind) {
  var normalized = String(kind || '').trim().toLowerCase();
  if (normalized === 'demo') {
    return getConfiguredString_('DEMO_CALENDAR_ID', DEMO_CALENDAR_ID);
  }
  if (normalized === 'owner') {
    return getConfiguredString_('OWNER_CALENDAR_ID', OWNER_CALENDAR_ID);
  }
  return '';
}

/**
 * Demo and owner bookings use the private primary calendar unless a separate
 * calendar is deliberately configured through Script Properties.
 */
function getCalendarIdForKind_(kind) {
  return getOptionalCalendarId_(kind) || getMainCalendarId_();
}

function pushUniqueCalendarDescriptor_(out, seen, id, kind, name) {
  var value = String(id || '').trim();
  if (!value || seen[value]) return;
  seen[value] = true;
  out.push({ id: value, kind: kind, name: name });
}

function getConfiguredCalendarDescriptors_() {
  var out = [];
  var seen = {};
  pushUniqueCalendarDescriptor_(out, seen, getMainCalendarId_(), 'regular', 'private');
  pushUniqueCalendarDescriptor_(out, seen, getOptionalCalendarId_('demo'), 'demo', 'demo');
  pushUniqueCalendarDescriptor_(out, seen, getOptionalCalendarId_('owner'), 'owner', 'owner');
  return out;
}

function getConfiguredCalendarIdsForSearch_(preferredKind) {
  var out = [];
  var seen = {};
  var preferred = getCalendarIdForKind_(preferredKind);

  function add(id) {
    var value = String(id || '').trim();
    if (!value || seen[value]) return;
    seen[value] = true;
    out.push(value);
  }

  add(preferred);
  var descriptors = getConfiguredCalendarDescriptors_();
  for (var i = 0; i < descriptors.length; i++) add(descriptors[i].id);
  return out;
}

function openCalendarByConfiguredId_(calendarId) {
  var id = String(calendarId || '').trim();
  if (!id) return null;
  if (id.toLowerCase() === 'primary') {
    return CalendarApp.getDefaultCalendar();
  }
  return CalendarApp.getCalendarById(id);
}

function getActualCalendarId_(configuredId) {
  var id = String(configuredId || '').trim();
  if (!id) return '';
  if (id.toLowerCase() !== 'primary') return id;
  try {
    var calendar = openCalendarByConfiguredId_(id);
    return calendar && calendar.getId ? String(calendar.getId()) : id;
  } catch (err) {
    return id;
  }
}

function calendarIdsMatch_(left, right) {
  var a = getActualCalendarId_(left);
  var b = getActualCalendarId_(right);
  return !!a && !!b && a === b;
}

function getCalendarKindForOriginalId_(originalCalendarId) {
  var descriptors = getConfiguredCalendarDescriptors_();
  for (var i = 0; i < descriptors.length; i++) {
    if (calendarIdsMatch_(originalCalendarId, descriptors[i].id)) {
      return descriptors[i].kind;
    }
  }
  return 'regular';
}

function getPrivateCalendarTimeZone_() {
  try {
    var calendar = openCalendarByConfiguredId_(getMainCalendarId_());
    if (calendar && calendar.getTimeZone) return String(calendar.getTimeZone());
  } catch (err) {}
  try {
    return String(Session.getScriptTimeZone());
  } catch (sessionErr) {
    return 'Asia/Tokyo';
  }
}
