import { WeekSchedule, LessonSlot, ShiftType, AlarmSettings, DEFAULT_ALARM_SETTINGS } from './types';

export const VOICE_SCRIPTS: Record<string, string> = {
  'ب': "ماموستا حسێنێ بەرێز تە ڤێ دەرسێ پولا دەهێ با یا هەی.",
  'ج': "ماموستا حسێنێ بەرێز تە ڤێ دەرسێ پولا دەهێ جیم یا هەی.",
  'د': "ماموستا حسێنێ بەرێز تە ڤێ دەرسێ پولا دەهێ دال یا هەی.",
  'هـ': "ماموستا حسێنێ بەرێز تە ڤێ دەرسێ پولا دەهێ ها یا هەی.",
  'و': "ماموستا حسێنێ بەرێز تە ڤێ دەرسێ پولا دەهێ واو یا هەی.",
  '10 - ب': "ماموستا حسێنێ بەرێز تە ڤێ دەرسێ پولا دەهێ با یا هەی.",
  '10 - ج': "ماموستا حسێنێ بەرێز تە ڤێ دەرسێ پولا دەهێ جیم یا هەی.",
  '10 - د': "ماموستا حسێنێ بەرێز تە ڤێ دەرسێ پولا دەهێ دال یا هەی.",
  '10 - هـ': "ماموستا حسێنێ بەرێز تە ڤێ دەرسێ پولا دەهێ ها یا هەی.",
  '10 - و': "ماموستا حسێنێ بەرێز تە ڤێ دەرسێ پولا دەهێ واو یا هەی.",
  'end': "ماموستا حسێن 5 خولەک یێت ماین دێ دەرس خلاس بیتن هیڤیدارم دەرسا خو راوەستینە دگەل رێزو سلاڤا ماموستا گیان."
};

/**
 * Calculates slot start/end times based on current settings, shift, and optional exam mode.
 */
export const calculateSlotTimes = (
  shift: ShiftType,
  settings: AlarmSettings
): { start: string; end: string; isExam: boolean }[] => {
  const times: { start: string; end: string; isExam: boolean }[] = [];
  const baseTimeStr = shift === 'morning' ? settings.morningStartTime : settings.eveningStartTime;
  const [baseH, baseM] = (baseTimeStr || (shift === 'morning' ? "08:00" : "13:00")).split(':').map(Number);

  let currentMinutes = (isNaN(baseH) ? 8 : baseH) * 60 + (isNaN(baseM) ? 0 : baseM);
  const count = settings.lessonCount || 6;
  const exam = settings.examSettings;

  for (let lessonIndex = 1; lessonIndex <= count; lessonIndex++) {
    const isExamLesson = Boolean(exam?.enabled && exam.examLessonNumber === lessonIndex);
    
    let lessonDuration: number;
    if (exam?.enabled) {
      lessonDuration = isExamLesson ? exam.examDuration : exam.otherLessonsDuration;
    } else {
      lessonDuration = shift === 'morning' ? settings.morningDuration : settings.eveningDuration;
    }

    const startH = Math.floor(currentMinutes / 60) % 24;
    const startM = currentMinutes % 60;
    const startStr = `${startH.toString().padStart(2, '0')}:${startM.toString().padStart(2, '0')}`;

    currentMinutes += lessonDuration;

    const endH = Math.floor(currentMinutes / 60) % 24;
    const endM = currentMinutes % 60;
    const endStr = `${endH.toString().padStart(2, '0')}:${endM.toString().padStart(2, '0')}`;

    times.push({
      start: startStr,
      end: endStr,
      isExam: isExamLesson
    });

    // Break after lesson
    if (lessonIndex < count) {
      let breakDuration = settings.defaultBreakDuration || 5;
      if (exam?.enabled && isExamLesson) {
        breakDuration = exam.breakAfterExam || 10;
      } else if (lessonIndex === settings.longBreakLesson) {
        breakDuration = settings.longBreakDuration || 10;
      }
      currentMinutes += breakDuration;
    }
  }

  return times;
};

/**
 * Generate slots for a day
 */
export const generateSlotsForDay = (
  shift: ShiftType,
  classesPerLesson: string[],
  settings: AlarmSettings = DEFAULT_ALARM_SETTINGS
): LessonSlot[] => {
  const times = calculateSlotTimes(shift, settings);
  const count = settings.lessonCount || 6;
  const slots: LessonSlot[] = [];

  for (let i = 0; i < count; i++) {
    const timeInfo = times[i] || { start: "08:00", end: "08:40", isExam: false };
    const rawClass = classesPerLesson[i] || 'بێ وانە';
    
    slots.push({
      id: `slot_${shift}_${i}_${Math.random().toString(36).substring(2, 7)}`,
      lessonNumber: i + 1,
      startTime: timeInfo.start,
      endTime: timeInfo.end,
      className: rawClass,
      subject: 'کیمیا',
      isExam: timeInfo.isExam
    });
  }
  return slots;
};

// Extracted exactly from the user's provided official timetable photo
export const INITIAL_SCHEDULE: WeekSchedule = {
  'ئێکشەمبی': { 
    dayName: 'ئێکشەمبی', 
    shift: 'morning', 
    slots: generateSlotsForDay('morning', ['10 - ب', '10 - د', 'بێ وانە', '10 - هـ', 'بێ وانە', '10 - و']) 
  },
  'دووشەمبی': { 
    dayName: 'دووشەمبی', 
    shift: 'morning', 
    slots: generateSlotsForDay('morning', ['10 - ج', 'بێ وانە', '10 - و', 'بێ وانە', '10 - هـ', '10 - ب']) 
  },
  'سێشەمبی': { 
    dayName: 'سێشەمبی', 
    shift: 'morning', 
    slots: generateSlotsForDay('morning', ['10 - د', '10 - ج', 'بێ وانە', '10 - و', 'بێ وانە', '10 - هـ']) 
  },
  'چوارشەمبی': { 
    dayName: 'چوارشەمبی', 
    shift: 'evening', 
    slots: generateSlotsForDay('evening', ['10 - د', 'بێ وانە', 'بێ وانە', '10 - ج', '10 - ب', '10 - هـ']) 
  },
  'پێنچ شەمبی': { 
    dayName: 'پێنچ شەمبی', 
    shift: 'evening', 
    slots: generateSlotsForDay('evening', ['10 - ج', '10 - ب', 'بێ وانە', 'بێ وانە', '10 - و', '10 - د']) 
  },
};
