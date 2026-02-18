/**
 * Functions.js — Shared logic for Calendar Webhook app.
 * Config (SS_ID, CALENDAR_ID, etc.) in Config.js — files are merged into one scope.
 */

function getOrCreateAppStateSheet(ss) {
  let sheet = ss.getSheetByName(APPSTATE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(APPSTATE_SHEET_NAME);
    sheet.getRange(1, 1, 1, 2).setValues([['cacheVersion', 'lastUpdated']]);
    sheet.getRange(2, 1).setValue(0);
  }
  return sheet;
}

function getLessonsTodayFingerprint() {
  const ss = SpreadsheetApp.openById(SS_ID);
  const sheet = ss.getSheetByName('lessons_today');
  if (!sheet) return '';
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return '';
  const rows = data.slice(1);
  const parts = rows
    .map(r => r.map(cell => String(cell ?? '').trim()).join('|'))
    .sort();
  return parts.join(',');
}

function getLessonsTodayStatuses() {
  const SHEET_NAME = 'lessons_today';
  const ss = SpreadsheetApp.openById(SS_ID);
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error(`Sheet "${SHEET_NAME}" not found.`);

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  const headers = data.shift().map(h => h.toString().trim());
  const idxID = headers.indexOf('eventID');
  const idxPDF = headers.indexOf('pdfUpload');
  const idxLH = headers.indexOf('lessonHistory');
  const idxFolder = headers.indexOf('folderName');
  if (idxID < 0 || idxPDF < 0 || idxLH < 0) {
    throw new Error('Missing one of eventID, pdfUpload or lessonHistory headers.');
  }

  return data.map(row => {
    const pdf = String(row[idxPDF]).toLowerCase() === 'true';
    const lh = String(row[idxLH]).toLowerCase() === 'true';
    return {
      eventID: String(row[idxID]),
      pdfUpload: pdf,
      lessonHistory: lh,
      folderName: idxFolder >= 0 ? String(row[idxFolder] || '') : ''
    };
  });
}

function getLessonStatus_(event) {
  var color = event.getColor();
  if (color === '8') return 'cancelled';
  if (color === '9' || color === '5') return 'rescheduled';
  return null;
}

function getLessonLocationStatus_(title) {
  if (/\(\s*Cafe\s*\)/i.test(title)) return 'cafe';
  if (/\(\s*Online\s*\)/i.test(title)) return 'online';
  return 'regular';
}

function changeEventColor(eventID, color) {
  try {
    const calMain = CalendarApp.getCalendarById(CALENDAR_ID);
    const calDemo = CalendarApp.getCalendarById(DEMO_CALENDAR_ID);
    let event = null;

    if (calMain) {
      try { event = calMain.getEventById(eventID); } catch (e) {}
    }
    if (!event && calDemo) {
      try { event = calDemo.getEventById(eventID); } catch (e) {}
    }
    if (!event) {
      const calOwner = CalendarApp.getCalendarById(OWNER_CALENDAR_ID);
      if (calOwner) {
        try { event = calOwner.getEventById(eventID); } catch (e) {}
      }
    }

    if (event) {
      event.setColor(color);
      return { success: true, message: 'Event color updated successfully' };
    } else {
      throw new Error('Event not found in any calendar');
    }
  } catch (error) {
    Logger.log('Error changing event color: ' + error.message);
    return { success: false, message: error.message };
  }
}

/**
 * Fetches all lesson & demo events for today (or a specific date) from calendars,
 * preserves existing pdfUpload and lessonHistory flags, and writes to 'lessons_today'.
 * @param {string=} dateOverride Optional "DD/MM/YYYY" string.
 * @returns {Array<Object>} Array of grouped lesson objects written to sheet.
 */
function fetchAndCacheTodayLessons(dateOverride) {
  Logger.log('--- fetchAndCacheTodayLessons START ---');
  const ss = SpreadsheetApp.openById(SS_ID);
  const tz = Session.getScriptTimeZone();

  let beforeFingerprint = '';
  try { beforeFingerprint = getLessonsTodayFingerprint(); } catch (e) {}

  let penultimateEvalDue = false;
  try {
    const appStateSheet = getOrCreateAppStateSheet(ss);
    const b5 = appStateSheet.getRange(5, 2).getValue();
    penultimateEvalDue = (b5 === true || String(b5).toLowerCase() === 'true');
  } catch (e) {}

  const oldStatusMap = {};
  try {
    const existingStatuses = getLessonsTodayStatuses();
    existingStatuses.forEach(status => {
      oldStatusMap[status.eventID] = {
        pdfUpload: status.pdfUpload,
        lessonHistory: status.lessonHistory,
        folderName: status.folderName
      };
    });
  } catch (err) {}

  let targetDate;
  if (typeof dateOverride === 'string' && dateOverride.includes('/')) {
    const parts = dateOverride.split('/').map(Number);
    targetDate = new Date(parts[2], parts[1] - 1, parts[0]);
  } else if (dateOverride instanceof Date) {
    targetDate = new Date(dateOverride);
  } else {
    targetDate = new Date();
  }
  targetDate.setHours(0, 0, 0, 0);

  const calMain = CalendarApp.getCalendarById(CALENDAR_ID);
  if (!calMain) throw new Error('Calendar not found: ' + CALENDAR_ID);
  const calDemo = CalendarApp.getCalendarById(DEMO_CALENDAR_ID);
  if (!calDemo) throw new Error('Calendar not found: ' + DEMO_CALENDAR_ID);
  const calOwner = CalendarApp.getCalendarById(OWNER_CALENDAR_ID);
  if (!calOwner) throw new Error('Calendar not found: ' + OWNER_CALENDAR_ID);

  const startTime = new Date(targetDate);
  const endTime = new Date(targetDate);
  endTime.setDate(endTime.getDate() + 1);

  const eventsMain = calMain.getEvents(startTime, endTime);
  const eventsDemo = calDemo.getEvents(startTime, endTime);
  const eventsOwner = calOwner.getEvents(startTime, endTime);

  const allEvents = [];
  eventsMain.forEach(e => allEvents.push({ event: e, calendarType: 'main' }));
  eventsDemo.forEach(e => allEvents.push({ event: e, calendarType: 'demo' }));
  eventsOwner.forEach(e => allEvents.push({ event: e, calendarType: 'owner' }));

  const studentMap = {};
  const studentSheet = STUDENTLIST.getSheetByName('Student List');
  if (studentSheet) {
    const studentData = studentSheet.getDataRange().getValues();
    for (let i = 1; i < studentData.length; i++) {
      const name = studentData[i][2];
      const folder = studentData[i][3];
      if (name && folder) studentMap[name] = folder;
    }
  }

  const flat = [];
  allEvents.forEach(({ event, calendarType }) => {
    const title = event.getTitle();
    if (/break/i.test(title) || /teacher/i.test(title)) return;

    const lessonStatus = getLessonStatus_(event);
    const status = lessonStatus !== null ? lessonStatus : getLessonLocationStatus_(title);

    const rawStart = event.getStartTime();
    const rawEnd = event.getEndTime();
    const namePart = title.split('(')[0].replace(/子/g, '');
    const namePartClean = namePart.replace(/\s*D\/L\s*/i, '').trim();
    const names = namePartClean.split(/\s+and\s+/i).map(n => n.trim()).filter(Boolean);
    const cleanNames = names;

    const description = event.getDescription() || '';
    let hasEvaluationReady = description.includes('#evaluationReady');
    let hasEvaluationDue = description.includes('#evaluationDue');
    const fractionMatch = title.match(/(\d+)\s*\/\s*(\d+)/);
    if (penultimateEvalDue && fractionMatch) {
      const x = parseInt(fractionMatch[1], 10);
      const y = parseInt(fractionMatch[2], 10);
      if (y - x === 1) hasEvaluationDue = true;
    }
    const teacherMatch = description.match(/#teacher(\w+)/i);
    const teacher = teacherMatch ? teacherMatch[1] : '';

    if (lessonStatus === null) {
      if (hasEvaluationReady) changeEventColor(event.getId(), 'green');
      else if (hasEvaluationDue) changeEventColor(event.getId(), 'red');
    }

    let sharedLastName = '';
    if (cleanNames.length > 1) {
      const firstStudentParts = cleanNames[0].split(/\s+/);
      if (firstStudentParts.length === 1) {
        for (let i = 1; i < cleanNames.length; i++) {
          const parts = cleanNames[i].split(/\s+/);
          if (parts.length > 1) {
            sharedLastName = parts[parts.length - 1];
            break;
          }
        }
      } else {
        sharedLastName = cleanNames[0].split(/\s+/).pop();
      }
    }

    cleanNames.forEach((nm) => {
      const parts = nm.split(/\s+/);
      const fullName = (parts.length === 1 && sharedLastName) ? (parts[0] + ' ' + sharedLastName) : nm;
      let cleanStudentName = fullName.trim();
      let folderName = studentMap[cleanStudentName] || '';
      if (/D\/L/i.test(title)) folderName = cleanStudentName + ' DEMO';
      const isOnline = /\(\s*(Cafe|Online)\s*\)/i.test(title);
      flat.push({
        eventID: event.getId(),
        eventName: title,
        Start: Utilities.formatDate(rawStart, tz, 'HH:mm'),
        End: Utilities.formatDate(rawEnd, tz, 'HH:mm'),
        studentName: cleanStudentName,
        folderName: folderName,
        pdfUpload: false,
        lessonHistory: false,
        evaluationReady: hasEvaluationReady,
        evaluationDue: hasEvaluationDue,
        isOnline: isOnline,
        status: status,
        teacher: teacher,
        calendarType: calendarType,
      });
    });
  });

  const grouped = {};
  flat.forEach(item => {
    if (!grouped[item.eventID]) {
      grouped[item.eventID] = {
        eventID: item.eventID,
        eventName: item.eventName,
        Start: item.Start,
        End: item.End,
        folderName: item.folderName,
        studentNames: [item.studentName],
        pdfUpload: item.pdfUpload,
        lessonHistory: item.lessonHistory,
        evaluationReady: item.evaluationReady,
        evaluationDue: item.evaluationDue,
        status: item.status,
        teacher: item.teacher,
        calendarType: item.calendarType,
      };
    } else {
      grouped[item.eventID].studentNames.push(item.studentName);
      if (item.evaluationReady) grouped[item.eventID].evaluationReady = true;
      if (item.evaluationDue) grouped[item.eventID].evaluationDue = true;
      if (!grouped[item.eventID].teacher && item.teacher) grouped[item.eventID].teacher = item.teacher;
    }
  });
  const lessons = Object.values(grouped);

  lessons.forEach(lesson => {
    const oldStatus = oldStatusMap[lesson.eventID];
    if (oldStatus) {
      lesson.pdfUpload = oldStatus.pdfUpload;
      lesson.lessonHistory = oldStatus.lessonHistory;
      // Only use old folderName when it has a real folder (converted demo). Else keep new from Student List.
      if (oldStatus.folderName && !oldStatus.folderName.endsWith('DEMO')) {
        lesson.folderName = oldStatus.folderName;
      }
    }
  });

  if (lessons.length === 0) {
    Logger.log('No lessons from calendars, skipping update (preserve existing data)');
    return [];
  }

  let tgt = ss.getSheetByName('lessons_today');
  if (!tgt) {
    tgt = ss.insertSheet('lessons_today');
  } else {
    tgt.clearContents();
  }

  const headers = [
    'eventID', 'eventName', 'Start', 'End',
    'folderName', 'studentNames', 'pdfUpload', 'lessonHistory',
    'evaluationReady', 'evaluationDue', 'isOnline', 'status', 'teacher',
    'calendarType'
  ];
  tgt.getRange(1, 1, 1, headers.length).setValues([headers]);

  if (lessons.length) {
    const out = lessons.map(l => [
      l.eventID, l.eventName, l.Start, l.End,
      l.folderName, l.studentNames.join(', '), l.pdfUpload, l.lessonHistory,
      l.evaluationReady || false, l.evaluationDue || false, l.isOnline || false,
      l.status || 'regular', l.teacher || '', l.calendarType || ''
    ]);
    tgt.getRange(2, 1, out.length, headers.length).setValues(out);
  }

  const afterFingerprint = getLessonsTodayFingerprint();
  if (beforeFingerprint !== afterFingerprint) {
    const appState = getOrCreateAppStateSheet(ss);
    const current = appState.getRange(2, 1).getValue();
    const next = (typeof current === 'number' ? current : 0) + 1;
    appState.getRange(2, 1).setValue(next);
    appState.getRange(2, 2).setValue(new Date().toISOString());
  }

  Logger.log('--- fetchAndCacheTodayLessons END ---');
  return lessons;
}
