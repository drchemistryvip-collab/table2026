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
  examLessonNumber: number; // e.g. 1 (starts right after lesson 1)
  examDuration: number;     // e.g. 40 mins
  otherLessonsDuration: number; // fallback e.g. 35
  morningLessonDuration?: number; // 35 mins for morning shift
  eveningLessonDuration?: number; // 30 mins for evening shift
  breakAfterExam: number;   // e.g. 10 mins
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
  morningDuration: number; // Duration for morning shift (e.g. 35 or 40)
  eveningDuration: number; // Duration for evening shift (e.g. 30 or 35)
  morningStartTime: string; // e.g. "08:00"
  eveningStartTime: string; // e.g. "12:30" or "13:00"
  lessonCount: number;      // e.g. 6 or 7
  defaultBreakDuration: number; // e.g. 5 mins
  longBreakLesson: number;  // e.g. 3 (after lesson 3)
  longBreakDuration: number; // e.g. 10 or 15 mins
  allKurdishLettersEnabled?: boolean; // If enabled, includes all Kurdish alphabet letters A-Z for all grades
  customSections?: string[]; // Specific section letters chosen by admin (e.g. ['ئـ', 'ب', 'ج', 'د'])
  customSectionsCount?: number; // How many section letters to activate
  dayShifts?: Record<string, ShiftType>; // Sunday & Monday: evening; Tue, Wed, Thu: morning
  examSettings: ExamSettings;
}

export interface ScheduleChangeRequest {
  id: string;
  teacherId: string;
  teacherName: string;
  subject: string;
  requestedSchedule: WeekSchedule;
  previousSchedule?: WeekSchedule;
  changesSummary: string[];
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  reviewedAt?: string;
  adminNotes?: string;
}

export const DEFAULT_DAY_SHIFTS: Record<string, ShiftType> = {
  'ئێکشەمبی': 'evening', // نیڤڕۆ
  'دووشەمبی': 'evening', // نیڤڕۆ
  'سێشەمبی': 'morning', // سپێدە
  'چوارشەمبی': 'morning', // سپێدە
  'پێنچ شەمبی': 'morning'  // سپێدە
};

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
  morningDuration: 35,
  eveningDuration: 30,
  morningStartTime: "08:00",
  eveningStartTime: "12:30",
  lessonCount: 6,
  defaultBreakDuration: 5,
  longBreakLesson: 3,
  longBreakDuration: 10,
  allKurdishLettersEnabled: false,
  customSections: ['ئـ', 'ب', 'ج', 'د', 'هـ', 'و', 'ز'],
  customSectionsCount: 7,
  dayShifts: { ...DEFAULT_DAY_SHIFTS },
  examSettings: {
    enabled: false,
    examLessonNumber: 1,
    examDuration: 40,
    otherLessonsDuration: 35,
    morningLessonDuration: 35,
    eveningLessonDuration: 30,
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

// Standard Sections up to 'ز' by default
export const STANDARD_SECTIONS = ['ئـ', 'ب', 'ج', 'د', 'هـ', 'و', 'ز'];

// Full Kurdish Alphabet Sections (کاتێک لە ڕێکخستنەکان چالاک دەکرێت)
export const ALL_KURDISH_SECTIONS = [
  'ئـ', 'ا', 'ب', 'پ', 'ت', 'ج', 'چ', 'ح', 'خ', 
  'د', 'ر', 'ڕ', 'ز', 'ژ', 'س', 'ش', 'ص', 'ض', 'ط', 
  'ظ', 'ع', 'غ', 'ف', 'ڤ', 'ق', 'ک', 'گ', 'ل', 'ڵ', 
  'م', 'ن', 'هـ', 'و', 'ۆ', 'ی', 'ێ'
];

// Backward-compatible export: defaults to up to 'ز'
export const SECTIONS = STANDARD_SECTIONS;

// Helper to get active sections based on Kurdish alphabet setting or custom admin selection
export const getActiveSections = (settings?: AlarmSettings | boolean): string[] => {
  if (typeof settings === 'object' && settings !== null) {
    if (Array.isArray(settings.customSections) && settings.customSections.length > 0) {
      return settings.customSections;
    }
    if (settings.allKurdishLettersEnabled) {
      return ALL_KURDISH_SECTIONS;
    }
  } else if (typeof settings === 'boolean' && settings === true) {
    return ALL_KURDISH_SECTIONS;
  }
  return STANDARD_SECTIONS;
};

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

// Generate Classes for Grades 10, 11, 12 up to 'ز' (and support all Kurdish letters)
export const generateClassList = (settings?: AlarmSettings | boolean): string[] => {
  const secs = getActiveSections(settings);
  const list: string[] = ['بێ وانە'];

  // High school Grade 10 (دەهـ)
  secs.forEach(s => list.push(`10 - ${s}`));
  secs.forEach(s => list.push(`پۆلا 10 - ${s}`));

  // High school Grade 11 (یازدە)
  secs.forEach(s => list.push(`11 - ${s}`));
  secs.forEach(s => list.push(`پۆلا 11 - زانستی ${s}`));
  secs.forEach(s => list.push(`پۆلا 11 - وێژەیی ${s}`));

  // High school Grade 12 (دوازدە)
  secs.forEach(s => list.push(`12 - ${s}`));
  secs.forEach(s => list.push(`پۆلا 12 - زانستی ${s}`));
  secs.forEach(s => list.push(`پۆلا 12 - وێژەیی ${s}`));

  // Basic schools 1 to 9
  for (let g = 1; g <= 9; g++) {
    secs.forEach(s => list.push(`پۆلا ${g} - ${s}`));
  }

  // Bare letters
  secs.forEach(s => list.push(s));

  return Array.from(new Set(list));
};

export const CLASSES = generateClassList(false);

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

export interface TeacherTimetableDoc {
  id: string;
  teacherName: string;
  subject: string;
  lessonCountPerDay?: number;
  schedule: WeekSchedule;
  notes?: string;
  updatedAt?: string;
  createdBy?: string;
}

export interface SwapStep {
  stepNumber: number;
  teacherName: string;
  subject: string;
  fromLesson: number;
  toLesson: number;
  className: string;
  actionKurdish: string;
}

export interface SwapSuggestion {
  id: string;
  type: 'direct' | 'chain' | 'multi_chain';
  teacherCount: number;
  dayName: string;
  sourceLessonIndex: number; // 0-indexed
  targetLessonIndex: number; // 0-indexed
  teacherA: string;
  classNameToMove: string;
  partnerTeacher1: string;
  partnerSubject1: string;
  partnerClass1?: string;
  partnerTeacher2?: string;
  partnerSubject2?: string;
  partnerClass2?: string;
  partnerTeacher3?: string;
  partnerSubject3?: string;
  partnerClass3?: string;
  steps: SwapStep[];
  detailsKurdish: string;
}

