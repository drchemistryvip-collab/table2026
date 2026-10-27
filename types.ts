export type ShiftType = 'morning' | 'evening';

export interface LessonSlot {
  id: string;
  lessonNumber?: number;
  startTime: string;
  endTime: string;
  className: string; // پۆلا ١ - أ، ١٠ - ب، ١٢ - زانستی
  subject: string;   // کیمیا، بیرکاری، ئینگلێزی، کوردی ...
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
  useUniversalSound?: boolean;  // If true, plays a single bell/voice alert for ALL classes and subjects
  universalScript?: string;     // Universal voice script e.g. "ماموستا حسێنێ بەرێز دەرس دەست پێ دکەت"
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
  useUniversalSound: false,
  universalScript: "ماموستا حسێنێ بەرێز دەرس دەست پێ دکەت - هیڤیدارم بچنە پۆلێ دگەل رێزو سلاڤان",
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

// All Grades 1 to 12
export const GRADES = [
  'پۆلا 1', 'پۆلا 2', 'پۆلا 3', 'پۆلا 4', 'پۆلا 5', 'پۆلا 6',
  'پۆلا 7', 'پۆلا 8', 'پۆلا 9', 'پۆلا 10',
  'پۆلا 11 - زانستی', 'پۆلا 11 - وێژەیی',
  'پۆلا 12 - زانستی', 'پۆلا 12 - وێژەیی'
];

// All Sections / Hubas (هۆبە/پۆل)
export const SECTIONS = ['أ', 'ب', 'ج', 'د', 'هـ', 'و', 'ز', 'ح', 'ط', 'ی', 'ک', 'ل', 'م', 'ن'];

// All Kurdish School Subjects (بابەت)
export const ALL_SUBJECTS = [
  'کیمیا',
  'فیزیا',
  'زیندەوەر',
  'بیرکاری',
  'زانست',
  'کوردی',
  'ئینگلێزی',
  'عەرەبی',
  'پەروەردەیا ئاینی',
  'کۆمپیوتەر / تەکنەلۆجیا',
  'مافێن مرۆڤی',
  'جێنۆساید',
  'وەرزش',
  'هونەر',
  'دەروونناسی',
  'کۆمەڵایەتی',
  'مێژوو',
  'جوگرافیا',
  'ئابووری',
  'فەلسەفە و مەنطق',
  'بێ وانە'
];

export const CLASSES = [
  '10 - ب', '10 - ج', '10 - د', '10 - هـ', '10 - و',
  'پۆلا 1 - أ', 'پۆلا 1 - ب', 'پۆلا 1 - ج',
  'پۆلا 2 - أ', 'پۆلا 2 - ب', 'پۆلا 2 - ج',
  'پۆلا 3 - أ', 'پۆلا 3 - ب', 'پۆلا 3 - ج',
  'پۆلا 4 - أ', 'پۆلا 4 - ب', 'پۆلا 4 - ج',
  'پۆلا 5 - أ', 'پۆلا 5 - ب', 'پۆلا 5 - ج',
  'پۆلا 6 - أ', 'پۆلا 6 - ب', 'پۆلا 6 - ج',
  'پۆلا 7 - أ', 'پۆلا 7 - ب', 'پۆلا 7 - ج',
  'پۆلا 8 - أ', 'پۆلا 8 - ب', 'پۆلا 8 - ج',
  'پۆلا 9 - أ', 'پۆلا 9 - ب', 'پۆلا 9 - ج',
  'پۆلا 10 - أ', 'پۆلا 10 - ب', 'پۆلا 10 - ج', 'پۆلا 10 - د', 'پۆلا 10 - هـ', 'پۆلا 10 - و',
  'پۆلا 11 - زانستی أ', 'پۆلا 11 - زانستی ب', 'پۆلا 11 - وێژەیی أ',
  'پۆلا 12 - زانستی أ', 'پۆلا 12 - زانستی ب', 'پۆلا 12 - وێژەیی أ',
  'ب', 'ج', 'د', 'هـ', 'و',
  'بێ وانە'
];

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
