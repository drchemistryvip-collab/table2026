export type ShiftType = 'morning' | 'evening';

export interface LessonSlot {
  id: string;
  lessonNumber?: number;
  startTime: string;
  endTime: string;
  className: string; // ب، ج، د، هـ، و یان 10 - ب
  subject: string;   // کیمیا
  isExam?: boolean;
  notificationsEnabled?: boolean;
}

export interface DaySchedule {
  dayName: string;
  shift: ShiftType;
  slots: LessonSlot[];
}

export type WeekSchedule = Record<string, DaySchedule>;

export interface ExamSettings {
  enabled: boolean;
  examLessonNumber: number; // e.g. 2
  examDuration: number;     // e.g. 40
  otherLessonsDuration: number; // e.g. 35
  breakAfterExam: number;   // e.g. 10
}

export interface AlarmSettings {
  minutesBeforeStart: number; // Offset for start of lesson
  minutesBeforeEnd: number;   // Offset for end of lesson
  soundUrl: string;
  triggerOnStart: boolean;
  triggerOnEnd: boolean;
  enabled: boolean;
  repeatCount: number;
  morningDuration: number; // Duration for morning shift (e.g. 40)
  eveningDuration: number; // Duration for evening shift (e.g. 35)
  morningStartTime: string; // e.g. "08:00"
  eveningStartTime: string; // e.g. "13:00"
  lessonCount: number;      // e.g. 6 or 7
  defaultBreakDuration: number; // e.g. 5 mins
  longBreakLesson: number;  // e.g. 3 (after lesson 3)
  longBreakDuration: number; // e.g. 10 or 15 mins
  examSettings: ExamSettings;
}

export const DEFAULT_ALARM_SETTINGS: AlarmSettings = {
  minutesBeforeStart: 2,
  minutesBeforeEnd: 5,
  soundUrl: 'https://assets.mixkit.co/active_storage/sfx/2558/2558-preview.mp3',
  triggerOnStart: true,
  triggerOnEnd: true,
  enabled: true,
  repeatCount: 3,
  morningDuration: 40,
  eveningDuration: 35,
  morningStartTime: "08:00",
  eveningStartTime: "13:00",
  lessonCount: 6,
  defaultBreakDuration: 5,
  longBreakLesson: 3,
  longBreakDuration: 10,
  examSettings: {
    enabled: false,
    examLessonNumber: 2,
    examDuration: 40,
    otherLessonsDuration: 35,
    breakAfterExam: 10
  }
};

export const CLASSES = ['ب', 'ج', 'د', 'هـ', 'و', '10 - ب', '10 - ج', '10 - د', '10 - هـ', '10 - و', 'بێ وانە'];
export const DAYS = ['ئێکشەمبی', 'دووشەمبی', 'سێشەمبی', 'چوارشەمبی', 'پێنچ شەمبی'];

export const THEMES = [
  { id: 'indigo', color: '#4f46e5', label: 'شینێ مۆرانی' },
  { id: 'emerald', color: '#059669', label: 'کەسکێ جەوهەری' },
  { id: 'rose', color: '#e11d48', label: 'سۆرێ گەشبین' },
  { id: 'amber', color: '#d97706', label: 'پرتەقاڵی' },
  { id: 'slate', color: '#475569', label: 'رەشێ سلات' },
];

export const ALARM_SOUNDS = [
  { name: 'جەرەسێ قوتابخانێ', url: 'https://assets.mixkit.co/active_storage/sfx/2558/2558-preview.mp3' },
];
