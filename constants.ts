import { WeekSchedule, LessonSlot, ShiftType, AlarmSettings, DEFAULT_ALARM_SETTINGS } from './types';

export const VOICE_SCRIPTS: Record<string, string> = {
  'universal': "مامۆستایێ هێژا دەرس دەست پێ دکەت - هیڤیدارم بچنە پۆلێ دگەل رێزو سلاڤان.",
  'ب': "مامۆستایێ هێژا تە ڤێ دەرسێ پولا دەهێ با یا هەی.",
  'ج': "مامۆستایێ هێژا تە ڤێ دەرسێ پولا دەهێ جیم یا هەی.",
  'د': "مامۆستایێ هێژا تە ڤێ دەرسێ پولا دەهێ دال یا هەی.",
  'هـ': "مامۆستایێ هێژا تە ڤێ دەرسێ پولا دەهێ ها یا هەی.",
  'و': "مامۆستایێ هێژا تە ڤێ دەرسێ پولا دەهێ واو یا هەی.",
  '10 - ب': "مامۆستایێ هێژا تە ڤێ دەرسێ پولا دەهێ با یا هەی.",
  '10 - ج': "مامۆستایێ هێژا تە ڤێ دەرسێ پولا دەهێ جیم یا هەی.",
  '10 - د': "مامۆستایێ هێژا تە ڤێ دەرسێ پولا دەهێ دال یا هەی.",
  '10 - هـ': "مامۆستایێ هێژا تە ڤێ دەرسێ پولا دەهێ ها یا هەی.",
  '10 - و': "مامۆستایێ هێژا تە ڤێ دەرسێ پولا دەهێ واو یا هەی.",
  'end': "مامۆستایێ هێژا 5 خولەک یێت ماین دێ دەرس خلاس بیتن هیڤیدارم دەرسا خو راوەستینە دگەل رێزو سلاڤان."
};

/**
 * Calculates slot start/end times based on current settings, shift, and exam mode.
 * User requirement:
 * On exam days:
 * - Morning: normal lessons 35 mins. Lesson 1 finishes, immediately followed by Exam (40 mins), then break, then Lesson 2 starts.
 * - Evening: normal lessons 30 mins. Lesson 1 finishes, immediately followed by Exam (40 mins), then break, then Lesson 2 starts.
 */
export const calculateSlotTimes = (
  shift: ShiftType,
  settings: AlarmSettings
): { start: string; end: string; isExam: boolean; lessonLabel?: string }[] => {
  const times: { start: string; end: string; isExam: boolean; lessonLabel?: string }[] = [];
  const baseTimeStr = shift === 'morning' ? settings.morningStartTime : settings.eveningStartTime;
  const [baseH, baseM] = (baseTimeStr || (shift === 'morning' ? "08:00" : "12:30")).split(':').map(Number);

  let currentMinutes = (isNaN(baseH) ? (shift === 'morning' ? 8 : 12) : baseH) * 60 + (isNaN(baseM) ? (shift === 'morning' ? 0 : 30) : baseM);
  const count = settings.lessonCount || 6;
  const exam = settings.examSettings;
  const isExamDay = Boolean(exam?.enabled);

  for (let lessonIndex = 1; lessonIndex <= count; lessonIndex++) {
    // Determine lesson duration
    let lessonDuration: number;
    if (isExamDay) {
      if (shift === 'morning') {
        lessonDuration = exam.morningLessonDuration || 35;
      } else {
        lessonDuration = exam.eveningLessonDuration || 30;
      }
    } else {
      lessonDuration = shift === 'morning' ? (settings.morningDuration || 35) : (settings.eveningDuration || 30);
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
      isExam: false,
      lessonLabel: `وانا ${lessonIndex}`
    });

    // Handle post-lesson intervals:
    // If Exam is enabled and this is the exam insertion point (e.g. after Lesson 1):
    const examTargetLesson = exam?.examLessonNumber || 1;
    if (isExamDay && lessonIndex === examTargetLesson) {
      // Insertion point for Exam slot
      
      const examStartH = Math.floor(currentMinutes / 60) % 24;
      const examStartM = currentMinutes % 60;
      const examStartStr = `${examStartH.toString().padStart(2, '0')}:${examStartM.toString().padStart(2, '0')}`;

      const examMins = exam.examDuration || 40;
      currentMinutes += examMins;

      const examEndH = Math.floor(currentMinutes / 60) % 24;
      const examEndM = currentMinutes % 60;
      const examEndStr = `${examEndH.toString().padStart(2, '0')}:${examEndM.toString().padStart(2, '0')}`;

      times.push({
        start: examStartStr,
        end: examEndStr,
        isExam: true,
        lessonLabel: "ئیمتیحان"
      });

      // Break AFTER exam
      const breakAfterExam = exam.breakAfterExam !== undefined ? exam.breakAfterExam : 10;
      currentMinutes += breakAfterExam;
    } else if (lessonIndex < count) {
      // Normal break between lessons
      let breakDuration = settings.defaultBreakDuration || 5;
      if (lessonIndex === settings.longBreakLesson) {
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
  settings: AlarmSettings = DEFAULT_ALARM_SETTINGS,
  subjectName: string = 'کیمیا'
): LessonSlot[] => {
  const times = calculateSlotTimes(shift, settings);
  const slots: LessonSlot[] = [];
  
  let lessonClassIdx = 0;
  for (let i = 0; i < times.length; i++) {
    const timeInfo = times[i];
    
    let className = 'بێ وانە';
    if (timeInfo.isExam) {
      className = 'ئیمتیحان 📝';
    } else {
      className = classesPerLesson[lessonClassIdx] || 'بێ وانە';
      lessonClassIdx++;
    }
    
    slots.push({
      id: `slot_${shift}_${i}_${Math.random().toString(36).substring(2, 7)}`,
      lessonNumber: i + 1,
      startTime: timeInfo.start,
      endTime: timeInfo.end,
      className: className,
      subject: timeInfo.isExam ? 'ئیمتیحان' : (subjectName || 'کیمیا'),
      isExam: timeInfo.isExam
    });
  }
  return slots;
};


/**
 * Shift Schedule matching the user requirement:
 * - Sunday (ئێکشەمبی) & Monday (دووشەمبی): Evening (نیڤڕۆ)
 * - Tuesday (سێشەمبی), Wednesday (چوارشەمبی), Thursday (پێنچ شەمبی): Morning (سپێدە)
 */
export const INITIAL_SCHEDULE: WeekSchedule = {
  'ئێکشەمبی': { 
    dayName: 'ئێکشەمبی', 
    shift: 'evening', 
    slots: generateSlotsForDay('evening', ['10 - ب', '10 - د', 'بێ وانە', '10 - هـ', 'بێ وانە', '10 - و']) 
  },
  'دووشەمبی': { 
    dayName: 'دووشەمبی', 
    shift: 'evening', 
    slots: generateSlotsForDay('evening', ['10 - ج', 'بێ وانە', '10 - و', 'بێ وانە', '10 - هـ', '10 - ب']) 
  },
  'سێشەمبی': { 
    dayName: 'سێشەمبی', 
    shift: 'morning', 
    slots: generateSlotsForDay('morning', ['10 - د', '10 - ج', 'بێ وانە', '10 - و', 'بێ وانە', '10 - هـ']) 
  },
  'چوارشەمبی': { 
    dayName: 'چوارشەمبی', 
    shift: 'morning', 
    slots: generateSlotsForDay('morning', ['10 - د', 'بێ وانە', 'بێ وانە', '10 - ج', '10 - ب', '10 - هـ']) 
  },
  'پێنچ شەمبی': { 
    dayName: 'پێنچ شەمبی', 
    shift: 'morning', 
    slots: generateSlotsForDay('morning', ['10 - ج', '10 - ب', 'بێ وانە', 'بێ وانە', '10 - و', '10 - د']) 
  },
};
